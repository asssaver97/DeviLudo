import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  GitHubIdentityVerifier,
  IdentityInvitation,
  IdentityLoginIntent,
  IdentityStore,
  OneTimePkceSecretStore,
  PlatformRole,
  PlatformSessionAssertion,
  StoredIdentityPrincipal,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const LOCATOR = /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/;
const BROWSER_BINDING = RANDOM;
const GITHUB_CLIENT_ID = /^(?:Iv1\.[A-Za-z0-9]{16,}|Ov23li[A-Za-z0-9]{10,})$/;
const ALLOWED_ROLES = new Set<PlatformRole>(["TenantAdmin", "ProjectOwner", "Auditor"]);
const MAX_LOGIN_SECONDS = 10 * 60;
const CLAIM_SECONDS = 2 * 60;
const DEFAULT_SESSION_SECONDS = 8 * 60 * 60;

type Clock = () => Date;
type RandomValue = () => string;

export class PlatformIdentityBroker {
  readonly #clientId: string;
  readonly #redirectUri: string;
  readonly #store: IdentityStore;
  readonly #secrets: OneTimePkceSecretStore;
  readonly #github: GitHubIdentityVerifier;
  readonly #sessionHmacKey: Buffer;
  readonly #clock: Clock;
  readonly #random: RandomValue;
  readonly #sessionSeconds: number;

  constructor(options: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly store: IdentityStore;
    readonly secrets: OneTimePkceSecretStore;
    readonly github: GitHubIdentityVerifier;
    readonly sessionHmacKey: Uint8Array;
    readonly sessionSeconds?: number;
    readonly clock?: Clock;
    readonly randomValue?: RandomValue;
  }) {
    if (!GITHUB_CLIENT_ID.test(options.clientId)) invalid("GitHub client ID");
    this.#clientId = options.clientId;
    this.#redirectUri = strictRedirectUri(options.redirectUri);
    if (options.sessionHmacKey.byteLength < 32 || options.sessionHmacKey.byteLength > 64) invalid("session HMAC key");
    const sessionSeconds = options.sessionSeconds ?? DEFAULT_SESSION_SECONDS;
    if (!Number.isSafeInteger(sessionSeconds) || sessionSeconds < 300 || sessionSeconds > 24 * 60 * 60) invalid("session lifetime");
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#github = options.github;
    this.#sessionHmacKey = Buffer.from(options.sessionHmacKey);
    this.#clock = options.clock ?? (() => new Date());
    this.#random = options.randomValue ?? (() => randomBytes(32).toString("base64url"));
    this.#sessionSeconds = sessionSeconds;
  }

  async createInvitation(input: {
    readonly tenantId: string;
    readonly role: PlatformRole;
    readonly expiresAt: string;
    readonly createdBy: string;
  }): Promise<{ readonly invitationToken: string; readonly invitationId: string; readonly expiresAt: string }> {
    requireUuid(input.tenantId, "tenant");
    if (!ALLOWED_ROLES.has(input.role)) invalid("invitation role");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(input.createdBy)) invalid("invitation creator");
    const now = this.#now();
    const expiry = requireFuture(input.expiresAt, now, 30 * 24 * 60 * 60 * 1_000, "invitation expiry");
    const invitationToken = locator(input.tenantId, this.#random());
    const invitation: IdentityInvitation = Object.freeze({
      id: randomUUID(), tenantId: input.tenantId, tokenDigest: digest(invitationToken), role: input.role,
      state: "ACTIVE", loginIntentId: null, claimExpiresAt: null, expiresAt: expiry.toISOString(),
      createdBy: input.createdBy, createdAt: now.toISOString(),
    });
    await this.#store.createInvitation(invitation);
    return Object.freeze({ invitationToken, invitationId: invitation.id, expiresAt: invitation.expiresAt });
  }

  async begin(input: {
    readonly invitationToken: string;
    readonly browserBinding: string;
  }): Promise<{ readonly authorizeUrl: string; readonly expiresAt: string }> {
    const tenantId = tenantFromLocator(input.invitationToken, "invitation");
    requireBinding(input.browserBinding);
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + MAX_LOGIN_SECONDS * 1_000).toISOString();
    const state = locator(tenantId, this.#random());
    const verifier = requireRandom(this.#random(), "PKCE verifier");
    const secretRef = await this.#secrets.put(verifier, expiresAt);
    const intent: IdentityLoginIntent = Object.freeze({
      id: randomUUID(), tenantId, invitationId: randomUUID(), stateDigest: digest(state),
      browserBindingDigest: digest(input.browserBinding), pkceVerifierSecretRef: secretRef,
      status: "PENDING", claimToken: null, claimExpiresAt: null, createdAt: now.toISOString(),
      expiresAt, completedAt: null, failureCode: null,
    });
    try {
      await this.#store.beginLogin({
        tenantId, invitationTokenDigest: digest(input.invitationToken), intent, at: now.toISOString(),
      });
    } catch (error) {
      await this.#secrets.delete(secretRef).catch(() => undefined);
      throw error;
    }
    const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", this.#clientId);
    authorize.searchParams.set("redirect_uri", this.#redirectUri);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("allow_signup", "false");
    authorize.searchParams.set("prompt", "select_account");
    return Object.freeze({ authorizeUrl: authorize.href, expiresAt });
  }

  async complete(input: {
    readonly state: string;
    readonly code: string;
    readonly browserBinding: string;
  }): Promise<{
    readonly sessionToken: string;
    readonly expiresAt: string;
    readonly returnPath: "/settings/connections";
    readonly principal: StoredIdentityPrincipal;
  }> {
    const tenantId = tenantFromLocator(input.state, "OAuth state");
    requireCode(input.code);
    requireBinding(input.browserBinding);
    const now = this.#now();
    const claimToken = randomUUID();
    const intent = await this.#store.claimLogin({
      tenantId, stateDigest: digest(input.state), browserBindingDigest: digest(input.browserBinding), claimToken,
      claimedAt: now.toISOString(), claimExpiresAt: new Date(now.getTime() + CLAIM_SECONDS * 1_000).toISOString(),
    });
    let verifier: string | null = null;
    try {
      verifier = await this.#secrets.take(intent.pkceVerifierSecretRef);
      if (!verifier || !RANDOM.test(verifier)) throw new Error("OAuth PKCE verifier is missing or already used");
      const identity = await this.#github.verify({ code: input.code, codeVerifier: verifier, at: now.toISOString() });
      const sessionToken = locator(tenantId, this.#random());
      const expiresAt = new Date(now.getTime() + this.#sessionSeconds * 1_000).toISOString();
      const principal = await this.#store.completeLogin({
        tenantId, intentId: intent.id, claimToken, identity,
        session: Object.freeze({ id: randomUUID(), tokenDigest: digest(sessionToken),
          browserBindingDigest: digest(input.browserBinding), createdAt: now.toISOString(), expiresAt }),
        completedAt: now.toISOString(),
      });
      return Object.freeze({ sessionToken, expiresAt, returnPath: "/settings/connections", principal });
    } catch (error) {
      await this.#store.failLogin({ tenantId, intentId: intent.id, claimToken,
        failureCode: "GITHUB_IDENTITY_REJECTED", failedAt: now.toISOString() }).catch(() => undefined);
      throw error;
    } finally {
      verifier = null;
    }
  }

  async assertSession(input: {
    readonly sessionToken: string;
    readonly browserBinding: string;
    readonly method: string;
    readonly pathname: string;
  }): Promise<PlatformSessionAssertion> {
    const tenantId = tenantFromLocator(input.sessionToken, "session");
    requireBinding(input.browserBinding);
    const method = requireMethod(input.method);
    const pathname = requirePathname(input.pathname);
    const now = this.#now();
    const principal = await this.#store.resolveSession({ tenantId, tokenDigest: digest(input.sessionToken),
      browserBindingDigest: digest(input.browserBinding), at: now.toISOString() });
    const sessionBinding = digestBase64Url(`deviludo.session-binding.v1\n${input.sessionToken}`);
    const issuedAt = String(now.getTime());
    const signature = createHmac("sha256", this.#sessionHmacKey).update(sessionCanonical(method, pathname, {
      tenantId: principal.tenantId, userId: principal.userId, githubUserId: String(principal.githubUserId),
      sessionBinding, issuedAt,
    })).digest("base64url");
    return Object.freeze({ ...principal, sessionBinding, issuedAt, signature });
  }

  async revokeSession(input: { readonly sessionToken: string; readonly browserBinding: string }): Promise<boolean> {
    const tenantId = tenantFromLocator(input.sessionToken, "session");
    requireBinding(input.browserBinding);
    return this.#store.revokeSession({ tenantId, tokenDigest: digest(input.sessionToken),
      browserBindingDigest: digest(input.browserBinding), revokedAt: this.#now().toISOString() });
  }

  #now(): Date {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) invalid("clock");
    return now;
  }
}

