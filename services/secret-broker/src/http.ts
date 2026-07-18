import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import { SecretBrokerConflictError, SecretBrokerUnavailableError, SecretBrokerValidationError } from "./contracts";
import type { SecretBrokerService } from "./service";

const MAX_BODY_BYTES = 64 * 1024;
const SECRET_REF = /^vault:\/\/kv\/deviludo\/(?:records\/[a-f0-9-]{36}|static\/[A-Za-z0-9][A-Za-z0-9._-]{0,159})$/;

export interface SecretBrokerHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly body: Buffer;
}
export interface SecretBrokerHttpResponse {
  readonly status: number;
  readonly contentType: "application/json" | "application/octet-stream";
  readonly body: Buffer;
}

export function createSecretBrokerHandler(options: Readonly<{
  service: SecretBrokerService;
  controlPlaneSpiffeIds: ReadonlySet<string>;
  githubSpiffeIds: ReadonlySet<string>;
  inferenceGatewaySpiffeIds: ReadonlySet<string>;
  extractIdentity?: (socket: unknown) => Readonly<{ spiffeId: string }>;
}>) {
  const allowed = new Set([...options.controlPlaneSpiffeIds, ...options.githubSpiffeIds, ...options.inferenceGatewaySpiffeIds]);
  if (!options.controlPlaneSpiffeIds.size || !options.githubSpiffeIds.size || !options.inferenceGatewaySpiffeIds.size) {
    throw new Error("Secret Broker workload allow-lists are required");
  }
  for (const identity of allowed) {
    const memberships = [options.controlPlaneSpiffeIds, options.githubSpiffeIds, options.inferenceGatewaySpiffeIds]
      .filter((group) => group.has(identity)).length;
    if (memberships !== 1) throw new Error("Secret Broker workload roles must be disjoint");
  }
  const extract = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request: SecretBrokerHttpRequest): Promise<SecretBrokerHttpResponse> => {
    let workload: string;
    try { workload = extract(request.socket).spiffeId; }
    catch { return problem(401, "SECRET_BROKER_MTLS_IDENTITY_REQUIRED"); }
    if (!allowed.has(workload)) return problem(403, "SECRET_BROKER_WORKLOAD_FORBIDDEN");
    if (request.method === "GET" && request.path === "/healthz") {
      if (request.body.byteLength) return problem(400, "SECRET_BROKER_BODY_FORBIDDEN");
      try { await options.service.probe(); return json(200, { status: "ok", service: "deviludo-secret-broker" }); }
      catch { return problem(503, "SECRET_BROKER_NOT_READY"); }
    }
    try {
      if (request.method === "POST" && request.path === "/secrets:write") {
        requireRole(options.controlPlaneSpiffeIds, workload);
        requireContentType(request, "application/octet-stream");
        const encodedPath = single(request.headers["x-deviludo-secret-path"]);
        if (!encodedPath) invalid();
        let path: string;
        try { path = decodeURIComponent(encodedPath); } catch { invalid(); }
        requireIdempotencyKey(request, `provider-credential\0${path}`);
        const result = await options.service.writeProviderCredential({ path, plaintext: request.body, workloadSpiffeId: workload });
        return json(result.replayed ? 200 : 201, { secretRef: result.secretRef, maskedFingerprint: result.maskedFingerprint });
      }
      if (request.method === "POST" && request.path === "/secrets:revoke") {
        requireRole(options.controlPlaneSpiffeIds, workload);
        requireContentType(request, "application/json");
        const body = exactJson(request.body, ["secretRef"]);
        const ref = secretRef(body.secretRef);
        requireIdempotencyKey(request, `revoke\0${ref}`);
        await options.service.revoke({ secretRef: ref, workloadSpiffeId: workload });
        return empty(204);
      }
      if (request.method === "POST" && request.path === "/v1/github-authorization-secrets") {
        requireRole(options.githubSpiffeIds, workload);
        requireContentType(request, "application/octet-stream");
        if (single(request.headers["x-deviludo-secret-purpose"]) !== "github-pkce-v1") invalid();
        const expiresAt = single(request.headers["x-deviludo-expires-at"]); if (!expiresAt) invalid();
        const result = await options.service.putPkce({ value: request.body, expiresAt, workloadSpiffeId: workload });
        return json(201, {
          schemaVersion: "deviludo.github-authorization-secret.v1",
          secretRef: result.secretRef,
          expiresAt: result.expiresAt,
        });
      }
      if (request.method === "POST" && request.path === "/v1/github-authorization-secrets:take") {
        requireRole(options.githubSpiffeIds, workload); requireContentType(request, "application/json");
        const body = exactJson(request.body, ["schemaVersion", "secretRef"]);
        if (body.schemaVersion !== "deviludo.github-authorization-secret-take.v1") invalid();
        const secret = await options.service.takePkce({ secretRef: secretRef(body.secretRef), workloadSpiffeId: workload });
        return secret ? { status: 200, contentType: "application/octet-stream", body: secret } : problem(404, "SECRET_NOT_FOUND");
      }
      if (request.method === "POST" && request.path === "/v1/github-authorization-secrets:revoke") {
        requireRole(options.githubSpiffeIds, workload); requireContentType(request, "application/json");
        const body = exactJson(request.body, ["schemaVersion", "secretRef"]);
        if (body.schemaVersion !== "deviludo.github-authorization-secret-revoke.v1") invalid();
        await options.service.revoke({ secretRef: secretRef(body.secretRef), workloadSpiffeId: workload });
        return empty(204);
      }
      if (request.method === "POST" && request.path === "/v1/static-secret-leases:resolve") {
        requireRole(options.githubSpiffeIds, workload); requireContentType(request, "application/json");
        const body = exactJson(request.body, ["purpose", "schemaVersion", "secretRef"]);
        if (body.schemaVersion !== "deviludo.static-secret-lease.v1" || body.purpose !== "github-oauth-client-secret") invalid();
        const secret = await options.service.resolveStaticGitHubSecret({
          secretRef: secretRef(body.secretRef), purpose: "github-oauth-client-secret", workloadSpiffeId: workload,
        });
        return { status: 200, contentType: "application/octet-stream", body: secret };
      }
      if (request.method === "POST" && request.path === "/v1/inference-credentials/resolve") {
        requireRole(options.inferenceGatewaySpiffeIds, workload); requireContentType(request, "application/json");
        const body = jsonObject(request.body);
        if (body.schemaVersion === "deviludo.inference-credential-request.v1") {
          exactKeys(body, ["credentialVersionId", "projectId", "providerRevisionId", "requestId", "runId", "schemaVersion", "tenantId"]);
          return json(200, await options.service.resolveInference({
            requestId: text(body.requestId), tenantId: text(body.tenantId), projectId: text(body.projectId), runId: text(body.runId),
            providerRevisionId: text(body.providerRevisionId), credentialVersionId: text(body.credentialVersionId), workloadSpiffeId: workload,
          }));
        }
        if (body.schemaVersion === "deviludo.inference-provider-probe-credential-request.v1") {
          exactKeys(body, ["credentialVersionId", "providerRevisionId", "requestId", "schemaVersion"]);
          return json(200, await options.service.resolveInferenceProbe({
            requestId: text(body.requestId), providerRevisionId: text(body.providerRevisionId),
            credentialVersionId: text(body.credentialVersionId), workloadSpiffeId: workload,
          }));
        }
        invalid();
      }
      return problem(404, "SECRET_BROKER_ROUTE_NOT_FOUND");
    } catch (error) { return mapped(error); }
  };
}

