import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import { parseSpecWorkflowApprovalRequest, type SpecWorkflowApprovalRequest } from "./contracts";
import type { SpecWorkflowBridgeService } from "./service";

const MAX_BODY_BYTES = 32 * 1024;

export interface SpecWorkflowHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}
export interface SpecWorkflowHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function createSpecWorkflowHandler(options: {
  readonly service: Pick<SpecWorkflowBridgeService, "enqueue" | "probe">;
  readonly allowedSpiffeIds: ReadonlySet<string>;
  readonly extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}) {
  if (!options.allowedSpiffeIds.size) throw new Error("Specification workflow workload allow-list is empty");
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request: SpecWorkflowHttpRequest): Promise<SpecWorkflowHttpResponse> => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "SPEC_WORKFLOW_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) return failure(403, "SPEC_WORKFLOW_WORKLOAD_FORBIDDEN");
    if (request.method === "GET" && request.path === "/healthz") {
      try { await options.service.probe(); }
      catch { return failure(503, "SPEC_WORKFLOW_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-spec-workflow-bridge" } };
    }
    if (request.method !== "POST" || request.path !== "/v1/spec-approvals") {
      return failure(404, "SPEC_WORKFLOW_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "SPEC_WORKFLOW_JSON_REQUIRED");
    }
    let body: SpecWorkflowApprovalRequest;
    try {
      body = parseSpecWorkflowApprovalRequest(JSON.parse(request.rawBody) as unknown);
      if (singleHeader(request.headers["idempotency-key"]) !== body.operationKey) throw new Error("drift");
    }
    catch { return failure(400, "INVALID_SPEC_WORKFLOW_APPROVAL"); }
    try {
      const receipt = await options.service.enqueue(body);
      return { status: receipt.replayed ? 200 : 202, body: { data: receipt } };
    } catch {
      return failure(409, "SPEC_WORKFLOW_APPROVAL_CONFLICT");
    }
  };
}

export function createSpecWorkflowHttpsServer(options: {
  readonly tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  readonly handler: (request: SpecWorkflowHttpRequest) => Promise<SpecWorkflowHttpResponse>;
}): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("Specification workflow TLS material is incomplete");
  const server = createServer({
    ...options.tls, minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true,
  }, (request, response) => { void dispatch(request, response, options.handler); });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: SpecWorkflowHttpRequest) => Promise<SpecWorkflowHttpResponse>,
): Promise<void> {
  try {
    const rawBody = await readBody(request);
    send(response, await handler({
      method: request.method ?? "", path: request.url ?? "", headers: request.headers,
      socket: request.socket, rawBody,
    }));
  } catch (error) {
    send(response, failure(error instanceof BodyLimitError ? 413 : 500,
      error instanceof BodyLimitError ? "SPEC_WORKFLOW_REQUEST_TOO_LARGE" : "SPEC_WORKFLOW_UNAVAILABLE"));
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes <= MAX_BODY_BYTES) chunks.push(value);
    });
    request.once("end", () => bytes > MAX_BODY_BYTES
      ? reject(new BodyLimitError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("aborted")));
  });
}

function send(response: ServerResponse, result: SpecWorkflowHttpResponse): void {
  const body = JSON.stringify(result.body);
  response.statusCode = result.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function contentType(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase().split(";", 1)[0]?.trim() ?? null : null;
}
function singleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" && value.length <= 256 ? value : null;
}
function failure(status: number, code: string): SpecWorkflowHttpResponse {
  return { status, body: { error: { code } } };
}
class BodyLimitError extends Error {}
