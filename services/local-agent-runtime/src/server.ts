import { createServer, type ServerResponse } from "node:http";
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
    json(response, 404, { error: { code: "NOT_FOUND", message: "Local Agent runtime route not found" } });
  } catch {
    json(response, 500, { error: { code: "LOCAL_AGENT_RUNTIME_FAILED", message: "Local Agent readiness probe failed" } });
  }
});

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
