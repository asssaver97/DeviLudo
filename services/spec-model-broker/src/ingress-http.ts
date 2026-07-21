import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import {
  SpecModelBusyError,
  SpecModelIndeterminateError,
  SpecModelProviderUnavailableError,
  SpecModelReconciliationConflictError,
  SpecModelRequestError,
  SpecModelUpstreamError,
} from "./contracts";
import type { SpecModelBrokerService } from "./service";
import { SpecModelReconciliationRequestError, type StrictSpecModelReconciliationService } from "./reconciliation";

const MAX_BODY_BYTES = 512 * 1024;

export interface SpecModelHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}
export interface SpecModelHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export function createSpecModelBrokerHandler(options: Readonly<{
  service: SpecModelBrokerService;
  allowedSpiffeIds: ReadonlySet<string>;
  reconciliation?: StrictSpecModelReconciliationService;
  reconciliationSpiffeIds?: ReadonlySet<string>;
  extractIdentity?: (socket: unknown) => Readonly<{ spiffeId: string }>;
}>) {
  if (!options.allowedSpiffeIds.size) throw new Error("Specification model Broker workload allow-list is empty");
  const reconciliationIds = options.reconciliationSpiffeIds ?? new Set<string>();
  if (Boolean(options.reconciliation) !== Boolean(reconciliationIds.size)) {
    throw new Error("Specification model reconciliation service and workload role must be configured together");
  }
  if ([...reconciliationIds].some((identity) => options.allowedSpiffeIds.has(identity))) {
    throw new Error("Specification model generation and reconciliation workload roles must be disjoint");
  }
  const extract = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request: SpecModelHttpRequest): Promise<SpecModelHttpResponse> => {
    let workload: string;
    try { workload = extract(request.socket).spiffeId; }
    catch { return failure(401, "SPEC_MODEL_MTLS_IDENTITY_REQUIRED"); }
    if (request.method === "GET" && request.path === "/healthz") {
      if (!options.allowedSpiffeIds.has(workload) && !reconciliationIds.has(workload)) {
        return failure(403, "SPEC_MODEL_WORKLOAD_FORBIDDEN");
      }
      if (request.rawBody) return failure(400, "SPEC_MODEL_BODY_FORBIDDEN");
      try {
        await options.service.probe();
        return { status: 200, body: { schemaVersion: "deviludo.spec-model-health.v1", status: "ok", service: "deviludo-spec-model-broker" } };
      } catch { return failure(503, "SPEC_MODEL_NOT_READY"); }
    }
    if (request.method === "POST" && (request.path === "/v1/spec-generation-reconciliations"
      || request.path === "/v1/spec-generation-reconciliations/lookup")) {
      if (!reconciliationIds.has(workload) || !options.reconciliation) {
        return failure(403, "SPEC_MODEL_RECONCILIATION_WORKLOAD_FORBIDDEN");
      }
      if (contentType(request.headers["content-type"]) !== "application/json") {
        return failure(415, "SPEC_MODEL_JSON_REQUIRED");
      }
      if (credentialHeadersPresent(request.headers)) return failure(400, "SPEC_MODEL_CREDENTIAL_FIELDS_FORBIDDEN");
      let body: unknown;
      try { body = JSON.parse(request.rawBody) as unknown; }
      catch { return failure(400, "SPEC_MODEL_RECONCILIATION_INVALID"); }
      try {
        const result = request.path.endsWith("/lookup")
          ? await options.reconciliation.lookup(body)
          : await options.reconciliation.run(body);
        return { status: 200, body: result, headers: { "cache-control": "no-store" } };
      } catch (error) {
        if (error instanceof SpecModelReconciliationRequestError) {
          return failure(400, "SPEC_MODEL_RECONCILIATION_INVALID");
        }
        if (error instanceof SpecModelReconciliationConflictError) {
          return failure(409, "SPEC_MODEL_RECONCILIATION_CONFLICT");
        }
        return failure(503, "SPEC_MODEL_RECONCILIATION_UNAVAILABLE");
      }
    }
    if (!options.allowedSpiffeIds.has(workload)) return failure(403, "SPEC_MODEL_WORKLOAD_FORBIDDEN");
    if (request.method !== "POST" || request.path !== "/v1/spec-generations") {
      return failure(404, "SPEC_MODEL_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "SPEC_MODEL_JSON_REQUIRED");
    }
    if (credentialHeadersPresent(request.headers)) {
      return failure(400, "SPEC_MODEL_CREDENTIAL_FIELDS_FORBIDDEN");
    }
    const operationKey = single(request.headers["idempotency-key"]);
    let body: unknown;
    try { body = JSON.parse(request.rawBody) as unknown; }
    catch { return failure(400, "SPEC_MODEL_INVALID_REQUEST"); }
    try {
      const result = await options.service.generate(body, operationKey);
      return { status: 200, body: result, headers: { "cache-control": "no-store" } };
    } catch (error) {
      if (error instanceof SpecModelRequestError) return failure(400, "SPEC_MODEL_INVALID_REQUEST");
      if (error instanceof SpecModelBusyError) return failure(409, "SPEC_MODEL_BUSY", { "retry-after": "1" });
      if (error instanceof SpecModelIndeterminateError) return failure(503, "SPEC_MODEL_RECONCILIATION_REQUIRED");
      if (error instanceof SpecModelProviderUnavailableError) return failure(503, "SPEC_MODEL_PROVIDER_UNAVAILABLE");
      if (error instanceof SpecModelUpstreamError) {
        return failure(503, error.dispatched ? "SPEC_MODEL_UPSTREAM_INDETERMINATE" : "SPEC_MODEL_UPSTREAM_UNAVAILABLE");
      }
      return failure(503, "SPEC_MODEL_UNAVAILABLE");
    }
  };
}

