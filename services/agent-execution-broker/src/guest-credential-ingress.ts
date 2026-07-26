import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import { parseAgentMicrovmCredentialImageRequest } from "./guest-credential-contracts";
import type { AgentMicrovmCredentialIssuerService } from "./guest-credential-service";

const MAX_BODY_BYTES = 32 * 1024;

export interface GuestCredentialIssuerHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}
export type GuestCredentialIssuerHttpResponse = Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>> | Buffer;
}>;

export function createGuestCredentialIssuerHandler(options: Readonly<{
  service: Pick<AgentMicrovmCredentialIssuerService, "issue" | "probe">;
  allowedSpiffeIds: ReadonlySet<string>;
  extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}>): (request: GuestCredentialIssuerHttpRequest) => Promise<GuestCredentialIssuerHttpResponse> {
  if (options.allowedSpiffeIds.size !== 1) throw new Error("Agent credential issuer workload allow-list is invalid");
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request) => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "AGENT_CREDENTIAL_ISSUER_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) return failure(403, "AGENT_CREDENTIAL_ISSUER_WORKLOAD_FORBIDDEN");
    if (request.method === "GET" && request.path === "/healthz") {
      try { await options.service.probe(); }
      catch { return failure(503, "AGENT_CREDENTIAL_ISSUER_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-agent-microvm-credential-issuer" } };
    }
    if (request.method !== "POST" || request.path !== "/v1/agent-microvm-credentials:issue") {
      return failure(404, "AGENT_CREDENTIAL_ISSUER_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "AGENT_CREDENTIAL_ISSUER_JSON_REQUIRED");
    }
    let body: ReturnType<typeof parseAgentMicrovmCredentialImageRequest>;
    try { body = parseAgentMicrovmCredentialImageRequest(JSON.parse(request.rawBody) as unknown); }
    catch { return failure(400, "AGENT_CREDENTIAL_ISSUER_REQUEST_INVALID"); }
    if (single(request.headers["x-deviludo-run-id"]) !== body.runId
      || single(request.headers["x-deviludo-attempt-id"]) !== body.attemptId) {
      return failure(400, "AGENT_CREDENTIAL_ISSUER_REQUEST_INVALID");
    }
    try {
      const issued = await options.service.issue(identity, body);
      return Object.freeze({ status: 200, headers: Object.freeze({
        "x-deviludo-content-sha256": issued.credentialImage.digest,
        "x-deviludo-run-id": issued.request.runId,
        "x-deviludo-attempt-id": issued.request.attemptId,
        "x-deviludo-expires-at": issued.request.expiresAt,
      }), body: issued.credentialImage.image });
    } catch { return failure(409, "AGENT_CREDENTIAL_ISSUANCE_REJECTED"); }
  };
}

export function createGuestCredentialIssuerHttpsServer(options: Readonly<{
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: (request: GuestCredentialIssuerHttpRequest) => Promise<GuestCredentialIssuerHttpResponse>;
  requestTimeoutMs?: number;
}>): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("Agent credential issuer TLS material is incomplete");
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 5_000 || requestTimeoutMs > 120_000) {
    throw new Error("Agent credential issuer timeout is invalid");
  }
  const server = createServer({ ...options.tls, minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true },
    (request, response) => { void dispatch(request, response, options.handler); });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  return server;
}

async function dispatch(request: IncomingMessage, response: ServerResponse,
  handler: (request: GuestCredentialIssuerHttpRequest) => Promise<GuestCredentialIssuerHttpResponse>): Promise<void> {
  try {
    const rawBody = await readBody(request);
    send(response, await handler({ method: request.method ?? "", path: request.url ?? "",
      headers: request.headers, socket: request.socket, rawBody }));
  } catch (error) {
    send(response, error instanceof BodyTooLargeError
      ? failure(413, "AGENT_CREDENTIAL_ISSUER_REQUEST_TOO_LARGE")
      : failure(500, "AGENT_CREDENTIAL_ISSUER_UNAVAILABLE"));
  }
}
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((accept, reject) => { const chunks: Buffer[] = []; let bytes = 0; let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength; if (bytes > MAX_BODY_BYTES) tooLarge = true; else chunks.push(value); });
    request.once("end", () => tooLarge ? reject(new BodyTooLargeError()) : accept(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject); request.once("aborted", () => reject(new Error("request aborted"))); });
}
function send(response: ServerResponse, result: GuestCredentialIssuerHttpResponse): void {
  const binary = Buffer.isBuffer(result.body);
  const body = binary ? result.body : Buffer.from(JSON.stringify(result.body));
  response.statusCode = result.status;
  response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-type", binary ? "application/octet-stream" : "application/json; charset=utf-8");
  response.setHeader("content-length", body.byteLength);
  for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
  let wiped = false; const wipe = () => { if (binary && !wiped) { wiped = true; body.fill(0); } };
  response.once("close", wipe); response.end(body, wipe);
}
function contentType(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase().split(";", 1)[0]?.trim() ?? null : null;
}
function single(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function failure(status: number, code: string): GuestCredentialIssuerHttpResponse {
  return Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code }) }) });
}
class BodyTooLargeError extends Error {}
