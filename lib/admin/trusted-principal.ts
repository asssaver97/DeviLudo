const PLATFORM_ROLES = new Set(["PlatformAgentAdmin", "SecurityAdmin", "Auditor"]);
const INVITATION_ROLES = new Set(["PlatformAgentAdmin", "SecurityAdmin"]);
const SAFE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const ADMIN_PATH = /^\/api\/admin\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,1023}$/;
const ADMIN_SESSION_PATH = "/api/auth/session";

export interface TrustedAdminPrincipal {
  readonly role: "PlatformAgentAdmin" | "SecurityAdmin" | "Auditor";
  readonly actorId: string;
  readonly sessionId: string;
  readonly tenantId: null;
  readonly projectId: null;
}

/** Verifies the same route-bound assertion consumed by the Nest admin API. */
export async function verifyTrustedAdminPrincipal(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): Promise<TrustedAdminPrincipal> {
  const url = new URL(request.url);
  if (url.search || !ADMIN_PATH.test(url.pathname) || url.pathname.includes("..") || url.pathname.includes("//")) invalid();
  return verifyTrustedAdminAssertion(request, env, now, url.pathname);
}

/** Projects a trusted platform administrator into the browser shell on one exact read-only route. */
export async function verifyTrustedAdminBrowserSession(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): Promise<TrustedAdminPrincipal> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.search || url.pathname !== ADMIN_SESSION_PATH) invalid();
  return verifyTrustedAdminAssertion(request, env, now, ADMIN_SESSION_PATH);
}

async function verifyTrustedAdminAssertion(
  request: Request,
  env: Readonly<Record<string, string | undefined>>,
  now: Date,
  pathname: string,
): Promise<TrustedAdminPrincipal> {
  const role = header(request, "x-deviludo-role");
  const actorId = header(request, "x-deviludo-actor");
  const sessionId = header(request, "x-deviludo-admin-session");
  const issuedAt = header(request, "x-deviludo-admin-issued-at");
  const signature = header(request, "x-deviludo-admin-signature");
  if (!PLATFORM_ROLES.has(role) || !SAFE_SUBJECT.test(actorId) || !SAFE_SUBJECT.test(sessionId)
    || request.headers.has("x-deviludo-tenant-id") || request.headers.has("x-deviludo-project-id")
    || !SIGNATURE.test(signature)) invalid();
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(issuedAtMs)
    || issuedAtMs < now.getTime() - 5 * 60_000 || issuedAtMs > now.getTime() + 30_000) invalid();
  const encoded = env.DEVILUDO_ADMIN_SESSION_HMAC_KEY?.trim();
  if (!encoded) throw new Error("Administrator authentication is unavailable");
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength < 32 || key.byteLength > 64) throw new Error("Administrator authentication is unavailable");
  const canonical = ["deviludo.admin-principal.v1", request.method.toUpperCase(), pathname,
    actorId, role, "", "", sessionId, issuedAt].join("\n");
  const cryptoKey = await crypto.subtle.importKey("raw", arrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", cryptoKey, arrayBuffer(Buffer.from(signature, "base64url")), new TextEncoder().encode(canonical))) invalid();
  return Object.freeze({ role: role as TrustedAdminPrincipal["role"], actorId, sessionId, tenantId: null, projectId: null });
}

export async function verifyTrustedPlatformAdmin(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): Promise<TrustedAdminPrincipal & { readonly role: "PlatformAgentAdmin" | "SecurityAdmin" }> {
  if (new URL(request.url).pathname !== "/api/admin/invitations") invalid();
  const principal = await verifyTrustedAdminPrincipal(request, env, now);
  if (!INVITATION_ROLES.has(principal.role)) invalid();
  return principal as TrustedAdminPrincipal & { readonly role: "PlatformAgentAdmin" | "SecurityAdmin" };
}

export function requireInvitationTenant(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invitation tenant is invalid");
  return value;
}
function header(request: Request, name: string): string { const value = request.headers.get(name); if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) invalid(); return value; }
function arrayBuffer(value: Uint8Array): ArrayBuffer { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer; }
function invalid(): never { throw new Error("Administrator session assertion is invalid"); }
