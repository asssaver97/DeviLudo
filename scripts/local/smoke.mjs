#!/usr/bin/env node

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 250;

function usage() {
  console.log(`Usage: npm run local:smoke -- [--port <port>]

Waits for the local DeviLudo site, then checks its key user and API routes.

Options:
  -p, --port <port>  Local site port (default: ${DEFAULT_PORT})
  -h, --help         Show this help

Environment:
  DEVILUDO_LOCAL_PORT  Alternative way to select the port`);
}

function parsePort(argv) {
  let rawPort = process.env.DEVILUDO_LOCAL_PORT ?? String(DEFAULT_PORT);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      return null;
    }

    if (argument === "--port" || argument === "-p") {
      rawPort = argv[index + 1];
      index += 1;
      if (rawPort === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      continue;
    }

    if (argument.startsWith("--port=")) {
      rawPort = argument.slice("--port=".length);
      continue;
    }

    throw new Error(`unknown option: ${argument}`);
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`invalid port: ${rawPort}`);
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`port must be an integer between 1 and 65535: ${rawPort}`);
  }
  return port;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(baseUrl, route) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { accept: route.startsWith("/api/") ? "application/json" : "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  return {
    response,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError;

  process.stdout.write(`[local:smoke] Waiting for ${baseUrl}`);
  while (Date.now() < deadline) {
    try {
      const result = await request(baseUrl, "/api/health");
      const payload = await result.response.json();
      if (result.response.ok && payload.status === "ok" && payload.service === "deviludo-control-plane-preview") {
        process.stdout.write(" ready\n");
        return { ...result, payload };
      }
      lastError = new Error(`health returned HTTP ${result.response.status} with an unexpected payload`);
    } catch (error) {
      lastError = error;
    }

    process.stdout.write(".");
    await sleep(RETRY_INTERVAL_MS);
  }

  process.stdout.write(" failed\n");
  throw new Error(
    `site was not healthy within ${READY_TIMEOUT_MS / 1_000}s: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function checkHtmlRoute(baseUrl, route, expectedText) {
  const result = await request(baseUrl, route);
  const body = await result.response.text();
  const contentType = result.response.headers.get("content-type") ?? "";

  if (!result.response.ok) {
    throw new Error(`GET ${route} returned HTTP ${result.response.status}`);
  }
  if (!contentType.includes("text/html")) {
    throw new Error(`GET ${route} returned ${contentType || "no content type"}, expected text/html`);
  }
  if (!body.includes(expectedText)) {
    throw new Error(`GET ${route} did not contain expected marker: ${expectedText}`);
  }

  return result;
}

let port;
try {
  port = parsePort(process.argv.slice(2));
} catch (error) {
  console.error(`[local:smoke] ${error instanceof Error ? error.message : String(error)}`);
  usage();
  process.exitCode = 1;
}

if (port === null || port === undefined) {
  process.exit();
}

const baseUrl = `http://${HOST}:${port}`;

try {
  const health = await waitForHealth(baseUrl);
  const [home, admin] = await Promise.all([
    checkHtmlRoute(baseUrl, "/", "DeviLudo"),
    checkHtmlRoute(baseUrl, "/admin/agents", "Agent"),
  ]);

  console.log(`✓ GET /              ${home.response.status} (${home.elapsedMs}ms) · HTML shell`);
  console.log(`✓ GET /admin/agents  ${admin.response.status} (${admin.elapsedMs}ms) · Agent console`);
  console.log(`✓ GET /api/health    ${health.response.status} (${health.elapsedMs}ms) · status=ok`);
  console.log("[local:smoke] All local smoke checks passed.");
} catch (error) {
  console.error(`[local:smoke] ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[local:smoke] Confirm that \`npm run local:dev -- --port ${port}\` is still running.`);
  process.exitCode = 1;
}
