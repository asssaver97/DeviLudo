import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import type { AuthoritativeScmMergeService, ScmMergeCommand } from "./merge-service";
import { parseScmMergeCommand } from "./merge-service";

const MAX_BODY_BYTES = 32 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ScmMergeIngressRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}
export interface ScmMergeIngressResponse { readonly status: number; readonly body: Readonly<Record<string, unknown>> }

export function createScmMergeHandler(options: Readonly<{
  service: Pick<AuthoritativeScmMergeService, "merge" | "probe">;
  allowedSpiffeIds: ReadonlySet<string>;
  extractIdentity?: (socket: unknown) => Readonly<{ spiffeId: string }>;
}>): (request: ScmMergeIngressRequest) => Promise<ScmMergeIngressResponse> {
  if (!options.allowedSpiffeIds.size) throw new Error("SCM merge workload allow-list is empty");
  const extract = options.extractIdentity ?? ((socket) => evidenceArchiveIdentityFromTlsSocket(socket));
  return async (request) => {
    let identity: Readonly<{ spiffeId: string }>;
    try { identity = extract(request.socket); } catch { return failure(401, "SCM_MERGE_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) return failure(403, "SCM_MERGE_WORKLOAD_FORBIDDEN");
    if (request.method === "GET" && request.path === "/healthz") {
      if (request.rawBody) return failure(400, "SCM_MERGE_REQUEST_INVALID");
      try { await options.service.probe(); } catch { return failure(503, "SCM_MERGE_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-scm-merge-broker" } };
    }
    if (request.method !== "POST" || request.path !== "/v1/merges") return failure(404, "SCM_MERGE_ROUTE_NOT_FOUND");
    if (contentType(request.headers["content-type"]) !== "application/json") return failure(415, "SCM_MERGE_JSON_REQUIRED");
    let command: ScmMergeCommand;
    try { command = parseScmMergeCommand(request.rawBody); validateHeaders(request.headers, command); }
    catch { return failure(400, "SCM_MERGE_REQUEST_INVALID"); }
    try {
      const receipt = await options.service.merge(command);
      return { status: 200, body: Object.freeze({ status: "COMPLETED", mergeId: receipt.receiptId,
        operationKey: command.operationKey, requestDigest: command.requestDigest, receipt }) };
    } catch { return failure(409, "SCM_MERGE_AUTHORITY_REJECTED"); }
  };
}

export function createScmMergeHttpsServer(options: Readonly<{
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: (request: ScmMergeIngressRequest) => Promise<ScmMergeIngressResponse>;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}>): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("SCM merge TLS is incomplete");
  const maximum = integer(options.maxBodyBytes ?? MAX_BODY_BYTES, 1024, MAX_BODY_BYTES);
  const timeout = integer(options.requestTimeoutMs ?? 10 * 60_000, 1_000, 15 * 60_000);
  const server = createServer({ ...options.tls, minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true },
    (request, response) => { void dispatch(request, response, options.handler, maximum); });
  server.requestTimeout = timeout; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000; server.maxHeadersCount = 64;
  return server;
}

async function dispatch(request: IncomingMessage, response: ServerResponse,
  handler: (request: ScmMergeIngressRequest) => Promise<ScmMergeIngressResponse>, maximum: number): Promise<void> {
  try {
    const rawBody = await readBody(request, maximum);
    const result = await handler({ method: request.method ?? "", path: new URL(request.url ?? "/", "https://scm.invalid").pathname,
      headers: request.headers, socket: request.socket, rawBody });
    response.statusCode = result.status; response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store"); response.end(JSON.stringify(result.body));
  } catch { if (!response.headersSent) response.statusCode = 400; response.end(JSON.stringify({ error: { code: "SCM_MERGE_REQUEST_INVALID" } })); }
}
function readBody(request: IncomingMessage, maximum: number): Promise<string> { return new Promise((resolve, reject) => { const chunks: Buffer[] = []; let bytes = 0;
  request.on("data", (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.byteLength;
    if (bytes > maximum) { request.destroy(); reject(new Error("body too large")); } else chunks.push(value); });
  request.once("error", reject); request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); }); }
function validateHeaders(headers: ScmMergeIngressRequest["headers"], command: ScmMergeCommand): void {
  if (header(headers, "idempotency-key", /^workflow-job:[a-f0-9-]{36}$/) !== command.operationKey
    || header(headers, "x-deviludo-request-digest", SHA256) !== command.requestDigest) throw new Error("header mismatch");
}
function header(headers: ScmMergeIngressRequest["headers"], name: string, shape: RegExp): string { const value = headers[name];
  if (typeof value !== "string" || !shape.test(value)) throw new Error("header invalid"); return value; }
function contentType(value: string | readonly string[] | undefined): string { return typeof value === "string" ? value.split(";", 1)[0]!.trim().toLowerCase() : ""; }
function integer(value: number, min: number, max: number): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("SCM merge server limit is invalid"); return value; }
function failure(status: number, code: string): ScmMergeIngressResponse { return { status, body: { error: { code } } }; }
