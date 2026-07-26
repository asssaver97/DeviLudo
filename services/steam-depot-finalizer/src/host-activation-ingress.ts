import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import { identityFromTlsSocket } from "../../runner-control/src/tls-identity";
import {
  validateSteamDepotFinalizerHostActivationRequest,
  type SignedSteamDepotFinalizerHostActivationGrant,
  type SteamDepotFinalizerHostActuationReceipt,
  type SteamDepotFinalizerHostDrainReceipt,
} from "./host-activation";
import type {
  PostgresSteamDepotFinalizerHostActivations,
  SteamDepotFinalizerHostActivationIdentity,
} from "./postgres-host-activations";

const MAX_BODY_BYTES = 256 * 1024;

export interface SteamDepotFinalizerHostActivationHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface SteamDepotFinalizerHostActivationHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

type HostActivationAuthority = Pick<
  PostgresSteamDepotFinalizerHostActivations,
  "authorize" | "complete" | "probe"
>;

export function createSteamDepotFinalizerHostActivationHandler(options: Readonly<{
  authority: HostActivationAuthority;
  allowedHostSpiffeIds: ReadonlySet<string>;
  extractIdentity?: (socket: unknown) => SteamDepotFinalizerHostActivationIdentity;
}>): (request: SteamDepotFinalizerHostActivationHttpRequest) => Promise<SteamDepotFinalizerHostActivationHttpResponse> {
  if (!options.authority || typeof options.authority.authorize !== "function"
    || typeof options.authority.complete !== "function" || typeof options.authority.probe !== "function"
    || !options.allowedHostSpiffeIds.size) invalidConfig();
  const extractIdentity = options.extractIdentity ?? ((socket: unknown) => {
    const identity = identityFromTlsSocket(socket);
    return Object.freeze({
      spiffeId: identity.spiffeId,
      certificateFingerprint: identity.certificateFingerprint,
    });
  });
  return async (request) => {
    let identity: SteamDepotFinalizerHostActivationIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedHostSpiffeIds.has(identity.spiffeId)) {
      return failure(403, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_HOST_FORBIDDEN");
    }
    if (request.method === "GET" && request.path === "/healthz") {
      if (request.rawBody.length !== 0) return failure(400, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_REQUEST_INVALID");
      try { await options.authority.probe(); }
      catch { return failure(503, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_NOT_READY"); }
      return { status: 200, body: Object.freeze({
        schemaVersion: "deviludo.steam-depot-finalizer-host-activation-health.v1",
        status: "ok",
        service: "deviludo-steam-depot-finalizer-host-activation",
      }) };
    }
    if (request.method !== "POST") {
      return failure(404, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_JSON_REQUIRED");
    }
    let body: unknown;
    try { body = JSON.parse(request.rawBody) as unknown; }
    catch { return failure(400, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_REQUEST_INVALID"); }
    if (request.path === "/v1/steam-depot-finalizer-host-activations/authorize") {
      let activationRequest;
      try { activationRequest = validateSteamDepotFinalizerHostActivationRequest(body); }
      catch { return failure(400, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_REQUEST_INVALID"); }
      if (activationRequest.hostSpiffeId !== identity.spiffeId
        || activationRequest.hostCertificateFingerprint !== identity.certificateFingerprint) {
        return failure(403, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_IDENTITY_MISMATCH");
      }
      try {
        const result = await options.authority.authorize(identity, activationRequest);
        return { status: 200, body: activationResponse(result) };
      } catch {
        return failure(409, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_REJECTED");
      }
    }
    if (request.path === "/v1/steam-depot-finalizer-host-activations/complete") {
      let completion: { grant: unknown; receipt: unknown };
      try { completion = parseCompletion(body); }
      catch { return failure(400, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_REQUEST_INVALID"); }
      try {
        const receipt = await options.authority.complete(identity, completion.grant, completion.receipt);
        return { status: 200, body: completionResponse(receipt) };
      } catch {
        return failure(409, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_COMPLETION_REJECTED");
      }
    }
    return failure(404, "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_ROUTE_NOT_FOUND");
  };
}

export function createSteamDepotFinalizerHostActivationHttpsServer(options: Readonly<{
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: (request: SteamDepotFinalizerHostActivationHttpRequest) => Promise<SteamDepotFinalizerHostActivationHttpResponse>;
  maxBodyBytes?: number;
}>): HttpsServer {
  if (![options.tls.key, options.tls.cert, options.tls.ca].every((value) => Buffer.isBuffer(value)
    && value.byteLength >= 32 && value.byteLength <= 1024 * 1024)
    || typeof options.handler !== "function") invalidConfig();
  const maximum = integer(options.maxBodyBytes ?? MAX_BODY_BYTES, 4 * 1024, MAX_BODY_BYTES);
  const server = createServer({
    ...options.tls,
    minVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, response) => { void dispatch(request, response, options.handler, maximum); });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

function parseCompletion(value: unknown): { grant: unknown; receipt: unknown } {
  const body = record(value);
  exactKeys(body, ["grant", "receipt", "schemaVersion"]);
  if (body.schemaVersion !== "deviludo.steam-depot-finalizer-host-activation-completion.v1") invalidRequest();
  record(body.grant); record(body.receipt);
  return { grant: body.grant, receipt: body.receipt };
}

function activationResponse(
  result: SteamDepotFinalizerHostDrainReceipt | SignedSteamDepotFinalizerHostActivationGrant,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-response.v1",
    data: result,
  });
}

function completionResponse(receipt: SteamDepotFinalizerHostActuationReceipt): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-completion-response.v1",
    data: receipt,
  });
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: SteamDepotFinalizerHostActivationHttpRequest) => Promise<SteamDepotFinalizerHostActivationHttpResponse>,
  maximum: number,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "https://steam-depot-finalizer-host-activation.invalid");
    if (url.search || url.hash) throw new Error("query is forbidden");
    const rawBody = await readBody(request, maximum);
    send(response, await handler({
      method: request.method ?? "",
      path: url.pathname,
      headers: request.headers,
      socket: request.socket,
      rawBody,
    }));
  } catch (error) {
    send(response, failure(error instanceof BodyLimitError ? 413 : 400,
      error instanceof BodyLimitError
        ? "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_REQUEST_TOO_LARGE"
        : "STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_REQUEST_INVALID"));
  }
}

function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size <= maximum) chunks.push(value);
    });
    request.once("end", () => size > maximum
      ? reject(new BodyLimitError())
      : accept(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("request aborted")));
  });
}

function send(response: ServerResponse, result: SteamDepotFinalizerHostActivationHttpResponse): void {
  const body = JSON.stringify(result.body);
  response.statusCode = result.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRequest();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalidRequest();
}
function contentType(value: string | readonly string[] | undefined): string {
  const selected = Array.isArray(value) ? value[0] : value;
  return typeof selected === "string" ? selected.split(";", 1)[0]!.trim().toLowerCase() : "";
}
function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalidConfig();
  return value;
}
function failure(status: number, code: string): SteamDepotFinalizerHostActivationHttpResponse {
  return { status, body: Object.freeze({ error: Object.freeze({ code }) }) };
}
function invalidRequest(): never { throw new Error("Steam depot Finalizer host activation request is invalid"); }
function invalidConfig(): never { throw new Error("Steam depot Finalizer host activation ingress configuration is invalid"); }
class BodyLimitError extends Error {}
