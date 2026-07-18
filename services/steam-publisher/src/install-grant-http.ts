import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import type { SteamInstallGrantRedemptionService } from "./install-grant-redemption";

const MAX_BODY_BYTES = 1024 * 1024;

export function createSteamInstallGrantHandler(options: Readonly<{
  service: Pick<SteamInstallGrantRedemptionService, "redeem" | "probe">;
  extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}>) {
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request: Readonly<{
    method: string; path: string;
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    socket: unknown; rawBody: string;
  }>): Promise<Readonly<{ status: number; body: Readonly<Record<string, unknown>> }>> => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "STEAM_INSTALL_GRANT_MTLS_IDENTITY_REQUIRED"); }
    if (request.method === "GET" && request.path === "/healthz") {
      try { await options.service.probe(); }
      catch { return failure(503, "STEAM_INSTALL_GRANT_SERVICE_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-steam-install-grants" } };
    }
    if (request.method !== "POST" || request.path !== "/v1/steam-install-grant-redemptions") {
      return failure(404, "STEAM_INSTALL_GRANT_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") return failure(415, "STEAM_INSTALL_GRANT_JSON_REQUIRED");
    let body: Record<string, unknown>;
    try { body = jsonObject(request.rawBody); }
    catch { return failure(400, "STEAM_INSTALL_GRANT_REQUEST_INVALID"); }
    try { return { status: 200, body: await options.service.redeem(identity, body) }; }
    catch { return failure(409, "STEAM_INSTALL_GRANT_REDEMPTION_REJECTED"); }
  };
}

export function createSteamInstallGrantHttpsServer(options: Readonly<{
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: ReturnType<typeof createSteamInstallGrantHandler>;
  maxBodyBytes?: number;
}>): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("Steam install grant TLS material is incomplete");
  const maximum = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isInteger(maximum) || maximum < 1024 || maximum > MAX_BODY_BYTES) throw new Error("Steam install grant body limit is invalid");
  const server = createServer({ ...options.tls, minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true },
    (request, response) => { void dispatch(request, response, options.handler, maximum); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function dispatch(request: IncomingMessage, response: ServerResponse, handler: ReturnType<typeof createSteamInstallGrantHandler>, maximum: number) {
  try {
    const rawBody = await readBody(request, maximum);
    send(response, await handler({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, socket: request.socket, rawBody }));
  } catch (error) { send(response, error instanceof BodyTooLargeError ? failure(413, "STEAM_INSTALL_GRANT_REQUEST_TOO_LARGE") : failure(500, "STEAM_INSTALL_GRANT_UNAVAILABLE")); }
}

function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0; let large = false;
    request.on("data", (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.length; if (bytes > maximum) large = true; else chunks.push(value); });
    request.once("end", () => large ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject); request.once("aborted", () => reject(new Error("aborted")));
  });
}

function send(response: ServerResponse, result: Readonly<{ status: number; body: Readonly<Record<string, unknown>> }>) {
  const body = JSON.stringify(result.body); response.statusCode = result.status;
  response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("content-length", Buffer.byteLength(body)); response.end(body);
}
function contentType(value: string | readonly string[] | undefined) { return typeof value === "string" ? value.toLowerCase().split(";", 1)[0]?.trim() : null; }
function jsonObject(value: string) { const parsed = JSON.parse(value) as unknown; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object"); return parsed as Record<string, unknown>; }
function failure(status: number, code: string) { return { status, body: { error: { code } } }; }
class BodyTooLargeError extends Error {}
