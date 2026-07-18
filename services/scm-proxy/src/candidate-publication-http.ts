import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import type { CandidatePublicationRequest } from "./candidate-publication-contracts";
import { parseCandidatePublicationRequest } from "./candidate-publication-contracts";
import type { AuthoritativeCandidatePublicationService } from "./candidate-publication-service";

const MAX_BODY_BYTES = 140 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export interface CandidatePublicationIngressRequest { readonly method: string; readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>; readonly socket: unknown; readonly rawBody: string }
export interface CandidatePublicationIngressResponse { readonly status: number; readonly body: Readonly<Record<string, unknown>> }

export function createCandidatePublicationHandler(options: Readonly<{ service: AuthoritativeCandidatePublicationService;
  allowedSpiffeIds: ReadonlySet<string>; healthIdentity: Readonly<{ version: string; binaryDigest: string }>;
  extractIdentity?: (socket: unknown) => Readonly<{ spiffeId: string }> }>):
  (request: CandidatePublicationIngressRequest) => Promise<CandidatePublicationIngressResponse> {
  if (!options.allowedSpiffeIds.size || !/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+){0,5}$/.test(options.healthIdentity.version)
    || !SHA256.test(options.healthIdentity.binaryDigest)) throw new Error("SCM candidate Broker identity is invalid");
  const extract = options.extractIdentity ?? ((socket) => evidenceArchiveIdentityFromTlsSocket(socket));
  return async (request) => {
    let identity: Readonly<{ spiffeId: string }>;
    try { identity = extract(request.socket); } catch { return failure(401, "SCM_CANDIDATE_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) return failure(403, "SCM_CANDIDATE_WORKLOAD_FORBIDDEN");
    if (request.method === "GET" && request.path === "/healthz") {
      if (request.rawBody) return failure(400, "SCM_CANDIDATE_REQUEST_INVALID");
      try { await options.service.probe(); } catch { return failure(503, "SCM_CANDIDATE_NOT_READY"); }
      return { status: 200, body: { schemaVersion: "deviludo.scm-candidate-health.v1", status: "ok",
        service: "deviludo-scm-candidate-broker", ...options.healthIdentity } };
    }
    if (request.method !== "POST" || request.path !== "/v1/candidates") return failure(404, "SCM_CANDIDATE_ROUTE_NOT_FOUND");
    if (contentType(request.headers["content-type"]) !== "application/json") return failure(415, "SCM_CANDIDATE_JSON_REQUIRED");
    let body: CandidatePublicationRequest;
    try { body = parseCandidatePublicationRequest(request.rawBody); validateHeaders(request.headers, body); }
    catch { return failure(400, "SCM_CANDIDATE_REQUEST_INVALID"); }
    try { return { status: 200, body: Object.freeze({ ...await options.service.publish(body) }) }; }
    catch { return failure(409, "SCM_CANDIDATE_PUBLICATION_REJECTED"); }
  };
}

export function createCandidatePublicationHttpsServer(options: Readonly<{ tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: (request: CandidatePublicationIngressRequest) => Promise<CandidatePublicationIngressResponse>;
  maxBodyBytes?: number; requestTimeoutMs?: number }>): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("SCM candidate TLS is incomplete");
  const maximum = options.maxBodyBytes ?? MAX_BODY_BYTES; const timeout = options.requestTimeoutMs ?? 10 * 60_000;
  if (!Number.isInteger(maximum) || maximum < 1024 * 1024 || maximum > MAX_BODY_BYTES
    || !Number.isInteger(timeout) || timeout < 1_000 || timeout > 15 * 60_000) throw new Error("SCM candidate server limits are invalid");
  const server = createServer({ ...options.tls, minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true },
    (request, response) => { void dispatch(request, response, options.handler, maximum); });
  server.requestTimeout = timeout; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000; server.maxHeadersCount = 64;
  return server;
}

async function dispatch(request: IncomingMessage, response: ServerResponse,
  handler: (request: CandidatePublicationIngressRequest) => Promise<CandidatePublicationIngressResponse>, maximum: number): Promise<void> {
  try { const rawBody = await readBody(request, maximum); const result = await handler({ method: request.method ?? "",
    path: new URL(request.url ?? "/", "https://scm.invalid").pathname, headers: request.headers, socket: request.socket, rawBody });
    response.statusCode = result.status; response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store"); response.end(JSON.stringify(result.body)); }
  catch { if (!response.headersSent) response.statusCode = 400; response.end(JSON.stringify({ error: { code: "SCM_CANDIDATE_REQUEST_INVALID" } })); }
}
function readBody(request: IncomingMessage, maximum: number): Promise<string> { return new Promise((resolve, reject) => { const chunks: Buffer[] = []; let bytes = 0;
  request.on("data", (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.byteLength;
    if (bytes > maximum) { request.destroy(); reject(new Error("body too large")); } else chunks.push(value); });
  request.once("error", reject); request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); }); }
function validateHeaders(headers: CandidatePublicationIngressRequest["headers"], body: CandidatePublicationRequest): void {
  if (header(headers, "x-deviludo-tenant-id", UUID) !== body.tenantId
    || header(headers, "idempotency-key", /^agent-candidate:[a-f0-9-]{36}:[a-f0-9-]{36}$/i) !== body.operationKey
    || header(headers, "x-deviludo-request-digest", SHA256) !== body.requestDigest) throw new Error("header mismatch");
}
function header(headers: CandidatePublicationIngressRequest["headers"], name: string, shape: RegExp): string { const value = headers[name]; if (typeof value !== "string" || !shape.test(value)) throw new Error("header invalid"); return value; }
function contentType(value: string | readonly string[] | undefined): string { return typeof value === "string" ? value.split(";", 1)[0]!.trim().toLowerCase() : ""; }
function failure(status: number, code: string): CandidatePublicationIngressResponse { return { status, body: { error: { code } } }; }
