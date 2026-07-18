import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import {
  AgentSupplyChainBusyError,
  AgentSupplyChainTerminalError,
  type DurableAgentSupplyChainBrokerService,
} from "./broker-service";
import { parseAgentSupplyChainRequest } from "./request-contract";

const MAX_BODY_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface AgentSupplyChainIngressRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface AgentSupplyChainIngressResponse {
  readonly status: number;
  readonly body: unknown;
}

export function createAgentSupplyChainHandler(options: Readonly<{
  service: Pick<DurableAgentSupplyChainBrokerService, "execute" | "probe">;
  allowedSpiffeIds: ReadonlySet<string>;
  healthIdentity: Readonly<{ version: string; binaryDigest: string }>;
  now?: () => Date;
  extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}>): (request: AgentSupplyChainIngressRequest) => Promise<AgentSupplyChainIngressResponse> {
  if (!options.allowedSpiffeIds.size || !VERSION.test(options.healthIdentity.version)
    || /(?:latest|stable|default)/i.test(options.healthIdentity.version)
    || !SHA256.test(options.healthIdentity.binaryDigest)) invalidConfig();
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  const now = options.now ?? (() => new Date());
  return async (request) => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "AGENT_SUPPLY_CHAIN_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) return failure(403, "AGENT_SUPPLY_CHAIN_WORKLOAD_FORBIDDEN");
    if (request.method !== "POST") return failure(404, "AGENT_SUPPLY_CHAIN_ROUTE_NOT_FOUND");
    if (contentType(request.headers["content-type"]) !== "application/json") return failure(415, "AGENT_SUPPLY_CHAIN_JSON_REQUIRED");
    let body: unknown;
    try { body = JSON.parse(request.rawBody) as unknown; }
    catch { return failure(400, "AGENT_SUPPLY_CHAIN_REQUEST_INVALID"); }
    if (request.path === "/healthz") {
      if (!healthRequest(body)) return failure(400, "AGENT_SUPPLY_CHAIN_REQUEST_INVALID");
      try { await options.service.probe(); }
      catch { return failure(503, "AGENT_SUPPLY_CHAIN_NOT_READY"); }
      const checkedAt = now();
      if (!Number.isFinite(checkedAt.getTime())) return failure(503, "AGENT_SUPPLY_CHAIN_NOT_READY");
      return {
        status: 200,
        body: Object.freeze({
          schemaVersion: "deviludo.agent-supply-chain-health.v1",
          service: "deviludo-agent-supply-chain",
          version: options.healthIdentity.version,
          binaryDigest: options.healthIdentity.binaryDigest,
          status: "READY",
          checkedAt: checkedAt.toISOString(),
        }),
      };
    }
    let parsed;
    try {
      parsed = parseAgentSupplyChainRequest(body);
      if (!routeMatches(request.path, parsed.schemaVersion)) throw new Error("route mismatch");
    } catch { return failure(400, "AGENT_SUPPLY_CHAIN_REQUEST_INVALID"); }
    try {
      const response = await options.service.execute(parsed);
      return { status: 200, body: response };
    } catch (error) {
      if (error instanceof AgentSupplyChainBusyError) return failure(503, "AGENT_SUPPLY_CHAIN_OPERATION_BUSY");
      if (error instanceof AgentSupplyChainTerminalError) {
        return terminalFailure(error.receipt);
      }
      return failure(503, "AGENT_SUPPLY_CHAIN_EXECUTION_FAILED");
    }
  };
}

export function createAgentSupplyChainHttpsServer(options: Readonly<{
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: (request: AgentSupplyChainIngressRequest) => Promise<AgentSupplyChainIngressResponse>;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}>): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) invalidConfig();
  const maximum = integer(options.maxBodyBytes ?? MAX_BODY_BYTES, 32 * 1024, MAX_BODY_BYTES);
  const timeout = integer(options.requestTimeoutMs ?? 9 * 60_000, 1_000, 10 * 60_000);
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
  handler: (request: AgentSupplyChainIngressRequest) => Promise<AgentSupplyChainIngressResponse>,
  maximum: number,
): Promise<void> {
  try {
    const rawBody = await readBody(request, maximum);
    const url = new URL(request.url ?? "/", "https://agent-supply-chain.invalid");
    if (url.search) throw new Error("query is forbidden");
    const result = await handler({
      method: request.method ?? "",
      path: url.pathname,
      headers: request.headers,
      socket: request.socket,
      rawBody,
    });
    send(response, result);
  } catch {
    send(response, failure(400, "AGENT_SUPPLY_CHAIN_REQUEST_INVALID"));
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

function send(response: ServerResponse, result: AgentSupplyChainIngressResponse): void {
  const body = JSON.stringify(result.body);
  response.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function routeMatches(path: string, schema: string): boolean {
  return path === "/v1/agent-versions/discover" && schema === "deviludo.agent-version-discovery-request.v1"
    || path === "/v1/agent-versions/validate" && schema === "deviludo.agent-version-validation-request.v1"
    || path === "/v1/agent-installations/build" && schema === "deviludo.agent-installation-build-request.v1"
    || path === "/v1/agent-installations/rollout" && schema === "deviludo.agent-installation-rollout-request.v1";
}

function healthRequest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && body.schemaVersion === "deviludo.agent-supply-chain-health-request.v1";
}

function contentType(value: string | readonly string[] | undefined): string {
  const selected = Array.isArray(value) ? value[0] : value;
  return typeof selected === "string" ? selected.split(";", 1)[0]!.trim().toLowerCase() : "";
}

function failure(status: number, code: string): AgentSupplyChainIngressResponse {
  return { status, body: Object.freeze({ error: Object.freeze({ code }) }) };
}

function terminalFailure(receipt: AgentSupplyChainTerminalError["receipt"]): AgentSupplyChainIngressResponse {
  return {
    status: 422,
    body: Object.freeze({
      error: Object.freeze({ code: "AGENT_SUPPLY_CHAIN_POLICY_REJECTED", failure: receipt }),
    }),
  };
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalidConfig();
  return value;
}

function invalidConfig(): never { throw new Error("Agent supply-chain ingress configuration is invalid"); }
