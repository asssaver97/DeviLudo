import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  GitHubAuthorizationIntent,
  GitHubAuthorizationPrincipal,
  GitHubAuthorizationSecretStore,
  GitHubAuthorizationStage,
  GitHubAuthorizationStore,
  GitHubUserAuthorizationVerifier,
  GitHubVerifiedInstallation,
} from "./github-auth-contracts";

const STATE_LIFETIME_MS = 10 * 60_000;
const CLAIM_LIFETIME_MS = 2 * 60_000;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const CLIENT_ID = /^(?:Iv1\.[A-Za-z0-9]{16,}|Ov23li[A-Za-z0-9]{10,})$/;
const NUMERIC_ID = /^\d{1,20}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9_-]{43}$/;

export class GitHubInstallationAuthorizationBroker {
  readonly #appSlug: string;
  readonly #clientId: string;
  readonly #redirectUri: string;
  readonly #store: GitHubAuthorizationStore;
  readonly #secrets: GitHubAuthorizationSecretStore;
  readonly #verifier: GitHubUserAuthorizationVerifier;
  readonly #now: () => Date;

  constructor(options: {
    readonly appSlug: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly store: GitHubAuthorizationStore;
    readonly secrets: GitHubAuthorizationSecretStore;
    readonly verifier: GitHubUserAuthorizationVerifier;
    readonly now?: () => Date;
  }) {
    if (!APP_SLUG.test(options.appSlug)) throw new Error("GitHub App slug is invalid");
    if (!CLIENT_ID.test(options.clientId)) throw new Error("GitHub App client ID is invalid");
    this.#appSlug = options.appSlug;
    this.#clientId = options.clientId;
    this.#redirectUri = validateRedirectUri(options.redirectUri).href;
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#verifier = options.verifier;
    this.#now = options.now ?? (() => new Date());
  }

  async begin(principal: GitHubAuthorizationPrincipal, returnPath = "/settings/connections"): Promise<{
    readonly authorizeUrl: string;
    readonly expiresAt: string;
  }> {
    validatePrincipal(principal);
    const normalizedReturnPath = validateReturnPath(returnPath);
    const state = randomToken();
    const createdAt = this.#now().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + STATE_LIFETIME_MS).toISOString();
    await this.#store.create(createIntent({
      state,
      principal,
      stage: "INSTALL",
      installationId: null,
      pkceVerifierSecretRef: null,
      returnPath: normalizedReturnPath,
      createdAt,
      expiresAt,
    }));
    const authorizeUrl = new URL(`https://github.com/apps/${this.#appSlug}/installations/new`);
    authorizeUrl.searchParams.set("state", state);
    return Object.freeze({ authorizeUrl: authorizeUrl.href, expiresAt });
  }

  async beginUserAuthorization(input: {
    readonly principal: GitHubAuthorizationPrincipal;
    readonly state: string;
    readonly installationId: string;
    readonly setupAction: "install" | "update";
  }): Promise<{ readonly authorizeUrl: string; readonly expiresAt: string }> {
    validatePrincipal(input.principal);
    validateState(input.state);
    validateInstallationId(input.installationId);
    if (input.setupAction !== "install" && input.setupAction !== "update") throw new Error("GitHub setup action is invalid");
    const claimedAt = this.#now().toISOString();
    const claimToken = randomUUID();
    const installIntent = await this.#store.claim({
      stateDigest: sha256(input.state),
      stage: "INSTALL",
      tenantId: input.principal.tenantId,
      userId: input.principal.userId,
      sessionBindingDigest: sha256(input.principal.sessionBinding),
      claimToken,
      claimedAt,
      claimExpiresAt: new Date(Date.parse(claimedAt) + CLAIM_LIFETIME_MS).toISOString(),
    });

    const oauthState = randomToken();
    const codeVerifier = randomToken();
    const expiresAt = new Date(Date.parse(claimedAt) + STATE_LIFETIME_MS).toISOString();
    let secretRef: string | null = null;
    try {
      secretRef = await this.#secrets.put(codeVerifier, expiresAt);
      validateSecretRef(secretRef);
      const oauthIntent = createIntent({
        state: oauthState,
        principal: input.principal,
        stage: "OAUTH",
        installationId: input.installationId,
        pkceVerifierSecretRef: secretRef,
        returnPath: installIntent.returnPath,
        createdAt: claimedAt,
        expiresAt,
      });
      await this.#store.completeSetup({ intentId: installIntent.id, claimToken, oauthIntent, completedAt: claimedAt });
    } catch (error) {
      if (secretRef) await this.#secrets.delete(secretRef).catch(() => undefined);
      await this.#store.fail({ tenantId: installIntent.tenantId, intentId: installIntent.id, claimToken, failureCode: "SETUP_TRANSITION_FAILED", failedAt: claimedAt }).catch(() => undefined);
      throw error;
    }

    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", this.#clientId);
    authorizeUrl.searchParams.set("redirect_uri", this.#redirectUri);
    authorizeUrl.searchParams.set("state", oauthState);
    authorizeUrl.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    return Object.freeze({ authorizeUrl: authorizeUrl.href, expiresAt });
  }

  async completeUserAuthorization(input: {
    readonly principal: GitHubAuthorizationPrincipal;
    readonly state: string;
    readonly code: string;
  }): Promise<{ readonly installation: GitHubVerifiedInstallation; readonly returnPath: string }> {
    validatePrincipal(input.principal);
    validateState(input.state);
    validateCode(input.code);
    const claimedAt = this.#now().toISOString();
    const claimToken = randomUUID();
    const intent = await this.#store.claim({
      stateDigest: sha256(input.state),
      stage: "OAUTH",
      tenantId: input.principal.tenantId,
      userId: input.principal.userId,
      sessionBindingDigest: sha256(input.principal.sessionBinding),
      claimToken,
      claimedAt,
      claimExpiresAt: new Date(Date.parse(claimedAt) + CLAIM_LIFETIME_MS).toISOString(),
    });
    if (!intent.pkceVerifierSecretRef || !intent.installationId) {
      await this.#store.fail({ tenantId: intent.tenantId, intentId: intent.id, claimToken, failureCode: "OAUTH_INTENT_INVALID", failedAt: claimedAt }).catch(() => undefined);
      throw new Error("GitHub authorization intent is incomplete");
    }

    const codeVerifier = await this.#secrets.take(intent.pkceVerifierSecretRef);
    if (!codeVerifier || !PKCE_VERIFIER.test(codeVerifier)) {
      await this.#store.fail({ tenantId: intent.tenantId, intentId: intent.id, claimToken, failureCode: "PKCE_SECRET_UNAVAILABLE", failedAt: claimedAt }).catch(() => undefined);
      throw new Error("GitHub authorization verifier is unavailable");
    }

    try {
      const installation = await this.#verifier.verify({
        code: input.code,
        codeVerifier,
        installationId: intent.installationId,
        expectedGithubUserId: input.principal.expectedGithubUserId,
        at: claimedAt,
      });
      validateVerifiedInstallation(installation, intent.installationId, input.principal.expectedGithubUserId, this.#appSlug);
      await this.#store.completeOAuth({ tenantId: intent.tenantId, intentId: intent.id, claimToken, installation, completedAt: claimedAt });
      return Object.freeze({ installation, returnPath: intent.returnPath });
    } catch (error) {
      await this.#store.fail({ tenantId: intent.tenantId, intentId: intent.id, claimToken, failureCode: "GITHUB_IDENTITY_VERIFICATION_FAILED", failedAt: claimedAt }).catch(() => undefined);
      throw error;
    }
  }
}

