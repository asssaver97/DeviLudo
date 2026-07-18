import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { TargetPlatform } from "../../../lib/domain/types";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import type { SteamClientConnectorService } from "./connector";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface SteamClientConnectorHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface SteamClientConnectorHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface SteamClientConnectorHealthIdentity {
  readonly runnerId: string;
  readonly platform: TargetPlatform;
  readonly version: string;
  readonly bridgeVersion: string;
  readonly controllerContractVersion: 1;
  readonly binaryDigest: string;
  readonly automationPolicyDigest: string;
  readonly supplyChainEvidenceDigest: string;
}

export function createSteamClientConnectorHandler(options: Readonly<{
  service: Pick<SteamClientConnectorService, "execute" | "probe">;
  allowedSpiffeIds: ReadonlySet<string>;
  healthIdentity: SteamClientConnectorHealthIdentity;
  extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}>): (request: SteamClientConnectorHttpRequest) => Promise<SteamClientConnectorHttpResponse> {
  if (!options.allowedSpiffeIds.size) throw new Error("Steam Client Connector workload allow-list is empty");
  validateHealthIdentity(options.healthIdentity);
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request) => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "STEAM_CLIENT_CONNECTOR_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) return failure(403, "STEAM_CLIENT_CONNECTOR_WORKLOAD_FORBIDDEN");
    if (request.method === "GET" && request.path === "/healthz") {
      try { await options.service.probe(); }
      catch { return failure(503, "STEAM_CLIENT_CONNECTOR_NOT_READY"); }
      return {
        status: 200,
        body: {
          schemaVersion: "deviludo.steam-client-connector-health.v2",
          status: "ok",
          service: "deviludo-steam-client-connector",
          ...options.healthIdentity,
        },
      };
    }
    if (request.method !== "POST" || request.path !== "/v1/clean-install-executions") {
      return failure(404, "STEAM_CLIENT_CONNECTOR_ROUTE_NOT_FOUND");
    }
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "STEAM_CLIENT_CONNECTOR_JSON_REQUIRED");
    }
    try {
      const receipt = await options.service.execute(parseJsonObject(request.rawBody));
      return { status: 200, body: receipt as unknown as Readonly<Record<string, unknown>> };
    } catch {
      return failure(409, "STEAM_CLIENT_CONNECTOR_EXECUTION_REJECTED");
    }
  };
}

function validateHealthIdentity(value: SteamClientConnectorHealthIdentity): void {
  const keys = Object.keys(value).sort();
  const expected = ["runnerId", "platform", "version", "bridgeVersion", "controllerContractVersion",
    "binaryDigest", "automationPolicyDigest", "supplyChainEvidenceDigest"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(value.runnerId)
    || !["windows", "linux", "macos"].includes(value.platform)
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/.test(value.version)
    || /(?:latest|stable|default)/i.test(value.version)
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/.test(value.bridgeVersion)
    || /(?:latest|stable|default)/i.test(value.bridgeVersion) || value.controllerContractVersion !== 1
    || ![value.binaryDigest, value.automationPolicyDigest, value.supplyChainEvidenceDigest]
      .every((digest) => /^[a-f0-9]{64}$/.test(digest))) {
    throw new Error("Steam Client Connector health identity is invalid");
  }
}

export function createSteamClientConnectorHttpsServer(options: Readonly<{
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: (request: SteamClientConnectorHttpRequest) => Promise<SteamClientConnectorHttpResponse>;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}>): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("Steam Client Connector TLS material is incomplete");
  const maximum = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isInteger(maximum) || maximum < 4 * 1024 * 1024 || maximum > MAX_BODY_BYTES) {
    throw new Error("Steam Client Connector body limit is invalid");
  }
  const timeout = options.requestTimeoutMs ?? 55 * 60_000;
  if (!Number.isInteger(timeout) || timeout < 30_000 || timeout > 60 * 60_000) {
    throw new Error("Steam Client Connector timeout is invalid");
  }
  const server = createServer({
    ...options.tls,
    minVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, response) => { void dispatch(request, response, options.handler, maximum); });
  server.requestTimeout = timeout;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: SteamClientConnectorHttpRequest) => Promise<SteamClientConnectorHttpResponse>,
  maximum: number,
): Promise<void> {
  try {
    const rawBody = await readBody(request, maximum);
    send(response, await handler({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      socket: request.socket,
      rawBody,
    }));
  } catch (error) {
    send(response, error instanceof BodyTooLargeError
      ? failure(413, "STEAM_CLIENT_CONNECTOR_REQUEST_TOO_LARGE")
      : failure(500, "STEAM_CLIENT_CONNECTOR_UNAVAILABLE"));
  }
}

function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > maximum) { tooLarge = true; return; }
      chunks.push(value);
    });
    request.once("end", () => tooLarge ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("Steam Client Connector request was aborted")));
  });
}

function send(response: ServerResponse, result: SteamClientConnectorHttpResponse): void {
  const body = JSON.stringify(result.body);
  response.statusCode = result.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed as Record<string, unknown>;
}

function contentType(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase().split(";", 1)[0]?.trim() ?? null : null;
}

function failure(status: number, code: string): SteamClientConnectorHttpResponse {
  return { status, body: { error: { code } } };
}

class BodyTooLargeError extends Error {}