function strictRedirectUri(value: string): string {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.search || url.hash
    || url.pathname !== "/api/auth/github/callback") invalid("GitHub redirect URI");
  return url.href;
}
function tenantFromLocator(value: string, label: string): string {
  const match = LOCATOR.exec(value);
  if (!match || !UUID.test(match[1]!)) invalid(label);
  return match[1]!;
}
function locator(tenantId: string, value: string): string { requireUuid(tenantId, "tenant"); return `${tenantId}.${requireRandom(value, "random value")}`; }
function requireRandom(value: string, label: string): string { if (!RANDOM.test(value)) invalid(label); return value; }
function requireBinding(value: string): void { if (!BROWSER_BINDING.test(value)) invalid("browser binding"); }
function requireCode(value: string): void { if (!value || value.length > 512 || /[\u0000-\u0020]/.test(value)) invalid("OAuth code"); }
function requireUuid(value: string, label: string): void { if (!UUID.test(value)) invalid(label); }
function requireFuture(value: string, now: Date, maximumMs: number, label: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()) || result.getTime() <= now.getTime() || result.getTime() - now.getTime() > maximumMs) invalid(label);
  return result;
}
function requireMethod(value: string): string { const method = value.toUpperCase(); if (!/^(?:GET|POST|PUT|PATCH|DELETE)$/.test(method)) invalid("request method"); return method; }
function requirePathname(value: string): string {
  if (!value.startsWith("/api/") || value.length > 1_024 || value.includes("?") || value.includes("#") || /[\u0000-\u001f\\]/.test(value)) invalid("request path");
  return value;
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function digestBase64Url(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function sessionCanonical(method: string, pathname: string, input: { tenantId: string; userId: string; githubUserId: string; sessionBinding: string; issuedAt: string }): string {
  return ["deviludo.session.v1", input.issuedAt, method, pathname, input.tenantId, input.userId, input.githubUserId, input.sessionBinding].join("\n");
}
function invalid(label: string): never { throw new Error(`Platform identity ${label} is invalid`); }
