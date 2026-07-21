import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import {
  WorkflowActionCompletionConflictError,
  WorkflowActionCompletionValidationError,
} from "../../control-plane/src/workflow-action-completion-postgres";
import { SteamExternalApprovalRequestError } from "./contracts";
import { SteamExternalApprovalConflict, type SteamExternalApprovalService } from "./service";

const MAX_BODY_BYTES = 32 * 1024;

export interface SteamApprovalHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}
export interface SteamApprovalHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function createSteamApprovalMonitorHandler(options: {
  readonly service: Pick<SteamExternalApprovalService, "approve" | "probe">;
  readonly allowedVerifierSpiffeIds: ReadonlySet<string>;
  readonly extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}) {
  if (!options.allowedVerifierSpiffeIds.size) throw new Error("Steam approval verifier allow-list is empty");
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request: SteamApprovalHttpRequest): Promise<SteamApprovalHttpResponse> => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "STEAM_APPROVAL_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedVerifierSpiffeIds.has(identity.spiffeId)) {
      return failure(403, "STEAM_APPROVAL_VERIFIER_FORBIDDEN");
    }
    if (request.method === "GET" && request.path === "/healthz") {
      try { await options.service.probe(); }
      catch { return failure(503, "STEAM_APPROVAL_MONITOR_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-steam-approval-monitor" } };
    }
    if (request.method !== "POST" || request.path !== "/v1/external-approvals") {
      return failure(404, "STEAM_APPROVAL_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "STEAM_APPROVAL_JSON_REQUIRED");
    }
    let body: unknown;
    try { body = JSON.parse(request.rawBody) as unknown; }
    catch { return failure(400, "INVALID_STEAM_EXTERNAL_APPROVAL"); }
    try {
      const receipt = await options.service.approve(body, identity.spiffeId);
      return { status: receipt.replayed ? 200 : 201, body: { data: receipt } };
    } catch (error) {
      if (error instanceof SteamExternalApprovalRequestError) return failure(400, error.code);
      if (error instanceof SteamExternalApprovalConflict) return failure(409, error.code);
      if (error instanceof WorkflowActionCompletionValidationError) return failure(400, "INVALID_STEAM_EXTERNAL_APPROVAL");
      if (error instanceof WorkflowActionCompletionConflictError) return failure(409, "STEAM_EXTERNAL_APPROVAL_CONFLICT");
      return failure(503, "STEAM_APPROVAL_MONITOR_UNAVAILABLE");
    }
  };
}

export function createSteamApprovalMonitorHttpsServer(options: {
  readonly tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  readonly handler: (request: SteamApprovalHttpRequest) => Promise<SteamApprovalHttpResponse>;
}): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("Steam approval TLS material is incomplete");
  const server = createServer({
    ...options.tls,
    minVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, response) => { void dispatch(request, response, options.handler); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: SteamApprovalHttpRequest) => Promise<SteamApprovalHttpResponse>,
): Promise<void> {
  try {
    const rawBody = await readBody(request);
    send(response, await handler({
      method: request.method ?? "", path: request.url ?? "",
      headers: request.headers, socket: request.socket, rawBody,
    }));
  } catch (error) {
    send(response, failure(error instanceof BodyLimitError ? 413 : 500,
      error instanceof BodyLimitError ? "STEAM_APPROVAL_REQUEST_TOO_LARGE" : "STEAM_APPROVAL_MONITOR_UNAVAILABLE"));
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size <= MAX_BODY_BYTES) chunks.push(value);
    });
    request.once("end", () => size > MAX_BODY_BYTES
      ? reject(new BodyLimitError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("aborted")));
  });
}
function send(response: ServerResponse, result: SteamApprovalHttpResponse): void {
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
function failure(status: number, code: string): SteamApprovalHttpResponse {
  return { status, body: { error: { code } } };
}
class BodyLimitError extends Error {}
