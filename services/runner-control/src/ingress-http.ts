import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunnerEvent } from "../../../lib/domain/e2e";
import type {
  PlatformEvidenceManifest,
  RunnerCapabilities,
  RunnerNativeInstallAuthorizationRequest,
  SignedRunnerNativeInstallActivationGrant,
  TlsRunnerIdentity,
} from "./contracts";
import type { PostgresRunnerIngressStore } from "./postgres-ingress";
import { identityFromTlsSocket } from "./tls-identity";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface RunnerIngressRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface RunnerIngressResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>> | null;
}

export interface RunnerIngressOperations {
  register(identity: TlsRunnerIdentity, capabilities: RunnerCapabilities, at: string): ReturnType<PostgresRunnerIngressStore["register"]>;
  leaseNext(identity: TlsRunnerIdentity, runnerId: string, tenantId: string, at: string): ReturnType<PostgresRunnerIngressStore["leaseNext"]>;
  submitEvidence(identity: TlsRunnerIdentity, tenantId: string, manifest: PlatformEvidenceManifest, at: string): ReturnType<PostgresRunnerIngressStore["submitEvidence"]>;
  acceptEvent(identity: TlsRunnerIdentity, tenantId: string, event: RunnerEvent, at: string): ReturnType<PostgresRunnerIngressStore["acceptEvent"]>;
  authorizeNativeInstall(identity: TlsRunnerIdentity, request: RunnerNativeInstallAuthorizationRequest, at: string): ReturnType<PostgresRunnerIngressStore["authorizeNativeInstall"]>;
  completeNativeInstall(identity: TlsRunnerIdentity, grant: SignedRunnerNativeInstallActivationGrant, at: string): ReturnType<PostgresRunnerIngressStore["completeNativeInstall"]>;
  rollbackNativeInstall(identity: TlsRunnerIdentity, grant: SignedRunnerNativeInstallActivationGrant, failureEvidenceDigest: string, at: string): ReturnType<PostgresRunnerIngressStore["rollbackNativeInstall"]>;
}

export function createRunnerIngressHandler(options: {
  readonly operations: RunnerIngressOperations;
  readonly now?: () => Date;
  readonly extractIdentity?: (socket: unknown) => TlsRunnerIdentity;
  readonly readiness?: () => Promise<void>;
}): (request: RunnerIngressRequest) => Promise<RunnerIngressResponse> {
  const now = options.now ?? (() => new Date());
  const extractIdentity = options.extractIdentity ?? identityFromTlsSocket;
  return async (request) => {
    let identity: TlsRunnerIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return error(401, "RUNNER_MTLS_IDENTITY_REQUIRED"); }
    let at: string;
    try { at = now().toISOString(); }
    catch { return error(503, "RUNNER_INGRESS_CLOCK_INVALID"); }
    if (!Number.isFinite(Date.parse(at))) return error(503, "RUNNER_INGRESS_CLOCK_INVALID");
    if (request.method === "GET" && request.path === "/health") {
      try { if (options.readiness) await options.readiness(); }
      catch { return error(503, "RUNNER_INGRESS_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-runner-ingress" } };
    }
    if (request.method !== "POST") return error(404, "RUNNER_ROUTE_NOT_FOUND");
    const contentType = singleHeader(request.headers["content-type"]);
    if (contentType !== "application/json") return error(415, "RUNNER_JSON_REQUIRED");
    let body: Record<string, unknown>;
    try { body = parseBody(request.rawBody); }
    catch { return error(400, "RUNNER_REQUEST_INVALID"); }
    try {
      if (request.path === "/v1/register") {
        exactKeys(body, ["capabilities"]);
        const registered = await options.operations.register(identity, object(body.capabilities) as unknown as RunnerCapabilities, at);
        return { status: 200, body: { data: registered } };
      }
      if (request.path === "/v1/lease") {
        exactKeys(body, ["tenantId", "runnerId"]);
        const job = await options.operations.leaseNext(identity, string(body.runnerId), string(body.tenantId), at);
        return { status: 200, body: { data: job } };
      }
      if (request.path === "/v1/evidence") {
        exactKeys(body, ["tenantId", "manifest"]);
        const manifest = await options.operations.submitEvidence(
          identity, string(body.tenantId), object(body.manifest) as unknown as PlatformEvidenceManifest, at,
        );
        return { status: 200, body: { data: manifest } };
      }
      if (request.path === "/v1/events") {
        exactKeys(body, ["tenantId", "event"]);
        const receipt = await options.operations.acceptEvent(
          identity, string(body.tenantId), object(body.event) as unknown as RunnerEvent, at,
        );
        return { status: 200, body: { data: receipt } };
      }
      if (request.path === "/v1/native-install/authorize") {
        exactKeys(body, ["request"]);
        const result = await options.operations.authorizeNativeInstall(
          identity, object(body.request) as unknown as RunnerNativeInstallAuthorizationRequest, at,
        );
        return { status: 200, body: { data: result } };
      }
      if (request.path === "/v1/native-install/complete") {
        exactKeys(body, ["grant"]);
        const receipt = await options.operations.completeNativeInstall(
          identity, object(body.grant) as unknown as SignedRunnerNativeInstallActivationGrant, at,
        );
        return { status: 200, body: { data: receipt } };
      }
      if (request.path === "/v1/native-install/rollback") {
        exactKeys(body, ["failureEvidenceDigest", "grant"]);
        const receipt = await options.operations.rollbackNativeInstall(
          identity,
          object(body.grant) as unknown as SignedRunnerNativeInstallActivationGrant,
          string(body.failureEvidenceDigest),
          at,
        );
        return { status: 200, body: { data: receipt } };
      }
      return error(404, "RUNNER_ROUTE_NOT_FOUND");
    } catch {
      return error(409, "RUNNER_REQUEST_REJECTED");
    }
  };
}

export function createRunnerIngressHttpsServer(options: {
  readonly tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  readonly handler: (request: RunnerIngressRequest) => Promise<RunnerIngressResponse>;
  readonly maxBodyBytes?: number;
}): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("Runner ingress TLS material is incomplete");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 4 * 1024 * 1024) {
    throw new Error("Runner ingress body limit is invalid");
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
  handler: (request: RunnerIngressRequest) => Promise<RunnerIngressResponse>,
  maxBodyBytes: number,
): Promise<void> {
  try {
    const body = await readBody(request, maxBodyBytes);
    const result = await handler({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      socket: request.socket,
      rawBody: body,
    });
    send(response, result);
  } catch (caught) {
    send(response, caught instanceof BodyTooLargeError
      ? error(413, "RUNNER_REQUEST_TOO_LARGE")
      : error(500, "RUNNER_INGRESS_UNAVAILABLE"));
  }
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size > limit) { tooLarge = true; return; }
      chunks.push(value);
    });
    request.once("end", () => tooLarge ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("Runner request was aborted")));
  });
}

function send(response: ServerResponse, result: RunnerIngressResponse): void {
  response.statusCode = result.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (result.body === null) { response.end(); return; }
  const body = JSON.stringify(result.body);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function parseBody(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return object(parsed);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("string required");
  return value;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error("fields invalid");
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase().split(";", 1)[0]?.trim() ?? null : null;
}

function error(status: number, code: string): RunnerIngressResponse {
  return { status, body: { error: { code } } };
}

class BodyTooLargeError extends Error {}
