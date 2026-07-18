import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import type { EvidenceArchiveWorkloadIdentity } from "./contracts";
import type { EvidenceArchiveService } from "./archive";
import type { RunnerArtifactGrantService } from "./runner-artifacts";

const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface EvidenceArchiveHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface EvidenceArchiveHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function createEvidenceArchiveHandler(options: {
  readonly archive: Pick<EvidenceArchiveService, "persist" | "probe">;
  readonly allowedSpiffeIds: ReadonlySet<string>;
  readonly runnerArtifacts?: Pick<RunnerArtifactGrantService, "grant" | "commit">;
  readonly extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}): (request: EvidenceArchiveHttpRequest) => Promise<EvidenceArchiveHttpResponse> {
  if (!options.allowedSpiffeIds.size) throw new Error("Evidence archive workload allow-list is empty");
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request) => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "EVIDENCE_ARCHIVE_MTLS_IDENTITY_REQUIRED"); }
    if (request.method === "GET" && request.path === "/healthz") {
      if (!options.allowedSpiffeIds.has(identity.spiffeId)) {
        return failure(403, "EVIDENCE_ARCHIVE_WORKLOAD_FORBIDDEN");
      }
      try { await options.archive.probe(); }
      catch { return failure(503, "EVIDENCE_ARCHIVE_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-evidence-archive" } };
    }
    if (request.method === "POST" && request.path === "/v1/runner-artifact-grants") {
      if (!options.runnerArtifacts) return failure(404, "EVIDENCE_ARCHIVE_ROUTE_NOT_FOUND");
      if (contentType(request.headers["content-type"]) !== "application/json") {
        return failure(415, "EVIDENCE_ARCHIVE_JSON_REQUIRED");
      }
      try {
        return { status: 200, body: await options.runnerArtifacts.grant(identity, parseJsonObject(request.rawBody)) };
      } catch {
        return failure(409, "RUNNER_ARTIFACT_GRANT_REJECTED");
      }
    }
    if (request.method === "POST" && request.path === "/v1/runner-artifact-commits") {
      if (!options.runnerArtifacts) return failure(404, "EVIDENCE_ARCHIVE_ROUTE_NOT_FOUND");
      if (contentType(request.headers["content-type"]) !== "application/json") {
        return failure(415, "EVIDENCE_ARCHIVE_JSON_REQUIRED");
      }
      try {
        return { status: 200, body: await options.runnerArtifacts.commit(identity, parseJsonObject(request.rawBody)) };
      } catch {
        return failure(409, "RUNNER_ARTIFACT_COMMIT_REJECTED");
      }
    }
    if (request.method !== "POST" || request.path !== "/v1/runner-evidence") {
      return failure(404, "EVIDENCE_ARCHIVE_ROUTE_NOT_FOUND");
    }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) {
      return failure(403, "EVIDENCE_ARCHIVE_WORKLOAD_FORBIDDEN");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "EVIDENCE_ARCHIVE_JSON_REQUIRED");
    }
    const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
    const claimedDigest = singleHeader(request.headers["x-deviludo-bundle-digest"]);
    if (!idempotencyKey || !claimedDigest || idempotencyKey !== claimedDigest || !SHA256.test(claimedDigest)) {
      return failure(400, "EVIDENCE_ARCHIVE_BINDING_REQUIRED");
    }
    let body: Record<string, unknown>;
    try { body = parseJsonObject(request.rawBody); }
    catch { return failure(400, "EVIDENCE_ARCHIVE_REQUEST_INVALID"); }
    if (body.bundleDigest !== claimedDigest) {
      return failure(400, "EVIDENCE_ARCHIVE_REQUEST_INVALID");
    }
    try {
      const result = await options.archive.persist(body);
      return { status: result.created ? 201 : 200, body: result.receipt as unknown as Readonly<Record<string, unknown>> };
    } catch {
      return failure(409, "EVIDENCE_ARCHIVE_REQUEST_REJECTED");
    }
  };
}

export function createEvidenceArchiveHttpsServer(options: {
  readonly tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  readonly handler: (request: EvidenceArchiveHttpRequest) => Promise<EvidenceArchiveHttpResponse>;
  readonly maxBodyBytes?: number;
}): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) {
    throw new Error("Evidence archive TLS material is incomplete");
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > DEFAULT_MAX_BODY_BYTES) {
    throw new Error("Evidence archive body limit is invalid");
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

export function evidenceArchiveIdentityFromTlsSocket(socket: unknown): EvidenceArchiveWorkloadIdentity {
  if (!(socket instanceof TLSSocket) || !socket.authorized) {
    throw new Error("Evidence archive requires an authorized mutual-TLS socket");
  }
  const peer = socket.getPeerCertificate(false);
  const certificateFingerprint = String(peer.fingerprint256 ?? "").replaceAll(":", "").toLowerCase();
  if (!SHA256.test(certificateFingerprint) || !peer.serialNumber) {
    throw new Error("Evidence archive workload certificate is invalid");
  }
  const certificateNotAfter = new Date(peer.valid_to).toISOString();
  if (!Number.isFinite(Date.parse(certificateNotAfter)) || Date.parse(certificateNotAfter) <= Date.now()) {
    throw new Error("Evidence archive workload certificate is expired");
  }
  return Object.freeze({
    spiffeId: parseSpiffeId(peer.subjectaltname ?? ""),
    certificateFingerprint,
    certificateSerial: peer.serialNumber.toLowerCase(),
    certificateNotAfter,
  });
}

function parseSpiffeId(subjectAlternativeName: string): string {
  const spiffe = subjectAlternativeName.split(/,\s*/)
    .filter((value) => value.startsWith("URI:spiffe://"))
    .map((value) => value.slice(4));
  if (spiffe.length !== 1) throw new Error("Evidence archive certificate must contain one SPIFFE URI");
  const url = new URL(spiffe[0]!);
  if (url.protocol !== "spiffe:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Evidence archive SPIFFE identity is invalid");
  }
  return url.toString();
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: EvidenceArchiveHttpRequest) => Promise<EvidenceArchiveHttpResponse>,
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
      ? failure(413, "EVIDENCE_ARCHIVE_REQUEST_TOO_LARGE")
      : failure(500, "EVIDENCE_ARCHIVE_UNAVAILABLE"));
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
    request.once("aborted", () => reject(new Error("Evidence archive request was aborted")));
  });
}

function send(response: ServerResponse, result: EvidenceArchiveHttpResponse): void {
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
  return typeof value === "string" ? value : null;
}

function failure(status: number, code: string): EvidenceArchiveHttpResponse {
  return { status, body: { error: { code } } };
}

class BodyTooLargeError extends Error {}

function parseJsonObject(value: string): Record<string, unknown> {
  const body = JSON.parse(value) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON object required");
  return body as Record<string, unknown>;
}
