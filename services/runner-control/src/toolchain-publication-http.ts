import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { TlsRunnerIdentity } from "./contracts";
import { identityFromTlsSocket } from "./tls-identity";
import {
  parseRunnerToolchainPublication,
  RunnerToolchainPublicationConflict,
  type PostgresRunnerToolchainPublisher,
} from "./toolchain-publication";

const MAX_BODY_BYTES = 64 * 1024;

export interface RunnerToolchainPublicationRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface RunnerToolchainPublicationResponse {
  readonly status: number;
  readonly body: unknown;
}

export function createRunnerToolchainPublicationHandler(options: Readonly<{
  publisher: Pick<PostgresRunnerToolchainPublisher, "publish" | "probe">;
  allowedSpiffeIds: ReadonlySet<string>;
  now?: () => Date;
  extractIdentity?: (socket: unknown) => TlsRunnerIdentity;
  readiness?: () => Promise<void>;
}>): (request: RunnerToolchainPublicationRequest) => Promise<RunnerToolchainPublicationResponse> {
  if (!options.allowedSpiffeIds.size) throw new Error("Runner toolchain publisher allow-list is empty");
  const now = options.now ?? (() => new Date());
  const extractIdentity = options.extractIdentity ?? identityFromTlsSocket;
  return async (request) => {
    let identity: TlsRunnerIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "RUNNER_TOOLCHAIN_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) {
      return failure(403, "RUNNER_TOOLCHAIN_PUBLISHER_FORBIDDEN");
    }
    if (request.method !== "POST") return failure(404, "RUNNER_TOOLCHAIN_ROUTE_NOT_FOUND");
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return failure(415, "RUNNER_TOOLCHAIN_JSON_REQUIRED");
    }
    let body: unknown;
    try { body = JSON.parse(request.rawBody) as unknown; }
    catch { return failure(400, "RUNNER_TOOLCHAIN_PUBLICATION_INVALID"); }
    if (request.path === "/healthz") {
      if (!emptyObject(body)) return failure(400, "RUNNER_TOOLCHAIN_PUBLICATION_INVALID");
      try {
        if (options.readiness) await options.readiness();
        else await options.publisher.probe();
      }
      catch { return failure(503, "RUNNER_TOOLCHAIN_PUBLISHER_NOT_READY"); }
      return { status: 200, body: Object.freeze({
        schemaVersion: "deviludo.runner-toolchain-publisher-health.v1",
        status: "ok",
        service: "deviludo-runner-toolchain-publisher",
      }) };
    }
    if (request.path !== "/v1/runner-toolchains") return failure(404, "RUNNER_TOOLCHAIN_ROUTE_NOT_FOUND");
    let publication;
    try { publication = parseRunnerToolchainPublication(body, now()); }
    catch { return failure(400, "RUNNER_TOOLCHAIN_PUBLICATION_INVALID"); }
    try {
      return { status: 201, body: await options.publisher.publish(identity, publication) };
    } catch (error) {
      if (error instanceof RunnerToolchainPublicationConflict) {
        return failure(409, error.code);
      }
      return failure(503, "RUNNER_TOOLCHAIN_PUBLICATION_FAILED");
    }
  };
}

export function createRunnerToolchainPublicationHttpsServer(options: Readonly<{
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: (request: RunnerToolchainPublicationRequest) => Promise<RunnerToolchainPublicationResponse>;
  maxBodyBytes?: number;
}>): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) {
    throw new Error("Runner toolchain publisher TLS material is incomplete");
  }
  const maximum = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 4 * 1024 || maximum > MAX_BODY_BYTES) {
    throw new Error("Runner toolchain publisher body limit is invalid");
  }
  const server = createServer({
    key: options.tls.key,
    cert: options.tls.cert,
    ca: options.tls.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  }, (request, response) => { void dispatch(request, response, options.handler, maximum); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: RunnerToolchainPublicationRequest) => Promise<RunnerToolchainPublicationResponse>,
  maximum: number,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "https://runner-toolchain.invalid");
    if (url.search || url.hash) throw new Error("query is forbidden");
    const result = await handler({
      method: request.method ?? "",
      path: url.pathname,
      headers: request.headers,
      socket: request.socket,
      rawBody: await readBody(request, maximum),
    });
    send(response, result);
  } catch {
    send(response, failure(400, "RUNNER_TOOLCHAIN_PUBLICATION_INVALID"));
  }
}

function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    request.on("data", (chunk: Buffer | string) => {
      if (finished) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size > maximum) { fail(new Error("request too large")); request.destroy(); }
      else chunks.push(value);
    });
    request.once("end", () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", fail);
    request.once("aborted", () => fail(new Error("request aborted")));
  });
}

function send(response: ServerResponse, result: RunnerToolchainPublicationResponse): void {
  const body = JSON.stringify(result.body);
  response.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
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
function failure(status: number, code: string): RunnerToolchainPublicationResponse {
  return { status, body: Object.freeze({ error: Object.freeze({ code }) }) };
}
