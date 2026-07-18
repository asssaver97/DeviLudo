import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import type { SteamCleanInstallPreparationService } from "./clean-install-preparation";

const MAX_BODY_BYTES = 32 * 1024;

export interface SteamCleanInstallPreparationHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface SteamCleanInstallPreparationHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function createSteamCleanInstallPreparationHandler(options: {
  readonly service: Pick<SteamCleanInstallPreparationService, "prepare" | "probe">;
  readonly allowedSpiffeIds: ReadonlySet<string>;
  readonly extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}): (request: SteamCleanInstallPreparationHttpRequest) => Promise<SteamCleanInstallPreparationHttpResponse> {
  if (!options.allowedSpiffeIds.size) throw new Error("Steam clean-install workload allow-list is empty");
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request) => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "STEAM_CLEAN_INSTALL_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) {
      return failure(403, "STEAM_CLEAN_INSTALL_WORKLOAD_FORBIDDEN");
    }
    if (request.method === "GET" && request.path === "/healthz") {
      try { await options.service.probe(); }
      catch { return failure(503, "STEAM_CLEAN_INSTALL_PREPARER_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-steam-clean-install-preparer" } };
    }
    if (request.method !== "POST" || request.path !== "/v1/clean-install-execution-preparations") {
      return failure(404, "STEAM_CLEAN_INSTALL_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "STEAM_CLEAN_INSTALL_JSON_REQUIRED");
    }
    let body: Record<string, unknown>;
    try { body = parseJsonObject(request.rawBody); }
    catch { return failure(400, "STEAM_CLEAN_INSTALL_REQUEST_INVALID"); }
    try {
      const receipt = await options.service.prepare(identity, body);
      return {
        status: 200,
        body: { schemaVersion: "deviludo.steam-clean-install-preparation-receipt.v1", ...receipt },
      };
    } catch {
      return failure(409, "STEAM_CLEAN_INSTALL_PREPARATION_REJECTED");
    }
  };
}

export function createSteamCleanInstallPreparationHttpsServer(options: {
  readonly tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  readonly handler: (request: SteamCleanInstallPreparationHttpRequest) => Promise<SteamCleanInstallPreparationHttpResponse>;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
}): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) {
    throw new Error("Steam clean-install TLS material is incomplete");
  }
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > MAX_BODY_BYTES) {
    throw new Error("Steam clean-install body limit is invalid");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 10 * 60_000) {
    throw new Error("Steam clean-install request timeout is invalid");
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
  handler: (request: SteamCleanInstallPreparationHttpRequest) => Promise<SteamCleanInstallPreparationHttpResponse>,
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
      ? failure(413, "STEAM_CLEAN_INSTALL_REQUEST_TOO_LARGE")
      : failure(500, "STEAM_CLEAN_INSTALL_PREPARER_UNAVAILABLE"));
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
    request.once("aborted", () => reject(new Error("Steam clean-install request was aborted")));
  });
}

function send(response: ServerResponse, result: SteamCleanInstallPreparationHttpResponse): void {
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

function failure(status: number, code: string): SteamCleanInstallPreparationHttpResponse {
  return { status, body: { error: { code } } };
}

class BodyTooLargeError extends Error {}
