import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import type { AgentExecutionBrokerIdentity, AgentExecutionLookup, AgentExecutionRequest } from "./contracts";
import { parseAgentExecutionRequest } from "./contracts";
import { AgentProviderUnavailable, DurableAgentExecutionService } from "./operations";

const MAX_BODY_BYTES = 512 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export interface AgentExecutionBrokerIngressRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface AgentExecutionBrokerIngressResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function createAgentExecutionBrokerHandler(options: Readonly<{
  service: DurableAgentExecutionService;
  allowedSpiffeIds: ReadonlySet<string>;
  healthIdentity: Readonly<{ version: string; binaryDigest: string }>;
  extractIdentity?: (socket: unknown) => AgentExecutionBrokerIdentity;
}>): (request: AgentExecutionBrokerIngressRequest) => Promise<AgentExecutionBrokerIngressResponse> {
  if (!options.allowedSpiffeIds.size || !/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+){0,5}$/.test(options.healthIdentity.version)
    || !SHA256.test(options.healthIdentity.binaryDigest)) throw new Error("Agent execution Broker ingress configuration is invalid");
  const extractIdentity = options.extractIdentity ?? ((socket) => evidenceArchiveIdentityFromTlsSocket(socket));
  return async (request) => {
    let identity: AgentExecutionBrokerIdentity;
    try { identity = extractIdentity(request.socket); } catch { return failure(401, "AGENT_EXECUTION_BROKER_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) return failure(403, "AGENT_EXECUTION_BROKER_WORKLOAD_FORBIDDEN");
    if (request.method === "GET" && request.path === "/healthz") {
      if (request.rawBody) return failure(400, "AGENT_EXECUTION_BROKER_REQUEST_INVALID");
      try { await options.service.probe(); } catch { return failure(503, "AGENT_EXECUTION_BROKER_NOT_READY"); }
      return { status: 200, body: { schemaVersion: "deviludo.agent-execution-broker-health.v1", status: "ok",
        service: "deviludo-agent-execution-broker", ...options.healthIdentity } };
    }
    if (request.method === "POST" && request.path === "/v1/agent-runs") {
      if (contentType(request.headers["content-type"]) !== "application/json") return failure(415, "AGENT_EXECUTION_BROKER_JSON_REQUIRED");
      let body: AgentExecutionRequest;
      try {
        body = parseAgentExecutionRequest(request.rawBody);
        validateHeaders(request.headers, body.tenantId, body.operationKey, body.requestDigest);
      } catch { return failure(400, "AGENT_EXECUTION_BROKER_REQUEST_INVALID"); }
      try {
        const status = await options.service.submit(identity, body);
        return { status: status.status === "RUNNING" ? 202 : 200, body: Object.freeze({ ...status }) };
      } catch (error) {
        if (error instanceof AgentProviderUnavailable) return providerUnavailable(error.providerRevisionId);
        return failure(409, "AGENT_EXECUTION_BROKER_OPERATION_REJECTED");
      }
    }
    const runId = statusRunId(request.method, request.path);
    if (runId) {
      if (request.rawBody) return failure(400, "AGENT_EXECUTION_BROKER_REQUEST_INVALID");
      let lookup: AgentExecutionLookup;
      try {
        lookup = Object.freeze({ tenantId: requiredHeader(request.headers, "x-deviludo-tenant-id", UUID), runId,
          operationKey: requiredHeader(request.headers, "idempotency-key", /^workflow-job:[a-f0-9-]{36}$/i),
          requestDigest: requiredHeader(request.headers, "x-deviludo-request-digest", SHA256) });
      } catch { return failure(400, "AGENT_EXECUTION_BROKER_REQUEST_INVALID"); }
      try {
        const status = await options.service.get(identity, lookup);
        return { status: status.status === "RUNNING" ? 202 : 200, body: Object.freeze({ ...status }) };
      } catch (error) {
        if (error instanceof AgentProviderUnavailable) return providerUnavailable(error.providerRevisionId);
        return failure(404, "AGENT_EXECUTION_BROKER_RUN_NOT_FOUND");
      }
    }
    return failure(404, "AGENT_EXECUTION_BROKER_ROUTE_NOT_FOUND");
  };
}

export function createAgentExecutionBrokerHttpsServer(options: Readonly<{
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: (request: AgentExecutionBrokerIngressRequest) => Promise<AgentExecutionBrokerIngressResponse>;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}>): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("Agent execution Broker TLS material is incomplete");
  const maximum = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const timeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isInteger(maximum) || maximum < 32 * 1024 || maximum > MAX_BODY_BYTES
    || !Number.isInteger(timeout) || timeout < 1_000 || timeout > 10 * 60_000) throw new Error("Agent execution Broker server limits are invalid");
  const server = createServer({ ...options.tls, minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true },
    (request, response) => { void dispatch(request, response, options.handler, maximum); });
  server.requestTimeout = timeout; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000; server.maxHeadersCount = 64;
  return server;
}

async function dispatch(request: IncomingMessage, response: ServerResponse,
  handler: (request: AgentExecutionBrokerIngressRequest) => Promise<AgentExecutionBrokerIngressResponse>, maximum: number): Promise<void> {
  try {
    const rawBody = await readBody(request, maximum);
    const result = await handler({ method: request.method ?? "", path: new URL(request.url ?? "/", "https://broker.invalid").pathname,
      headers: request.headers, socket: request.socket, rawBody });
    response.statusCode = result.status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify(result.body));
  } catch {
    if (!response.headersSent) response.statusCode = 400;
    response.end(JSON.stringify({ error: { code: "AGENT_EXECUTION_BROKER_REQUEST_INVALID" } }));
  }
}

function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    request.on("data", (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.byteLength;
      if (bytes > maximum) { request.destroy(); reject(new Error("body too large")); } else chunks.push(value); });
    request.once("error", reject); request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
function statusRunId(method: string, path: string): string | null {
  if (method !== "GET") return null;
  const match = /^\/v1\/agent-runs\/([a-f0-9-]{36})$/i.exec(path);
  return match?.[1] && UUID.test(match[1]) ? match[1] : null;
}
function validateHeaders(headers: AgentExecutionBrokerIngressRequest["headers"], tenantId: string, key: string, digest: string): void {
  if (requiredHeader(headers, "x-deviludo-tenant-id", UUID) !== tenantId
    || requiredHeader(headers, "idempotency-key", /^workflow-job:[a-f0-9-]{36}$/i) !== key
    || requiredHeader(headers, "x-deviludo-request-digest", SHA256) !== digest) throw new Error("binding mismatch");
}
function requiredHeader(headers: AgentExecutionBrokerIngressRequest["headers"], name: string, shape: RegExp): string {
  const value = headers[name]; if (typeof value !== "string" || !shape.test(value)) throw new Error("header invalid"); return value;
}
function contentType(value: string | readonly string[] | undefined): string { return typeof value === "string" ? value.split(";", 1)[0]!.trim().toLowerCase() : ""; }
function providerUnavailable(providerRevisionId: string): AgentExecutionBrokerIngressResponse {
  return { status: 409, body: { error: { code: "PROVIDER_UNAVAILABLE", providerRevisionId } } };
}
function failure(status: number, code: string): AgentExecutionBrokerIngressResponse { return { status, body: { error: { code } } }; }