export function createSecretBrokerHttpsServer(options: Readonly<{
  tls: Readonly<{ key: Buffer; cert: Buffer; ca: Buffer }>;
  handler: ReturnType<typeof createSecretBrokerHandler>;
  requestTimeoutMs?: number;
}>): HttpsServer {
  const tls: ServerOptions = { ...options.tls, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" };
  const server = createServer(tls, async (request, response) => {
    let body: Buffer | null = null;
    try {
      body = await readBody(request);
      const result = await options.handler({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, socket: request.socket, body });
      writeResponse(response, result);
    } catch { writeResponse(response, problem(400, "SECRET_BROKER_REQUEST_REJECTED")); }
    finally { body?.fill(0); }
  });
  server.requestTimeout = options.requestTimeoutMs ?? 30_000;
  server.headersTimeout = Math.min(server.requestTimeout, 15_000);
  server.keepAliveTimeout = 5_000;
  return server;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) throw new Error("body invalid");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += value.byteLength;
    if (size > MAX_BODY_BYTES) { for (const item of chunks) item.fill(0); value.fill(0); throw new Error("body invalid"); }
    chunks.push(value);
  }
  try { return Buffer.concat(chunks); }
  finally { for (const chunk of chunks) chunk.fill(0); }
}
function writeResponse(response: ServerResponse, result: SecretBrokerHttpResponse): void {
  response.statusCode = result.status;
  response.setHeader("content-type", result.contentType);
  response.setHeader("content-length", String(result.body.byteLength));
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.end(result.body, () => result.body.fill(0));
}
function exactJson(body: Buffer, keys: readonly string[]): Record<string, unknown> { const value = jsonObject(body); exactKeys(value, keys); return value; }
function jsonObject(body: Buffer): Record<string, unknown> { try { const value: unknown = JSON.parse(body.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; } catch { invalid(); } }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void { if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalid(); }
function requireContentType(request: SecretBrokerHttpRequest, expected: string): void { if ((single(request.headers["content-type"]) ?? "").split(";", 1)[0]!.trim().toLowerCase() !== expected) throw new SecretBrokerValidationError("Secret Broker content type is invalid"); }
function requireIdempotencyKey(request: SecretBrokerHttpRequest, binding: string): void {
  const expected = createHash("sha256").update(binding).digest("hex");
  if (single(request.headers["idempotency-key"]) !== expected) invalid();
}
function requireRole(allowed: ReadonlySet<string>, workload: string): void { if (!allowed.has(workload)) throw new WorkloadForbiddenError(); }
function single(value: string | readonly string[] | undefined): string | undefined { return typeof value === "string" ? value : Array.isArray(value) && value.length === 1 ? value[0] : undefined; }
function text(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function secretRef(value: unknown): string { const result = text(value); if (!SECRET_REF.test(result)) invalid(); return result; }
function json(status: number, value: unknown): SecretBrokerHttpResponse { return { status, contentType: "application/json", body: Buffer.from(JSON.stringify(value)) }; }
function empty(status: number): SecretBrokerHttpResponse { return { status, contentType: "application/json", body: Buffer.alloc(0) }; }
function problem(status: number, code: string): SecretBrokerHttpResponse { return json(status, { error: { code } }); }
function mapped(error: unknown): SecretBrokerHttpResponse {
  if (error instanceof WorkloadForbiddenError) return problem(403, "SECRET_BROKER_ROLE_FORBIDDEN");
  if (error instanceof SecretBrokerValidationError) return problem(400, "SECRET_BROKER_INVALID_REQUEST");
  if (error instanceof SecretBrokerConflictError) return problem(409, "SECRET_BROKER_BINDING_CONFLICT");
  if (error instanceof SecretBrokerUnavailableError) return problem(503, "SECRET_BROKER_SECRET_UNAVAILABLE");
  return problem(503, "SECRET_BROKER_UNAVAILABLE");
}
class WorkloadForbiddenError extends Error {}
function invalid(): never { throw new SecretBrokerValidationError("Secret Broker request is invalid"); }
