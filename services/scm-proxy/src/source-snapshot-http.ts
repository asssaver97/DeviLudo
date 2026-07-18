import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import type { SourceSnapshotGrantService } from "./source-snapshot-service";

const MAX_BODY_BYTES = 64 * 1024;

export interface SourceSnapshotHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface SourceSnapshotHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function createSourceSnapshotHandler(options: {
  readonly sourceSnapshots: Pick<SourceSnapshotGrantService, "grant" | "probe">;
  readonly allowedSpiffeIds: ReadonlySet<string>;
  readonly extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}): (request: SourceSnapshotHttpRequest) => Promise<SourceSnapshotHttpResponse> {
  if (!options.allowedSpiffeIds.size) throw new Error("Source snapshot workload allow-list is empty");
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request) => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "SOURCE_SNAPSHOT_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) {
      return failure(403, "SOURCE_SNAPSHOT_WORKLOAD_FORBIDDEN");
    }
    if (request.method === "GET" && request.path === "/healthz") {
      try { await options.sourceSnapshots.probe(); }
      catch { return failure(503, "SOURCE_SNAPSHOT_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-source-snapshot" } };
    }
    if (request.method !== "POST" || request.path !== "/v1/source-snapshot-grants") {
      return failure(404, "SOURCE_SNAPSHOT_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "SOURCE_SNAPSHOT_JSON_REQUIRED");
    }
    let body: Record<string, unknown>;
    try { body = parseJsonObject(request.rawBody); }
    catch { return failure(400, "SOURCE_SNAPSHOT_REQUEST_INVALID"); }
    try {
      return { status: 200, body: await options.sourceSnapshots.grant(identity, body) };
    } catch {
      return failure(409, "SOURCE_SNAPSHOT_GRANT_REJECTED");
    }
  };
}

export function createSourceSnapshotHttpsServer(options: {
  readonly tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  readonly handler: (request: SourceSnapshotHttpRequest) => Promise<SourceSnapshotHttpResponse>;
  readonly maxBodyBytes?: number;
}): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) {
    throw new Error("Source snapshot TLS material is incomplete");
  }
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > MAX_BODY_BYTES) {
    throw new Error("Source snapshot body limit is invalid");
  }
  const server = createServer({
    ...options.tls,
    minVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, response) => { void dispatch(request, response, options.handler, maxBodyBytes); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: SourceSnapshotHttpRequest) => Promise<SourceSnapshotHttpResponse>,
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
      ? failure(413, "SOURCE_SNAPSHOT_REQUEST_TOO_LARGE")
      : failure(500, "SOURCE_SNAPSHOT_UNAVAILABLE"));
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
    request.once("aborted", () => reject(new Error("Source snapshot request was aborted")));
  });
}

function send(response: ServerResponse, result: SourceSnapshotHttpResponse): void {
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

function failure(status: number, code: string): SourceSnapshotHttpResponse {
  return { status, body: { error: { code } } };
}

class BodyTooLargeError extends Error {}
