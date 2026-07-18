const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RESPONSE_SECRET_FIELD = /^(?:apiKey|secret|secretRef|password|authorization|accessToken|refreshToken)$/i;

type FetchLike = typeof fetch;

export interface ControlPlaneAdminPrincipal {
  readonly role: "PlatformAgentAdmin" | "SecurityAdmin" | "TenantAdmin" | "ProjectOwner" | "Auditor";
  readonly actorId: string;
  readonly sessionId: string;
  readonly tenantId: string | null;
  readonly projectId: string | null;
}

export class AdminControlPlaneBrokerClient {
  readonly #origin: URL;
  readonly #key: Uint8Array;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly endpoint: string;
    readonly hmacKey: Uint8Array;
    readonly fetch?: FetchLike;
    readonly timeoutMs?: number;
  }) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search
      || endpoint.hash || endpoint.pathname !== "/") invalid("endpoint");
    if (options.hmacKey.byteLength < 32 || options.hmacKey.byteLength > 64) invalid("HMAC key");
    const timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) invalid("timeout");
    this.#origin = endpoint;
    this.#key = new Uint8Array(options.hmacKey);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = timeoutMs;
  }

  async forward(
    request: Request,
    downstreamPath: string,
    principal: ControlPlaneAdminPrincipal,
    now = new Date(),
  ): Promise<Response> {
    if (!/^\/admin\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,1023}$/.test(downstreamPath)
      || downstreamPath.includes("..") || downstreamPath.includes("//")) invalid("route");
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "POST" && method !== "PUT") invalid("method");
    if (!Number.isFinite(now.getTime())) invalid("clock");
    const url = new URL(downstreamPath, this.#origin);
    if (url.origin !== this.#origin.origin || url.search || url.hash) invalid("route");
    const issuedAt = now.toISOString();
    assertPrincipalScope(principal);
    const canonical = ["deviludo.admin-principal.v1", method, downstreamPath, principal.actorId,
      principal.role, principal.tenantId ?? "", principal.projectId ?? "", principal.sessionId, issuedAt].join("\n");
    const signature = await sign(canonical, this.#key);
    const headers = new Headers({
      accept: "application/json",
      "x-deviludo-role": principal.role,
      "x-deviludo-actor": principal.actorId,
      "x-deviludo-admin-session": principal.sessionId,
      "x-deviludo-admin-issued-at": issuedAt,
      "x-deviludo-admin-signature": signature,
      "x-request-id": crypto.randomUUID(),
    });
    if (principal.tenantId) headers.set("x-deviludo-tenant-id", principal.tenantId);
    if (principal.projectId) headers.set("x-deviludo-project-id", principal.projectId);

    let body: ArrayBuffer | undefined;
    let sensitiveValues: readonly string[] = [];
    if (method !== "GET") {
      const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) invalid("content type");
      const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) invalid("idempotency key");
      headers.set("content-type", "application/json");
      headers.set("idempotency-key", idempotencyKey);
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_REQUEST_BYTES) invalid("request size");
      sensitiveValues = requestSecrets(body);
    }

    let upstream: Response;
    try {
      upstream = await this.#fetch(url, {
        method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new Error("Administrator control plane is unavailable");
    }
    const declared = Number(upstream.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) invalid("response size");
    const responseBytes = await upstream.arrayBuffer();
    if (responseBytes.byteLength > MAX_RESPONSE_BYTES) invalid("response size");
    const responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
    const payload = parseObject(responseText);
    assertPublicResponse(payload);
    if (sensitiveValues.some((value) => responseText.includes(value))) {
      throw new Error("Administrator control plane returned credential plaintext");
    }
    const responseHeaders = new Headers({
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-deviludo-effective-role": principal.role,
      "x-deviludo-admin-auth-mode": "trusted-control-plane",
    });
    const replayed = upstream.headers.get("idempotent-replayed");
    const retryAfter = upstream.headers.get("retry-after");
    if (replayed === "true") responseHeaders.set("idempotent-replayed", "true");
    if (retryAfter && /^\d{1,5}$/.test(retryAfter)) responseHeaders.set("retry-after", retryAfter);
    return new Response(responseText, { status: upstream.status, headers: responseHeaders });
  }
}

export function adminControlPlaneBrokerFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdminControlPlaneBrokerClient | null {
  const endpoint = env.DEVILUDO_ADMIN_CONTROL_PLANE_BROKER_URL?.trim();
  if (!endpoint) return null;
  const encoded = env.DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY?.trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalid("environment HMAC key");
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength < 32 || key.byteLength > 64) invalid("environment HMAC key");
  return new AdminControlPlaneBrokerClient({ endpoint, hmacKey: key });
}

export function resolveAdminControlPlanePath(methodInput: string, segments: readonly string[]): string {
  const method = methodInput.toUpperCase();
  if (!segments.length || segments.some((segment) => !SAFE_SEGMENT.test(segment))) invalid("route");
  const key = segments.join("/");
  const exact = method === "GET"
    ? new Set(["agents", "agent-health", "audit"])
    : method === "POST"
      ? new Set(["agent-versions/discover", "agent-versions/approve", "agent-versions/block", "agent-installations", "agent-profiles", "credentials"])
      : new Set<string>();
  const dynamic = method === "GET"
    ? /^inference-runs\/([a-f0-9-]+)\/([a-f0-9-]+)\/reconciliation$/i.test(key)
      && UUID.test(segments[1] ?? "") && UUID.test(segments[2] ?? "")
    : method === "POST"
      ? /^agent-rollouts\/[A-Za-z0-9][A-Za-z0-9._:-]{0,179}\/(?:advance|rollback)$/.test(key)
        || /^agent-profiles\/[A-Za-z0-9][A-Za-z0-9._:-]{0,179}\/(?:validate|activate|disable)$/.test(key)
        || /^credentials\/[A-Za-z0-9][A-Za-z0-9._:-]{0,179}\/(?:rotate|revoke)$/.test(key)
        || /^inference-requests\/[a-f0-9-]{36}\/reconcile$/i.test(key)
      : method === "PUT" && /^agent-defaults\/(?:platform|(?:tenant|project):[A-Za-z0-9][A-Za-z0-9_-]{0,159})$/.test(key);
  if (!exact.has(key) && !dynamic) invalid("route");
  return `/admin/${key}`;
}

async function sign(value: string, key: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", arrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value))).toString("base64url");
}
function requestSecrets(body: ArrayBuffer): readonly string[] {
  const value = parseObject(new TextDecoder("utf-8", { fatal: true }).decode(body));
  const found = new Set<string>();
  visit(value, (key, child) => {
    if (RESPONSE_SECRET_FIELD.test(key) && typeof child === "string" && child.length >= 4) found.add(child);
  });
  return Object.freeze([...found]);
}
function assertPublicResponse(value: unknown): void {
  visit(value, (key, child) => {
    if (RESPONSE_SECRET_FIELD.test(key) && child !== "[REDACTED]") {
      throw new Error("Administrator control plane exposed secret metadata");
    }
  });
}
function visit(value: unknown, operation: (key: string, child: unknown) => void): void {
  if (Array.isArray(value)) { value.forEach((child) => visit(child, operation)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) { operation(key, child); visit(child, operation); }
}
function parseObject(text: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) invalid("JSON response"); return value as Record<string, unknown>; }
  catch (error) { if (error instanceof Error && error.message.startsWith("Administrator control-plane")) throw error; throw new Error("Administrator control plane returned invalid JSON"); }
}
function arrayBuffer(value: Uint8Array): ArrayBuffer { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer; }
function assertPrincipalScope(principal: ControlPlaneAdminPrincipal): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(principal.actorId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(principal.sessionId)
    || (principal.tenantId !== null && (typeof principal.tenantId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(principal.tenantId)))
    || (principal.projectId !== null && (typeof principal.projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(principal.projectId)))) invalid("principal");
  if ((principal.role === "PlatformAgentAdmin" || principal.role === "SecurityAdmin") && (principal.tenantId || principal.projectId)) invalid("principal");
  if (principal.role === "TenantAdmin" && (!principal.tenantId || principal.projectId)) invalid("principal");
  if (principal.role === "ProjectOwner" && (!principal.tenantId || !principal.projectId)) invalid("principal");
  if (principal.projectId && !principal.tenantId) invalid("principal");
}
function invalid(label: string): never { throw new Error(`Administrator control-plane ${label} is invalid`); }
