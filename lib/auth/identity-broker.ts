const MAX_RESPONSE_BYTES = 64 * 1024;
const LOCATOR = /^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/;
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const ROLES = new Set(["TenantAdmin", "ProjectOwner", "Auditor"]);
export const SESSION_COOKIE = "__Host-deviludo-session";
export const BROWSER_BINDING_COOKIE = "__Host-deviludo-browser";

type FetchLike = typeof fetch;
export interface BrowserSessionAssertion {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenantName: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly role: "TenantAdmin" | "ProjectOwner" | "Auditor";
  readonly githubUserId: number;
  readonly githubNodeId: string;
  readonly githubLogin: string;
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly sessionBinding: string;
  readonly issuedAt: string;
  readonly signature: string;
}

export class IdentityBrokerClient {
  readonly #origin: URL;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  constructor(options: { readonly endpoint: string; readonly fetch?: FetchLike; readonly timeoutMs?: number }) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") invalid();
    const timeout = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 60_000) invalid();
    this.#origin = endpoint; this.#fetch = options.fetch ?? fetch; this.#timeoutMs = timeout;
  }
  async begin(input: { invitationToken: string; browserBinding: string }): Promise<{ authorizeUrl: string; expiresAt: string }> {
    if (!LOCATOR.test(input.invitationToken) || !RANDOM.test(input.browserBinding)) invalid();
    const body = await this.#call("/v1/auth/github/begin", input, 201);
    exactKeys(body, ["authorizeUrl", "expiresAt"]);
    const authorizeUrl = string(body, "authorizeUrl", 4_096); const url = new URL(authorizeUrl);
    if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize") invalid();
    return Object.freeze({ authorizeUrl, expiresAt: iso(body, "expiresAt") });
  }
  async complete(input: { state: string; code: string; browserBinding: string }): Promise<{
    sessionToken: string; expiresAt: string; returnPath: "/settings/connections"; principal: BrowserSessionAssertion;
  }> {
    if (!LOCATOR.test(input.state) || !input.code || input.code.length > 512 || /[\u0000-\u0020]/.test(input.code) || !RANDOM.test(input.browserBinding)) invalid();
    const body = await this.#call("/v1/auth/github/complete", input, 200);
    exactKeys(body, ["expiresAt", "principal", "returnPath", "sessionToken"]);
    const sessionToken = string(body, "sessionToken", 100); if (!LOCATOR.test(sessionToken)) invalid();
    if (body.returnPath !== "/settings/connections") invalid();
    return Object.freeze({ sessionToken, expiresAt: iso(body, "expiresAt"), returnPath: body.returnPath,
      principal: principal(body.principal, false) });
  }
  async assert(input: { sessionToken: string; browserBinding: string; method: string; pathname: string }): Promise<BrowserSessionAssertion> {
    if (!LOCATOR.test(input.sessionToken) || !RANDOM.test(input.browserBinding) || !/^(?:GET|POST|PUT|PATCH|DELETE)$/.test(input.method.toUpperCase())
      || !input.pathname.startsWith("/api/") || input.pathname.includes("?") || input.pathname.includes("#")) invalid();
    return principal(await this.#call("/v1/sessions/assert", { ...input, method: input.method.toUpperCase() }, 200), true);
  }
  async revoke(input: { sessionToken: string; browserBinding: string }): Promise<void> {
    if (!LOCATOR.test(input.sessionToken) || !RANDOM.test(input.browserBinding)) invalid();
    await this.#call("/v1/sessions/revoke", input, 204);
  }
  async #call(path: string, body: Readonly<Record<string, unknown>>, expectedStatus: number): Promise<Record<string, unknown>> {
    const url = new URL(path, this.#origin); if (url.origin !== this.#origin.origin) invalid();
    let response: Response;
    try { response = await this.#fetch(url, { method: "POST", redirect: "error", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(this.#timeoutMs) }); }
    catch { throw new Error("Identity Broker is unavailable"); }
    if (response.status !== expectedStatus) throw new Error(`Identity Broker rejected the request with status ${response.status}`);
    if (expectedStatus === 204) return {};
    return readObject(response);
  }
}

export function identityBrokerFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): IdentityBrokerClient | null {
  const endpoint = env.DEVILUDO_IDENTITY_BROKER_URL?.trim(); return endpoint ? new IdentityBrokerClient({ endpoint }) : null;
}