export class InMemoryGitHubAuthorizationStore implements GitHubAuthorizationStore {
  readonly intents = new Map<string, GitHubAuthorizationIntent>();
  readonly installations = new Map<string, GitHubVerifiedInstallation>();

  async create(intent: GitHubAuthorizationIntent): Promise<void> {
    if (this.intents.has(intent.stateDigest)) throw new Error("GitHub authorization state collision");
    this.intents.set(intent.stateDigest, Object.freeze({ ...intent }));
  }

  async claim(input: Parameters<GitHubAuthorizationStore["claim"]>[0]): Promise<GitHubAuthorizationIntent> {
    const intent = this.intents.get(input.stateDigest);
    if (!intent || intent.stage !== input.stage || intent.tenantId !== input.tenantId || intent.userId !== input.userId
      || intent.sessionBindingDigest !== input.sessionBindingDigest) throw new Error("GitHub authorization state is invalid");
    if (intent.status !== "PENDING" || Date.parse(intent.expiresAt) <= Date.parse(input.claimedAt)) {
      throw new Error("GitHub authorization state is expired or already used");
    }
    const claimed = Object.freeze({ ...intent, status: "CLAIMED" as const, claimToken: input.claimToken, claimExpiresAt: input.claimExpiresAt });
    this.intents.set(input.stateDigest, claimed);
    return claimed;
  }

  async completeSetup(input: Parameters<GitHubAuthorizationStore["completeSetup"]>[0]): Promise<void> {
    const current = this.#claimed(input.intentId, input.claimToken);
    if (this.intents.has(input.oauthIntent.stateDigest)) throw new Error("GitHub authorization state collision");
    this.intents.set(input.oauthIntent.stateDigest, Object.freeze({ ...input.oauthIntent }));
    this.#replace(current.stateDigest, { ...current, status: "COMPLETED", completedAt: input.completedAt });
  }

  async completeOAuth(input: Parameters<GitHubAuthorizationStore["completeOAuth"]>[0]): Promise<void> {
    const current = this.#claimed(input.intentId, input.claimToken);
    if (current.tenantId !== input.tenantId) throw new Error("GitHub authorization tenant binding mismatch");
    this.installations.set(`${current.tenantId}:${input.installation.installationId}`, Object.freeze({ ...input.installation }));
    this.#replace(current.stateDigest, { ...current, status: "COMPLETED", completedAt: input.completedAt });
  }

