import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LocalAgentPreflightRequest } from "./contracts";
import { LocalAgentReadinessService } from "./readiness";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_PORT ?? "4312", 10);
const service = new LocalAgentReadinessService({
  claudeVersion: process.env.DEVILUDO_LOCAL_CLAUDE_EXPECTED_VERSION,
  codexVersion: process.env.DEVILUDO_LOCAL_CODEX_EXPECTED_VERSION,
  executionEnabled: process.env.DEVILUDO_LOCAL_AGENT_EXECUTION === "1",
  inferenceGatewayUrl: process.env.DEVILUDO_LOCAL_INFERENCE_GATEWAY_URL,
  workerImageIdentity: process.env.DEVILUDO_WORKER_IMAGE_DIGEST,
  expectedWorkerImageIdentity: process.env.DEVILUDO_LOCAL_EXPECTED_WORKER_IMAGE_DIGEST,
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const health = await service.health();
      json(response, 200, health);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/preflight") {
      if (request.headers["x-deviludo-local-agent-runtime"] !== "v1") {
        json(response, 403, { error: { code: "LOCAL_RUNTIME_HEADER_REQUIRED", message: "Local Agent runtime header is required" } });
        return;
      }
      let preflight;
      try {
        preflight = await service.preflight(await readPreflightRequest(request));
      } catch {
        throw new LocalRequestError("Local Agent preflight validation failed");
      }
      json(response, 200, { data: preflight });
      return;
    }
    json(response, 404, { error: { code: "NOT_FOUND", message: "Local Agent runtime route not found" } });
  } catch (error) {
    const invalidRequest = error instanceof LocalRequestError;
    json(response, invalidRequest ? 400 : 500, { error: { code: invalidRequest ? "INVALID_PREFLIGHT_REQUEST" : "LOCAL_AGENT_RUNTIME_FAILED", message: invalidRequest ? "Local Agent preflight request is invalid" : "Local Agent readiness probe failed" } });
  }
});

class LocalRequestError extends Error {}

async function readPreflightRequest(request: IncomingMessage): Promise<LocalAgentPreflightRequest> {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new LocalRequestError("Local Agent preflight requires JSON");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) throw new LocalRequestError("Local Agent preflight body is too large");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LocalRequestError("Local Agent preflight body is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalRequestError("Local Agent preflight body is invalid");
  const item = value as Record<string, unknown>;
  return {
    projectId: requireString(item.projectId),
    runId: requireString(item.runId),
    profileRevisionId: requireString(item.profileRevisionId),
    agent: requireAgent(item.agent),
    expectedVersion: requireString(item.expectedVersion),
    imageDigest: requireString(item.imageDigest),
    providerRevisionId: requireString(item.providerRevisionId),
    credentialVersionId: requireString(item.credentialVersionId),
    model: requireString(item.model),
  };
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new LocalRequestError("Local Agent preflight field is invalid");
  return value;
}

function requireAgent(value: unknown): "claude-code" | "codex-cli" {
  if (value !== "claude-code" && value !== "codex-cli") throw new LocalRequestError("Local Agent preflight Agent is invalid");
  return value;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65_535) throw new Error("DEVILUDO_LOCAL_AGENT_RUNTIME_PORT is invalid");
server.listen(PORT, HOST, () => console.log(`[local-agent-runtime] Ready at http://${HOST}:${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