export function createSpecModelBrokerHttpsServer(options: Readonly<{
  tls: Readonly<{ key: Buffer; cert: Buffer; ca: Buffer }>;
  handler: ReturnType<typeof createSpecModelBrokerHandler>;
  requestTimeoutMs?: number;
}>): HttpsServer {
  if (!options.tls.key.length || !options.tls.cert.length || !options.tls.ca.length) {
    throw new Error("Specification model Broker TLS material is incomplete");
  }
  const tls: ServerOptions = {
    ...options.tls,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  };
  const server = createServer(tls, async (request, response) => {
    try {
      const rawBody = await readBody(request);
      const result = await options.handler({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        socket: request.socket,
        rawBody,
      });
      writeResponse(response, result);
    } catch { writeResponse(response, failure(400, "SPEC_MODEL_REQUEST_REJECTED")); }
  });
  server.requestTimeout = options.requestTimeoutMs ?? 130_000;
  server.headersTimeout = Math.min(server.requestTimeout, 15_000);
  server.keepAliveTimeout = 5_000;
  return server;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) throw new Error("body");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("body");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function writeResponse(response: ServerResponse, result: SpecModelHttpResponse): void {
  const body = Buffer.from(JSON.stringify(result.body));
  response.statusCode = result.status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", String(body.byteLength));
  response.setHeader("cache-control", result.headers?.["cache-control"] ?? "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
  response.end(body);
}
function failure(status: number, code: string, headers?: Readonly<Record<string, string>>): SpecModelHttpResponse {
  return { status, body: { error: { code } }, ...(headers ? { headers } : {}) };
}
function contentType(value: string | readonly string[] | undefined): string {
  return (single(value) ?? "").split(";", 1)[0]!.trim().toLowerCase();
}
function single(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) && value.length === 1 ? value[0] : undefined;
}
function credentialHeadersPresent(headers: SpecModelHttpRequest["headers"]): boolean {
  return headers.authorization !== undefined || headers["x-api-key"] !== undefined
    || headers["anthropic-api-key"] !== undefined;
}