  async fail(input: Parameters<GitHubAuthorizationStore["fail"]>[0]): Promise<void> {
    const current = [...this.intents.values()].find((intent) => intent.id === input.intentId);
    if (!current || current.tenantId !== input.tenantId || current.claimToken !== input.claimToken || current.status !== "CLAIMED") return;
    this.#replace(current.stateDigest, { ...current, status: "FAILED", failureCode: input.failureCode, completedAt: input.failedAt });
  }

  #claimed(intentId: string, claimToken: string): GitHubAuthorizationIntent {
    const current = [...this.intents.values()].find((intent) => intent.id === intentId);
    if (!current || current.status !== "CLAIMED" || current.claimToken !== claimToken) throw new Error("GitHub authorization claim was lost");
    return current;
  }

  #replace(stateDigest: string, intent: GitHubAuthorizationIntent): void {
    this.intents.set(stateDigest, Object.freeze(intent));
  }
}

export class InMemoryGitHubAuthorizationSecretStore implements GitHubAuthorizationSecretStore {
  readonly #values = new Map<string, { value: string; expiresAt: string }>();

  async put(value: string, expiresAt: string): Promise<string> {
    if (!PKCE_VERIFIER.test(value) || !Number.isFinite(Date.parse(expiresAt))) throw new Error("GitHub PKCE secret is invalid");
    const ref = `vault://transit/github-auth/${randomUUID()}`;
    this.#values.set(ref, { value, expiresAt });
    return ref;
  }

  async take(secretRef: string): Promise<string | null> {
    const stored = this.#values.get(secretRef);
    this.#values.delete(secretRef);
    if (!stored || Date.parse(stored.expiresAt) <= Date.now()) return null;
    return stored.value;
  }

  async delete(secretRef: string): Promise<void> {
    this.#values.delete(secretRef);
  }
}

function createIntent(input: {
  state: string;
  principal: GitHubAuthorizationPrincipal;
  stage: GitHubAuthorizationStage;
  installationId: string | null;
  pkceVerifierSecretRef: string | null;
  returnPath: string;
  createdAt: string;
  expiresAt: string;
}): GitHubAuthorizationIntent {
  return Object.freeze({
    id: randomUUID(),
    stateDigest: sha256(input.state),
    tenantId: input.principal.tenantId,
    userId: input.principal.userId,
    sessionBindingDigest: sha256(input.principal.sessionBinding),
    stage: input.stage,
    installationId: input.installationId,
    pkceVerifierSecretRef: input.pkceVerifierSecretRef,
    returnPath: input.returnPath,
    status: "PENDING",
    claimToken: null,
    claimExpiresAt: null,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    completedAt: null,
    failureCode: null,
  });
}

function validatePrincipal(principal: GitHubAuthorizationPrincipal): void {
  if (!OPAQUE_ID.test(principal.tenantId) || !OPAQUE_ID.test(principal.userId)) throw new Error("GitHub authorization principal is invalid");
  if (principal.sessionBinding.length < 32 || principal.sessionBinding.length > 512 || /[\u0000-\u001f]/.test(principal.sessionBinding)) {
    throw new Error("GitHub authorization session binding is invalid");
  }
  if (!Number.isSafeInteger(principal.expectedGithubUserId) || principal.expectedGithubUserId <= 0) {
    throw new Error("GitHub authorization subject is invalid");
  }
}

function validateState(value: string): void {
  if (!STATE.test(value)) throw new Error("GitHub authorization state is invalid");
}

function validateCode(value: string): void {
  if (!value || value.length > 512 || /[\u0000-\u0020]/.test(value)) throw new Error("GitHub authorization code is invalid");
}

function validateInstallationId(value: string): void {
  if (!NUMERIC_ID.test(value) || value === "0") throw new Error("GitHub installation ID is invalid");
}

function validateSecretRef(value: string): void {
  if (!/^vault:\/\/[A-Za-z0-9._~:/-]{1,500}$/.test(value)) throw new Error("GitHub authorization SecretRef is invalid");
}

function validateReturnPath(value: string): string {
  if (value === "/settings/connections") return value;
  if (/^\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/settings\/connections$/.test(value)) return value;
  throw new Error("GitHub authorization return path is invalid");
}

function validateRedirectUri(value: string): URL {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash
    || url.pathname !== "/api/connections/github/callback") throw new Error("GitHub OAuth redirect URI is invalid");
  return url;
}

function validateVerifiedInstallation(value: GitHubVerifiedInstallation, installationId: string, userId: number, appSlug: string): void {
  if (value.installationId !== installationId || value.githubUserId !== userId || value.appSlug !== appSlug
    || !value.accountNodeId || !value.accountLogin || !value.githubUserNodeId || !value.githubUserLogin
    || (value.repositorySelection !== "all" && value.repositorySelection !== "selected")
    || value.permissions.contents !== "write" || value.permissions.pull_requests !== "write" || value.permissions.metadata !== "read") {
    throw new Error("GitHub verified installation does not satisfy its immutable binding");
  }
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
