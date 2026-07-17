#!/usr/bin/env node

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_LOCAL_RUNTIME_PORT = 4311;
const DEFAULT_LOCAL_AGENT_RUNTIME_PORT = 4312;
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
  DEVILUDO_LOCAL_PORT          Alternative way to select the Web port
  DEVILUDO_LOCAL_RUNTIME_PORT  Local Godot sidecar port (default: ${DEFAULT_LOCAL_RUNTIME_PORT})
  DEVILUDO_LOCAL_AGENT_RUNTIME_PORT  Local Agent readiness port (default: ${DEFAULT_LOCAL_AGENT_RUNTIME_PORT})`);
}

function parseEnvironmentPort(name, fallback) {
  const rawPort = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(rawPort)) throw new Error(`${name} is not a valid port: ${rawPort}`);
  const value = Number(rawPort);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535: ${rawPort}`);
  }
  return value;
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

async function request(baseUrl, route, init = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: { accept: route.startsWith("/api/") || route.startsWith("/v1/") ? "application/json" : "text/html", ...(init.headers ?? {}) },
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
let localRuntimePort;
let localAgentRuntimePort;
try {
  port = parsePort(process.argv.slice(2));
  if (port !== null) {
    localRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_RUNTIME_PORT", DEFAULT_LOCAL_RUNTIME_PORT);
    localAgentRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_AGENT_RUNTIME_PORT", DEFAULT_LOCAL_AGENT_RUNTIME_PORT);
  }
} catch (error) {
  port = undefined;
  localRuntimePort = undefined;
  localAgentRuntimePort = undefined;
  console.error(`[local:smoke] ${error instanceof Error ? error.message : String(error)}`);
  usage();
  process.exitCode = 1;
}

if (port === null || port === undefined || localRuntimePort === undefined || localAgentRuntimePort === undefined) {
  process.exit();
}

const baseUrl = `http://${HOST}:${port}`;
const runtimeUrl = `http://${HOST}:${localRuntimePort}`;
const agentRuntimeUrl = `http://${HOST}:${localAgentRuntimePort}`;

try {
  const health = await waitForHealth(baseUrl);
  const [home, admin, adminState, runtime, agentRuntime, agentPreflight, agentExecutionGate, runnerIngress, steamEnrollment, steamPublish] = await Promise.all([
    checkHtmlRoute(baseUrl, "/", "DeviLudo"),
    checkHtmlRoute(baseUrl, "/admin/agents", "Agent"),
    request(baseUrl, "/api/admin/agents"),
    request(runtimeUrl, "/health"),
    request(agentRuntimeUrl, "/health"),
    request(agentRuntimeUrl, "/v1/preflight", {
      method: "POST",
      headers: { "content-type": "application/json", "x-deviludo-local-agent-runtime": "v1" },
      body: JSON.stringify({
        projectId: "smoke-project",
        tenantId: "tenant-local",
        runId: "smoke-run",
        profileRevisionId: "profile-claude-platform-r5",
        agent: "claude-code",
        expectedVersion: "2.1.14",
        imageDigest: `sha256:${"a".repeat(64)}`,
        providerRevisionId: "provider-platform-claude-r1",
        credentialVersionId: "credential-platform-claude-v1",
        model: "claude-sonnet-4-6-20250514",
      }),
    }),
    request(agentRuntimeUrl, "/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-deviludo-local-agent-runtime": "v1" },
      body: JSON.stringify({
        tenantId: "tenant-local",
        projectId: "smoke-project",
        runId: "smoke-run",
        attemptId: "smoke-attempt",
        specRevisionId: "SPEC-001",
        testPlanRevisionId: "godot-testkit-1.0.0",
        profileRevisionId: "profile-claude-platform-r5",
        installationId: "claude-installation-214",
        agent: "claude-code",
        expectedVersion: "2.1.14",
        imageDigest: `sha256:${"a".repeat(64)}`,
        adapterVersion: "1.0.0",
        providerRevisionId: "provider-platform-claude-r1",
        providerProtocol: "anthropic-messages",
        credentialVersionId: "credential-platform-claude-v1",
        model: "claude-sonnet-4-6-20250514",
        budget: { maxTurns: 64, maxCostUsd: 25, maxInputTokens: 200000, maxOutputTokens: 50000 },
        timeoutSeconds: 7200,
        prompt: "Smoke contract only; execution must remain gated.",
      }),
    }),
    request(baseUrl, "/api/runner/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-runner-id": "forged-local-runner" },
      body: JSON.stringify({ type: "PLATFORM_COMPLETED", status: "PASSED" }),
    }),
    request(baseUrl, "/api/connections/steam", { method: "POST" }),
    request(baseUrl, "/api/releases/smoke-release/accept-and-publish", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-release", "x-mfa-proof": "forged-local-proof" },
      body: JSON.stringify({ mainCommitSha: "a".repeat(40), evidenceStatus: "PASSED" }),
    }),
  ]);
  const adminPayload = await adminState.response.json();
  if (!adminState.response.ok || !Array.isArray(adminPayload.data) || !["claude-code", "codex-cli"].includes(adminPayload.meta?.defaultAgent) || !Array.isArray(adminPayload.meta?.versions)) {
    throw new Error("local Agent admin state contract failed");
  }
  if (JSON.stringify(adminPayload).includes("secretRef")) throw new Error("Agent admin state exposed a secret reference");
  const runtimeHealth = await runtime.response.json();
  if (!runtime.response.ok || runtimeHealth.status !== "ok" || !runtimeHealth.godotVersion) {
    throw new Error("local runtime or Godot is not ready");
  }
  const agentHealth = await agentRuntime.response.json();
  if (!agentRuntime.response.ok || agentHealth.service !== "deviludo-local-agent-runtime" || !Array.isArray(agentHealth.agents)) {
    throw new Error("local Agent readiness service is not ready");
  }
  const agentSummary = agentHealth.agents
    .map((agent) => `${agent.agent} ${agent.observedVersion ?? "unavailable"} (${agent.state})`)
    .join(" · ");
  const preflightPayload = await agentPreflight.response.json();
  if (!agentPreflight.response.ok || !preflightPayload.data || !["BLOCKED", "READY"].includes(preflightPayload.data.status)) {
    throw new Error("local Agent preflight contract failed");
  }
  const executionGatePayload = await agentExecutionGate.response.json();
  if (![409, 503].includes(agentExecutionGate.response.status)
    || !["INSTALLATION_UNAVAILABLE", "INSTALLATION_MISMATCH", "WORKER_IMAGE_MISMATCH", "WAITING_PROVIDER", "EXECUTION_DISABLED", "LOCAL_AGENT_EXECUTOR_NOT_CONFIGURED"].includes(executionGatePayload.error?.code)) {
    throw new Error("local Agent execution gate did not fail closed");
  }
  const runnerIngressPayload = await runnerIngress.response.json();
  if (runnerIngress.response.status !== 503 || runnerIngressPayload.error?.code !== "RUNNER_MTLS_INGRESS_REQUIRED") {
    throw new Error("public Web process unexpectedly accepted a Runner event write");
  }
  const steamEnrollmentPayload = await steamEnrollment.response.json();
  if (steamEnrollment.response.status !== 503 || steamEnrollmentPayload.error?.code !== "STEAM_GUARD_ENROLLMENT_BROKER_REQUIRED") {
    throw new Error("public Web process fabricated a Steam Guard session");
  }
  const steamPublishPayload = await steamPublish.response.json();
  if (steamPublish.response.status !== 503 || steamPublishPayload.error?.code !== "STEAM_PUBLISH_DISPATCH_REQUIRED") {
    throw new Error("public Web process accepted client-asserted Steam release gates");
  }

  console.log(`✓ GET /              ${home.response.status} (${home.elapsedMs}ms) · HTML shell`);
  console.log(`✓ GET /admin/agents  ${admin.response.status} (${admin.elapsedMs}ms) · Agent console`);
  console.log(`✓ Admin state        ${adminState.response.status} (${adminState.elapsedMs}ms) · default=${adminPayload.meta.defaultAgent}`);
  console.log(`✓ GET /api/health    ${health.response.status} (${health.elapsedMs}ms) · status=ok`);
  console.log(`✓ Local runtime     ${runtime.response.status} (${runtime.elapsedMs}ms) · Godot ${runtimeHealth.godotVersion}`);
  console.log(`✓ Agent readiness   ${agentRuntime.response.status} (${agentRuntime.elapsedMs}ms) · ${agentSummary}`);
  console.log(`✓ Agent preflight   ${agentPreflight.response.status} (${agentPreflight.elapsedMs}ms) · ${preflightPayload.data.code}`);
  console.log(`✓ Agent execution   ${agentExecutionGate.response.status} (${agentExecutionGate.elapsedMs}ms) · ${executionGatePayload.error.code}`);
  console.log(`✓ Runner ingress    ${runnerIngress.response.status} (${runnerIngress.elapsedMs}ms) · ${runnerIngressPayload.error.code}`);
  console.log(`✓ Steam enrollment  ${steamEnrollment.response.status} (${steamEnrollment.elapsedMs}ms) · ${steamEnrollmentPayload.error.code}`);
  console.log(`✓ Steam publish     ${steamPublish.response.status} (${steamPublish.elapsedMs}ms) · ${steamPublishPayload.error.code}`);
  console.log("[local:smoke] All local smoke checks passed.");
} catch (error) {
  console.error(`[local:smoke] ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[local:smoke] Confirm that \`npm run local:dev -- --port ${port}\` is still running.`);
  process.exitCode = 1;
}
