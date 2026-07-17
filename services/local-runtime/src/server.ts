import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { LocalRuntimeRequest } from "./contracts";
import { LocalFixtureRunner } from "./fixture-runner";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.DEVILUDO_LOCAL_RUNTIME_PORT ?? "4311", 10);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runner = new LocalFixtureRunner({
  repositoryRoot,
  godotBinary: process.env.DEVILUDO_GODOT_BINARY,
});
const running = new Map<string, Promise<unknown>>();

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    json(response, 500, { error: { code: "LOCAL_RUNTIME_FAILED", message: error instanceof Error ? error.message : "Local runtime failed" } });
  }
});

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (request.method === "GET" && url.pathname === "/health") {
    let version: string | null = null;
    try { version = await runner.godotVersion(); } catch { /* surfaced as degraded */ }
    json(response, version ? 200 : 503, {
      status: version ? "ok" : "degraded",
      service: "deviludo-local-runtime",
      godotBinary: runner.godotBinary,
      godotVersion: version,
      storage: runner.storageRoot,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/runs") {
    const body = await readJson(request) as Partial<LocalRuntimeRequest>;
    if (!body.projectId || !body.runId || !body.specRevisionId) {
      json(response, 400, { error: { code: "INVALID_REQUEST", message: "projectId, runId and specRevisionId are required" } });
      return;
    }
    const key = `${body.projectId}:${body.runId}`;
    let operation = running.get(key);
    if (!operation) {
      operation = runner.run(body as LocalRuntimeRequest).finally(() => running.delete(key));
      running.set(key, operation);
    }
    json(response, 201, { data: await operation });
    return;
  }

  const evidenceMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/([^/]+)\/evidence\/(manifest\.json|junit\.xml|godot\.log)$/);
  if (request.method === "GET" && evidenceMatch) {
    const [, projectId, runId, file] = evidenceMatch;
    const directory = runner.evidenceDirectory({ projectId, runId });
    const target = path.join(directory, file);
    await access(target);
    response.statusCode = 200;
    response.setHeader("content-type", file.endsWith(".json") ? "application/json; charset=utf-8" : file.endsWith(".xml") ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(await readFile(target));
    return;
  }

  json(response, 404, { error: { code: "NOT_FOUND", message: "Local runtime route not found" } });
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("DEVILUDO_LOCAL_RUNTIME_PORT is invalid");
server.listen(PORT, HOST, () => console.log(`[local-runtime] Ready at http://${HOST}:${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
