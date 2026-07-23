import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LocalFixtureRunner } from "./fixture-runner";
import {
  LocalMainGateCoordinator,
  LocalRuntimeRequestError,
  LocalRuntimeRunCoordinator,
  parseLocalMainGateRequest,
  parseLocalRuntimeRequest,
} from "./http-contract";
import {
  LocalRuntimeAuthenticationError,
  LocalRuntimeRequestVerifier,
  localRuntimeKeyFromEnvironment,
} from "./request-auth";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.DEVILUDO_LOCAL_RUNTIME_PORT ?? "4311", 10);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runner = new LocalFixtureRunner({
  repositoryRoot,
  godotBinary: process.env.DEVILUDO_GODOT_BINARY,
  exportTemplatesRoot: process.env.DEVILUDO_GODOT_EXPORT_TEMPLATES_ROOT,
});
const requestVerifier = new LocalRuntimeRequestVerifier(localRuntimeKeyFromEnvironment());
const runCoordinator = new LocalRuntimeRunCoordinator();
const mainGateCoordinator = new LocalMainGateCoordinator();

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    if (error instanceof LocalRuntimeAuthenticationError) {
      json(response, 403, { error: { code: "LOCAL_RUNTIME_AUTH_REQUIRED", message: "Authenticated local Godot runtime request is required" } });
      return;
    }
    if (error instanceof LocalRuntimeRequestError) {
      json(response, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    json(response, 500, { error: { code: "LOCAL_RUNTIME_FAILED", message: "Local runtime request failed" } });
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
      exportTemplatesRoot: runner.exportTemplatesRoot,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/runs" && !url.search) {
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      json(response, 415, { error: { code: "JSON_REQUIRED", message: "Local runtime request requires JSON" } });
      return;
    }
    const rawBody = await readBody(request);
    requestVerifier.verify({ method: "POST", path: "/v1/runs", body: rawBody, headers: request.headers });
    const body = parseLocalRuntimeRequest(rawBody);
    const operation = runCoordinator.start(body, () => runner.run(body));
    json(response, 201, { data: await operation });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/main-gates" && !url.search) {
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      json(response, 415, { error: { code: "JSON_REQUIRED", message: "Local main gate request requires JSON" } });
      return;
    }
    const rawBody = await readBody(request);
    requestVerifier.verify({ method: "POST", path: "/v1/main-gates", body: rawBody, headers: request.headers });
    const body = parseLocalMainGateRequest(rawBody);
    const operation = mainGateCoordinator.start(body, () => runner.runMainGate(body));
    json(response, 201, { data: await operation });
    return;
  }

  const evidenceMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/([^/]+)\/evidence\/(manifest\.json|junit\.xml|godot\.log)$/);
  if (request.method === "GET" && evidenceMatch && !url.search) {
    requestVerifier.verify({ method: "GET", path: url.pathname, body: "", headers: request.headers });
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

  const artifactMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/([^/]+)\/artifacts\/(DeviLudoLocal\.zip)$/);
  if (request.method === "GET" && artifactMatch && !url.search) {
    requestVerifier.verify({ method: "GET", path: url.pathname, body: "", headers: request.headers });
    const [, projectId, runId, file] = artifactMatch;
    const artifact = await runner.readBuildArtifact({ projectId, runId }, file);
    response.statusCode = 200;
    response.setHeader("content-type", artifact.evidence.buildArtifact!.contentType);
    response.setHeader("content-length", artifact.bytes.byteLength);
    response.setHeader("x-deviludo-artifact-sha256", artifact.evidence.buildArtifact!.sha256);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.end(artifact.bytes);
    return;
  }

  const mainEvidenceMatch = url.pathname.match(/^\/v1\/main-gates\/([^/]+)\/([^/]+)\/evidence\/(manifest\.json|junit\.xml|godot\.log)$/);
  if (request.method === "GET" && mainEvidenceMatch && !url.search) {
    requestVerifier.verify({ method: "GET", path: url.pathname, body: "", headers: request.headers });
    const [, projectId, runId, file] = mainEvidenceMatch;
    const target = path.join(runner.mainEvidenceDirectory({ projectId, runId }), file);
    await access(target);
    response.statusCode = 200;
    response.setHeader("content-type", file.endsWith(".json") ? "application/json; charset=utf-8" : file.endsWith(".xml") ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(await readFile(target));
    return;
  }

  const mainArtifactMatch = url.pathname.match(/^\/v1\/main-gates\/([^/]+)\/([^/]+)\/artifacts\/(DeviLudoMain\.zip)$/);
  if (request.method === "GET" && mainArtifactMatch && !url.search) {
    requestVerifier.verify({ method: "GET", path: url.pathname, body: "", headers: request.headers });
    const [, projectId, runId, file] = mainArtifactMatch;
    const artifact = await runner.readMainBuildArtifact({ projectId, runId }, file);
    response.statusCode = 200;
    response.setHeader("content-type", artifact.evidence.buildArtifact!.contentType);
    response.setHeader("content-length", artifact.bytes.byteLength);
    response.setHeader("x-deviludo-artifact-sha256", artifact.evidence.buildArtifact!.sha256);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.end(artifact.bytes);
    return;
  }

  json(response, 404, { error: { code: "NOT_FOUND", message: "Local runtime route not found" } });
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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
