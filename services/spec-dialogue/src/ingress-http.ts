import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import { SpecDialogueRequestError } from "./contracts";
import { SpecDialogueConflict, type SpecDialogueService } from "./service";
import { SpecDialogueToolchainUnavailable } from "./store";

const MAX_BODY_BYTES = 32 * 1024;

export interface SpecDialogueHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}
export interface SpecDialogueHttpResponse { readonly status: number; readonly body: Readonly<Record<string, unknown>> }

export function createSpecDialogueHandler(options: {
  readonly service: Pick<SpecDialogueService, "send" | "snapshot" | "approve" | "probe">;
  readonly allowedSpiffeIds: ReadonlySet<string>;
  readonly extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}) {
  if (!options.allowedSpiffeIds.size) throw new Error("Specification dialogue workload allow-list is empty");
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request: SpecDialogueHttpRequest): Promise<SpecDialogueHttpResponse> => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "SPEC_DIALOGUE_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) return failure(403, "SPEC_DIALOGUE_WORKLOAD_FORBIDDEN");
    if (request.method === "GET" && request.path === "/healthz") {
      try { await options.service.probe(); }
      catch { return failure(503, "SPEC_DIALOGUE_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-spec-dialogue" } };
    }
    if (request.method !== "POST" || !["/v1/spec-dialogue/messages", "/v1/spec-dialogue/snapshot", "/v1/spec-dialogue/approve"].includes(request.path)) {
      return failure(404, "SPEC_DIALOGUE_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") return failure(415, "SPEC_DIALOGUE_JSON_REQUIRED");
    let body: unknown;
    try { body = JSON.parse(request.rawBody); }
    catch { return failure(400, "INVALID_SPEC_DIALOGUE_REQUEST"); }
    try {
      const result = request.path.endsWith("/messages")
        ? await options.service.send(body)
        : request.path.endsWith("/approve") ? await options.service.approve(body) : await options.service.snapshot(body);
      return { status: request.path.endsWith("/messages") || request.path.endsWith("/approve") ? 201 : 200, body: { data: result } };
    } catch (error) {
      if (error instanceof SpecDialogueRequestError) return failure(400, error.code);
      if (error instanceof SpecDialogueConflict) return failure(409, error.code);
      if (error instanceof SpecDialogueToolchainUnavailable) return failure(503, error.code);
      return failure(503, "SPEC_DIALOGUE_UNAVAILABLE");
    }
  };
}

export function createSpecDialogueHttpsServer(options: {
  readonly tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  readonly handler: (request: SpecDialogueHttpRequest) => Promise<SpecDialogueHttpResponse>;
}): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("Specification dialogue TLS material is incomplete");
  const server = createServer({ ...options.tls, minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true },
    (request, response) => { void dispatch(request, response, options.handler); });
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function dispatch(request: IncomingMessage, response: ServerResponse, handler: (request: SpecDialogueHttpRequest) => Promise<SpecDialogueHttpResponse>) {
  try {
    const rawBody = await readBody(request);
    send(response, await handler({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, socket: request.socket, rawBody }));
  } catch (error) { send(response, failure(error instanceof BodyLimitError ? 413 : 500, error instanceof BodyLimitError ? "SPEC_DIALOGUE_REQUEST_TOO_LARGE" : "SPEC_DIALOGUE_UNAVAILABLE")); }
}
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    request.on("data", (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.byteLength; if (bytes <= MAX_BODY_BYTES) chunks.push(value); });
    request.once("end", () => bytes > MAX_BODY_BYTES ? reject(new BodyLimitError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject); request.once("aborted", () => reject(new Error("aborted")));
  });
}
function send(response: ServerResponse, result: SpecDialogueHttpResponse): void {
  const body = JSON.stringify(result.body); response.statusCode = result.status;
  response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("content-length", Buffer.byteLength(body)); response.end(body);
}
function contentType(value: string | readonly string[] | undefined): string | null { return typeof value === "string" ? value.toLowerCase().split(";", 1)[0]?.trim() ?? null : null; }
function failure(status: number, code: string): SpecDialogueHttpResponse { return { status, body: { error: { code } } }; }
class BodyLimitError extends Error {}
