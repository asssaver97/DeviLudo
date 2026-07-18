import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import type { ArtifactPreparationService } from "./service";

const MAX_BODY_BYTES = 64 * 1024;

export interface ArtifactPreparationHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface ArtifactPreparationHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function createArtifactPreparationHandler(options: {
  readonly service: Pick<ArtifactPreparationService, "prepare" | "probe">;
  readonly allowedSpiffeIds: ReadonlySet<string>;
  readonly extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}): (request: ArtifactPreparationHttpRequest) => Promise<ArtifactPreparationHttpResponse> {
  if (!options.allowedSpiffeIds.size) throw new Error("Artifact Preparer workload allow-list is empty");
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request) => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "ARTIFACT_PREPARER_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) {
      return failure(403, "ARTIFACT_PREPARER_WORKLOAD_FORBIDDEN");
    }
    if (request.method === "GET" && request.path === "/healthz") {
      try { await options.service.probe(); }
      catch { return failure(503, "ARTIFACT_PREPARER_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-artifact-preparer" } };
    }
    if (request.method !== "POST" || request.path !== "/v1/source-execution-preparations") {
      return failure(404, "ARTIFACT_PREPARER_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "ARTIFACT_PREPARER_JSON_REQUIRED");
    }
    let body: Record<string, unknown>;
    try { body = parseJsonObject(request.rawBody); }
    catch { return failure(400, "ARTIFACT_PREPARER_REQUEST_INVALID"); }
    try {
      const receipt = await options.service.prepare(identity, body);
      return {
        status: 200,
        body: { schemaVersion: "deviludo.source-execution-preparation-receipt.v1", ...receipt },
      };
    } catch {
      return failure(409, "ARTIFACT_PREPARATION_REJECTED");
    }
  };
}

export function createArtifactPreparationHttpsServer(options: {
  readonly tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  readonly handler: (request: ArtifactPreparationHttpRequest) => Promise<ArtifactPreparationHttpResponse>;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
}): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) {
    throw new Error("Artifact Preparer TLS material is incomplete");
  }
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > MAX_BODY_BYTES) {
    throw new Error("Artifact Preparer body limit is invalid");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 24 * 60 * 60_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 30_000 || requestTimeoutMs > 24 * 60 * 60_000) {
    throw new Error("Artifact Preparer request timeout is invalid");
  }
  const server = createServer({
    ...options.tls,
    minVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, response) => { void dispatch(request, response, options.handler, maxBodyBytes); });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: ArtifactPreparationHttpRequest) => Promise<ArtifactPreparationHttpResponse>,
  maxBodyBytes: number,
): Promise<void> {
  try {
    const rawBody = await readBody(request, maxBodyBytes);
    send(response, await handler({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      socket: request.socket,
      rawBody,
    }));
  } catch (error) {
    send(response, error instanceof BodyTooLargeError
      ? failure(413, "ARTIFACT_PREPARER_REQUEST_TOO_LARGE")
      : failure(500, "ARTIFACT_PREPARER_UNAVAILABLE"));
  }
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > limit) { tooLarge = true; return; }
      chunks.push(value);
    });
    request.once("end", () => tooLarge ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("Artifact Preparer request was aborted")));
  });
}

function send(response: ServerResponse, result: ArtifactPreparationHttpResponse): void {
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

function parseJsonObject(value: string): Record<string, unknown> {
  const body = JSON.parse(value) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON object required");
  return body as Record<string, unknown>;
}

function failure(status: number, code: string): ArtifactPreparationHttpResponse {
  return { status, body: { error: { code } } };
}

class BodyTooLargeError extends Error {}