export function browserSessionCookies(request: Request): { sessionToken: string; browserBinding: string } {
  const values = parseCookies(request.headers.get("cookie") ?? "");
  const sessionToken = values.get(SESSION_COOKIE); const browserBinding = values.get(BROWSER_BINDING_COOKIE);
  if (!sessionToken || !LOCATOR.test(sessionToken) || !browserBinding || !RANDOM.test(browserBinding)) throw new Error("Browser session cookies are invalid");
  return { sessionToken, browserBinding };
}

export function secureCookie(name: string, value: string, expiresAt: string): string {
  if ((name === SESSION_COOKIE && !LOCATOR.test(value))
    || (name === BROWSER_BINDING_COOKIE && !RANDOM.test(value))
    || (name !== SESSION_COOKIE && name !== BROWSER_BINDING_COOKIE)) invalid();
  const expires = new Date(expiresAt); if (!Number.isFinite(expires.getTime())) invalid();
  return `${name}=${value}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}
export function clearCookie(name: string): string {
  if (name !== SESSION_COOKIE && name !== BROWSER_BINDING_COOKIE) invalid();
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function parseCookies(header: string): Map<string, string> {
  if (header.length > 8_192 || /[\r\n\0]/.test(header)) invalid();
  const result = new Map<string, string>();
  for (const part of header.split(";")) {
    const index = part.indexOf("="); if (index < 1) continue;
    const name = part.slice(0, index).trim(); const value = part.slice(index + 1).trim();
    if (result.has(name)) throw new Error("Duplicate browser session cookie");
    result.set(name, value);
  }
  return result;
}
async function readObject(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? "0"); if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) invalid();
  const text = await response.text(); if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) invalid();
  try { const value: unknown = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
  catch { throw new Error("Identity Broker response is invalid JSON"); }
}
function principal(value: unknown, assertionRequired: boolean): BrowserSessionAssertion {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); const body = value as Record<string, unknown>;
  const keys = ["avatarUrl", "displayName", "githubLogin", "githubNodeId", "githubUserId", "membershipId", "role",
    "tenantId", "tenantName", "tenantSlug", "userId", ...(assertionRequired ? ["issuedAt", "sessionBinding", "signature"] : [])];
  exactKeys(body, keys);
  const githubUserId = body.githubUserId; if (!Number.isSafeInteger(githubUserId) || (githubUserId as number) < 1) invalid();
  const avatar = new URL(string(body, "avatarUrl", 2_048)); if (avatar.protocol !== "https:" || avatar.username || avatar.password) invalid();
  const role = body.role; if (typeof role !== "string" || !ROLES.has(role)) invalid();
  const sessionBinding = assertionRequired ? string(body, "sessionBinding", 100) : "";
  const issuedAt = assertionRequired ? string(body, "issuedAt", 20) : "0";
  const signature = assertionRequired ? string(body, "signature", 100) : "";
  if (assertionRequired && (!RANDOM.test(sessionBinding) || !/^\d{13}$/.test(issuedAt) || !SIGNATURE.test(signature))) invalid();
  return Object.freeze({ tenantId: uuid(body, "tenantId"), tenantSlug: string(body, "tenantSlug", 100), tenantName: string(body, "tenantName", 160),
    userId: uuid(body, "userId"), membershipId: uuid(body, "membershipId"), role: role as BrowserSessionAssertion["role"],
    githubUserId: githubUserId as number, githubNodeId: string(body, "githubNodeId", 256), githubLogin: string(body, "githubLogin", 100),
    displayName: string(body, "displayName", 160), avatarUrl: avatar.href, sessionBinding, issuedAt, signature });
}
function string(body: Record<string, unknown>, name: string, maximum: number): string { const value = body[name]; if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(); return value; }
function uuid(body: Record<string, unknown>, name: string): string { const value = string(body, name, 36); if (!UUID.test(value)) invalid(); return value; }
function iso(body: Record<string, unknown>, name: string): string { const value = string(body, name, 40); if (!Number.isFinite(Date.parse(value))) invalid(); return new Date(value).toISOString(); }
function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void { if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalid(); }
function invalid(): never { throw new Error("Identity Broker contract is invalid"); }
