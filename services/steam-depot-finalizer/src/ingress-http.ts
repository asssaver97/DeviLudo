import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import { STEAM_DEPOT_SIGNING_SCHEMES, parseSteamDepotFinalizationRequest } from "./contract";
import { SteamDepotFinalizationBusyError, type DurableSteamDepotFinalizerService } from "./service";

const MAX_BODY_BYTES = 64 * 1024;

export interface SteamDepotFinalizerIngressRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface SteamDepotFinalizerIngressResponse {
  readonly status: number;
  readonly body: unknown;
}

export function createSteamDepotFinalizerHandler(options: Readonly<{
  service: Pick<DurableSteamDepotFinalizerService, "finalize" | "probe">;
  allowedSpiffeIds: ReadonlySet<string>;
  supportedSchemes?: readonly string[];
  extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}>): (request: SteamDepotFinalizerIngressRequest) => Promise<SteamDepotFinalizerIngressResponse> {
  if (!options.allowedSpiffeIds.size) invalidConfig();
  const supportedSchemes = normalizeSchemes(options.supportedSchemes ?? STEAM_DEPOT_SIGNING_SCHEMES);
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request) => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "STEAM_DEPOT_FINALIZER_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) {
      return failure(403, "STEAM_DEPOT_FINALIZER_WORKLOAD_FORBIDDEN");
    }
    if (request.method !== "POST") return failure(404, "STEAM_DEPOT_FINALIZER_ROUTE_NOT_FOUND");
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "STEAM_DEPOT_FINALIZER_JSON_REQUIRED");
    }
    let body: unknown;
    try { body = JSON.parse(request.rawBody) as unknown; }
    catch { return failure(400, "STEAM_DEPOT_FINALIZER_REQUEST_INVALID"); }
    if (request.path === "/healthz") {
      if (!emptyObject(body)) return failure(400, "STEAM_DEPOT_FINALIZER_REQUEST_INVALID");
      try { await options.service.probe(); }
      catch { return failure(503, "STEAM_DEPOT_FINALIZER_NOT_READY"); }
      return {
        status: 200,
        body: Object.freeze({
          schemaVersion: "deviludo.steam-depot-finalizer-health.v1",
          status: "ok",
          service: "deviludo-steam-depot-finalizer",
          supportedSchemes,
        }),
      };
    }
    if (request.path !== "/v1/steam-depots/finalize") {
      return failure(404, "STEAM_DEPOT_FINALIZER_ROUTE_NOT_FOUND");
    }
    let parsed;
    try { parsed = parseSteamDepotFinalizationRequest(body); }
    catch { return failure(400, "STEAM_DEPOT_FINALIZER_REQUEST_INVALID"); }
    try {
      return { status: 200, body: await options.service.finalize(parsed) };
    } catch (error) {
      if (error instanceof SteamDepotFinalizationBusyError) {
        return failure(503, "STEAM_DEPOT_FINALIZER_OPERATION_BUSY");
      }
      return failure(503, "STEAM_DEPOT_FINALIZER_EXECUTION_FAILED");
    }
  };
}

export function createSteamDepotFinalizerHttpsServer(options: Readonly<{
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: (request: SteamDepotFinalizerIngressRequest) => Promise<SteamDepotFinalizerIngressResponse>;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}>): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) invalidConfig();
  const maximum = integer(options.maxBodyBytes ?? MAX_BODY_BYTES, 4 * 1024, MAX_BODY_BYTES);
  const timeout = integer(options.requestTimeoutMs ?? 60 * 60_000, 1_000, 60 * 60_000);
  return createServer({
    key: options.tls.key,
    cert: options.tls.cert,
    ca: options.tls.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  }, (request, response) => { void handleNodeRequest(request, response, options.handler, maximum); })
    .setTimeout(timeout);
}

async function handleNodeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: SteamDepotFinalizerIngressRequest) => Promise<SteamDepotFinalizerIngressResponse>,
  maximum: number,
): Promise<void> {
  try {
    const rawBody = await readBody(request, maximum);
    const url = new URL(request.url ?? "/", "https://steam-depot-finalizer.invalid");
    if (url.search) throw new Error("query is forbidden");
    send(response, await handler({
      method: request.method ?? "",
      path: url.pathname,
      headers: request.headers,
      socket: request.socket,
      rawBody,
    }));
  } catch {
    send(response, failure(400, "STEAM_DEPOT_FINALIZER_REQUEST_INVALID"));
  }
}

function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maximum) { reject(new Error("request too large")); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on("end", () => accept(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, result: SteamDepotFinalizerIngressResponse): void {
  const body = JSON.stringify(result.body);
  response.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function emptyObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function contentType(value: string | readonly string[] | undefined): string {
  const selected = Array.isArray(value) ? value[0] : value;
  return typeof selected === "string" ? selected.split(";", 1)[0]!.trim().toLowerCase() : "";
}

function failure(status: number, code: string): SteamDepotFinalizerIngressResponse {
  return { status, body: Object.freeze({ error: Object.freeze({ code }) }) };
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalidConfig();
  return value;
}

function normalizeSchemes(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > STEAM_DEPOT_SIGNING_SCHEMES.length
    || value.some((scheme) => !STEAM_DEPOT_SIGNING_SCHEMES.includes(scheme as typeof STEAM_DEPOT_SIGNING_SCHEMES[number]))
    || new Set(value).size !== value.length || JSON.stringify(value) !== JSON.stringify([...value].sort())) invalidConfig();
  return Object.freeze([...value]);
}

function invalidConfig(): never { throw new Error("Steam depot finalizer ingress configuration is invalid"); }
