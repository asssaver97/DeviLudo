import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import {
  WorkflowActionCompletionConflictError,
  WorkflowActionCompletionValidationError,
} from "../../control-plane/src/workflow-action-completion-postgres";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import { ProviderRecoveryRequestError } from "./contracts";
import { ProviderRecoveryConflict, type ProviderRecoveryService } from "./service";

const MAX_BODY_BYTES = 16 * 1024;

export interface ProviderRecoveryHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}
export interface ProviderRecoveryHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function createProviderMonitorHandler(options: {
  readonly service: Pick<ProviderRecoveryService, "check" | "probe">;
  readonly allowedSchedulerSpiffeIds: ReadonlySet<string>;
  readonly extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}) {
  if (!options.allowedSchedulerSpiffeIds.size) throw new Error("Provider monitor scheduler allow-list is empty");
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request: ProviderRecoveryHttpRequest): Promise<ProviderRecoveryHttpResponse> => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "PROVIDER_MONITOR_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSchedulerSpiffeIds.has(identity.spiffeId)) {
      return failure(403, "PROVIDER_MONITOR_SCHEDULER_FORBIDDEN");
    }
    if (request.method === "GET" && request.path === "/healthz") {
      try { await options.service.probe(); }
      catch { return failure(503, "PROVIDER_MONITOR_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-provider-monitor" } };
    }
    if (request.method !== "POST" || request.path !== "/v1/provider-recovery-checks") {
      return failure(404, "PROVIDER_MONITOR_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "PROVIDER_MONITOR_JSON_REQUIRED");
    }
    let body: unknown;
    try { body = JSON.parse(request.rawBody) as unknown; }
    catch { return failure(400, "INVALID_PROVIDER_RECOVERY_CHECK"); }
    try {
      const receipt = await options.service.check(body, identity.spiffeId);
      return { status: receipt.replayed ? 200 : 201, body: { data: receipt } };
    } catch (error) {
      if (error instanceof ProviderRecoveryRequestError) return failure(400, error.code);
      if (error instanceof ProviderRecoveryConflict) return failure(409, error.code);
      if (error instanceof WorkflowActionCompletionValidationError) return failure(400, "INVALID_PROVIDER_RECOVERY_CHECK");
      if (error instanceof WorkflowActionCompletionConflictError) return failure(409, "PROVIDER_RECOVERY_CONFLICT");
      return failure(503, "PROVIDER_MONITOR_UNAVAILABLE");
    }
  };
}

export function createProviderMonitorHttpsServer(options: {
  readonly tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  readonly handler: (request: ProviderRecoveryHttpRequest) => Promise<ProviderRecoveryHttpResponse>;
}): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("Provider monitor TLS material is incomplete");
  const server = createServer({ ...options.tls, minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true },
    (request, response) => { void dispatch(request, response, options.handler); });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function dispatch(request: IncomingMessage, response: ServerResponse,
  handler: (request: ProviderRecoveryHttpRequest) => Promise<ProviderRecoveryHttpResponse>): Promise<void> {
  try {
    const rawBody = await readBody(request);
    send(response, await handler({ method: request.method ?? "", path: request.url ?? "",
      headers: request.headers, socket: request.socket, rawBody }));
  } catch (error) {
    send(response, failure(error instanceof BodyLimitError ? 413 : 500,
      error instanceof BodyLimitError ? "PROVIDER_MONITOR_REQUEST_TOO_LARGE" : "PROVIDER_MONITOR_UNAVAILABLE"));
  }
}
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength; if (size <= MAX_BODY_BYTES) chunks.push(value);
    });
    request.once("end", () => size > MAX_BODY_BYTES ? reject(new BodyLimitError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject); request.once("aborted", () => reject(new Error("aborted")));
  });
}
function send(response: ServerResponse, result: ProviderRecoveryHttpResponse): void {
  const body = JSON.stringify(result.body); response.statusCode = result.status;
  response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body)); response.end(body);
}
function contentType(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase().split(";", 1)[0]?.trim() ?? null : null;
}
function failure(status: number, code: string): ProviderRecoveryHttpResponse { return { status, body: { error: { code } } }; }
class BodyLimitError extends Error {}
