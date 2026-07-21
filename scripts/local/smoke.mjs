#!/usr/bin/env node

import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_LOCAL_RUNTIME_PORT = 4311;
const DEFAULT_LOCAL_AGENT_RUNTIME_PORT = 4312;
const DEFAULT_LOCAL_SPEC_RUNTIME_PORT = 4313;
const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
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
  DEVILUDO_LOCAL_AGENT_RUNTIME_PORT  Local Agent readiness port (default: ${DEFAULT_LOCAL_AGENT_RUNTIME_PORT})
  DEVILUDO_LOCAL_SPEC_RUNTIME_PORT  Local specification dialogue port (default: ${DEFAULT_LOCAL_SPEC_RUNTIME_PORT})`);
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

async function request(baseUrl, route, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: { accept: route.startsWith("/api/") || route.startsWith("/v1/") ? "application/json" : "text/html", ...(init.headers ?? {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  return {
    response,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

async function localWorkflowAction(baseUrl, projectId, operationKey, action) {
  if (action === "accept") {
    return request(baseUrl, `/api/projects/${projectId}/acceptance`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": operationKey },
      body: "{}",
    });
  }
  return request(baseUrl, `/api/projects/${projectId}/delivery`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": operationKey },
    body: JSON.stringify({ action }),
  });
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

async function localSidecarKey(name) {
  if (!new Set(["local-runtime", "local-agent-runtime", "local-spec-runtime"]).has(name)) {
    throw new Error("local sidecar key name is invalid");
  }
  const encoded = (await readFile(new URL(`../../.deviludo/${name}.hmac`, import.meta.url), "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43,86}$/.test(encoded)) throw new Error("local sidecar key is invalid");
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength < 32 || key.byteLength > 64 || key.toString("base64url") !== encoded) {
    throw new Error("local sidecar key is invalid");
  }
  return key;
}

function localSidecarHeaders(audience, method, route, body, key) {
  const issuedAt = new Date().toISOString();
  const nonce = randomBytes(18).toString("base64url");
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", key)
    .update(["deviludo.local-sidecar.v1", audience, method, route, bodyDigest, issuedAt, nonce].join("\n"))
    .digest("base64url");
  return {
    "x-deviludo-local-sidecar": "v1",
    "x-deviludo-local-sidecar-audience": audience,
    "x-deviludo-local-sidecar-issued-at": issuedAt,
    "x-deviludo-local-sidecar-nonce": nonce,
    "x-deviludo-local-sidecar-body-sha256": bodyDigest,
    "x-deviludo-local-sidecar-signature": signature,
  };
}

let port;
let localRuntimePort;
let localAgentRuntimePort;
let localSpecRuntimePort;
try {
  port = parsePort(process.argv.slice(2));
  if (port !== null) {
    localRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_RUNTIME_PORT", DEFAULT_LOCAL_RUNTIME_PORT);
    localAgentRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_AGENT_RUNTIME_PORT", DEFAULT_LOCAL_AGENT_RUNTIME_PORT);
    localSpecRuntimePort = parseEnvironmentPort("DEVILUDO_LOCAL_SPEC_RUNTIME_PORT", DEFAULT_LOCAL_SPEC_RUNTIME_PORT);
  }
} catch (error) {
  port = undefined;
  localRuntimePort = undefined;
  localAgentRuntimePort = undefined;
  localSpecRuntimePort = undefined;
  console.error(`[local:smoke] ${error instanceof Error ? error.message : String(error)}`);
  usage();
  process.exitCode = 1;
}

if (port === null || port === undefined || localRuntimePort === undefined || localAgentRuntimePort === undefined || localSpecRuntimePort === undefined) {
  process.exit();
}

const baseUrl = `http://${HOST}:${port}`;
const runtimeUrl = `http://${HOST}:${localRuntimePort}`;
const agentRuntimeUrl = `http://${HOST}:${localAgentRuntimePort}`;
const specRuntimeUrl = `http://${HOST}:${localSpecRuntimePort}`;
const smokeNonce = `${process.pid}-${Date.now().toString(36)}`;
const smokeSpecProject = `smoke-spec-${smokeNonce}`;
const smokeValidationProject = `smoke-validation-${smokeNonce}`;
const smokeFeedbackProject = `smoke-feedback-${smokeNonce}`;
const smokeReleaseProject = `smoke-release-gates-${smokeNonce}`;
const smokeCodexProject = `smoke-codex-release-${smokeNonce}`;

try {
  const health = await waitForHealth(baseUrl);
  const [runtimeSidecarKey, agentSidecarKey, specSidecarKey] = await Promise.all([
    localSidecarKey("local-runtime"),
    localSidecarKey("local-agent-runtime"),
    localSidecarKey("local-spec-runtime"),
  ]);
  if (runtimeSidecarKey.equals(agentSidecarKey) || runtimeSidecarKey.equals(specSidecarKey)
    || agentSidecarKey.equals(specSidecarKey)) {
    throw new Error("local sidecars unexpectedly share an authentication key");
  }
  const [claudeSelection, codexSelection] = await Promise.all([
    request(baseUrl, `/api/projects/${smokeReleaseProject}/agent-settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-select-claude" },
      body: JSON.stringify({ profileRevisionId: "profile-claude-platform-r5" }),
    }),
    request(baseUrl, `/api/projects/${smokeCodexProject}/agent-settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-select-codex" },
      body: JSON.stringify({ profileRevisionId: "profile-codex-platform-r2" }),
    }),
  ]);
  if (!claudeSelection.response.ok || !codexSelection.response.ok) {
    throw new Error("local project Agent selection did not persist both approved Profiles");
  }
  const preflightCommand = JSON.stringify({
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
  });
  const executionCommand = JSON.stringify({
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
  });
  const [home, login, projects, runnersPage, evidencePage, admin, invitations, tenantAgents, projectAgents, steamSettingsPage, projectCatalog, adminState, tenantAgentState, invitationGate, localSession, runtime, agentRuntime, specRuntime, specDialogue, agentPreflight, agentExecutionGate, forgedAgentRequest, forgedRuntimeRequest, forgedSpecRequest, runnerIngress, githubAuthorization, steamEnrollment, steamProjectConfiguration, steamPublish] = await Promise.all([
    checkHtmlRoute(baseUrl, "/", "DeviLudo"),
    checkHtmlRoute(baseUrl, "/login", "受邀登录"),
    checkHtmlRoute(baseUrl, "/projects", "游戏项目"),
    checkHtmlRoute(baseUrl, "/runners", "运行节点"),
    checkHtmlRoute(baseUrl, "/evidence", "证据中心"),
    checkHtmlRoute(baseUrl, "/admin/agents", "Agent"),
    checkHtmlRoute(baseUrl, "/admin/invitations", "受邀账号管理"),
    checkHtmlRoute(baseUrl, "/settings/agents", "开发 Agent"),
    checkHtmlRoute(baseUrl, "/projects/ember-archipelago/agent-settings", "项目 Agent 选择"),
    checkHtmlRoute(baseUrl, "/projects/ember-archipelago/steam-settings", "Steam 私有 Beta 设置"),
    request(baseUrl, "/api/projects"),
    request(baseUrl, "/api/admin/agents"),
    request(baseUrl, "/api/settings/agents"),
    request(baseUrl, "/api/admin/invitations", { method: "POST" }),
    request(baseUrl, "/api/auth/session"),
    request(runtimeUrl, "/health"),
    request(agentRuntimeUrl, "/health"),
    request(specRuntimeUrl, "/health"),
    request(baseUrl, `/api/projects/${smokeSpecProject}/conversation`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-spec-dialogue-1" },
      body: JSON.stringify({ expectedRevision: 0, message: "制作一款十分钟一局的 2D 桌面单机游戏" }),
    }),
    request(agentRuntimeUrl, "/v1/preflight", {
      method: "POST",
      headers: { "content-type": "application/json", ...localSidecarHeaders("agent-runtime", "POST", "/v1/preflight", preflightCommand, agentSidecarKey) },
      body: preflightCommand,
    }),
    request(agentRuntimeUrl, "/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json", ...localSidecarHeaders("agent-runtime", "POST", "/v1/runs", executionCommand, agentSidecarKey) },
      body: executionCommand,
    }),
    request(agentRuntimeUrl, "/v1/preflight", {
      method: "POST",
      headers: { "content-type": "application/json", "x-deviludo-local-agent-runtime": "v1" },
      body: preflightCommand,
    }),
    request(runtimeUrl, "/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-deviludo-local-runtime": "v1" },
      body: JSON.stringify({ projectId: "forged", runId: "forged", specRevisionId: "forged" }),
    }),
    request(specRuntimeUrl, "/v1/projects/forged/conversation", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "forged", "x-deviludo-local-spec-runtime": "v1" },
      body: JSON.stringify({ expectedRevision: 0, message: "forged" }),
    }),
    request(baseUrl, "/api/runner/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-runner-id": "forged-local-runner" },
      body: JSON.stringify({ type: "PLATFORM_COMPLETED", status: "PASSED" }),
    }),
    request(baseUrl, "/api/connections/github", {
      method: "POST",
      headers: { "idempotency-key": "smoke-github-authorization" },
    }),
    request(baseUrl, "/api/connections/steam", { method: "POST" }),
    request(baseUrl, "/api/projects/ember-archipelago/steam-settings"),
    request(baseUrl, "/api/releases/smoke-release/accept-and-publish", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-release", "x-mfa-proof": "forged-local-proof" },
      body: JSON.stringify({ mainCommitSha: "a".repeat(40), evidenceStatus: "PASSED" }),
    }),
  ]);
  const projectCatalogPayload = await projectCatalog.response.json();
  if (!projectCatalog.response.ok || projectCatalogPayload.meta?.mode !== "LOCAL_FIXTURE"
    || !Array.isArray(projectCatalogPayload.data) || projectCatalogPayload.data.length !== 1
    || projectCatalogPayload.data[0]?.projectId !== "ember-archipelago"
    || projectCatalogPayload.data[0]?.owner !== "north-dock") {
    throw new Error("local project catalog contract failed");
  }
  const adminPayload = await adminState.response.json();
  if (!adminState.response.ok || !Array.isArray(adminPayload.data) || !["claude-code", "codex-cli"].includes(adminPayload.meta?.defaultAgent) || !Array.isArray(adminPayload.meta?.versions)) {
    throw new Error("local Agent admin state contract failed");
  }
  if (JSON.stringify(adminPayload).includes("secretRef")) throw new Error("Agent admin state exposed a secret reference");
  const adminProfileIds = new Set((adminPayload.meta?.profiles ?? []).map((profile) => profile?.id).filter(Boolean));
  const adminDefaults = adminPayload.meta?.defaults;
  if (!adminDefaults || typeof adminDefaults !== "object" || Array.isArray(adminDefaults)
    || !["platform", "tenant:north-dock", "project:ember-archipelago"].every((scope) =>
      typeof adminDefaults[scope] === "string" && adminProfileIds.has(adminDefaults[scope]))) {
    throw new Error("local Agent inheritance contains a dangling default Profile");
  }
  const tenantAgentPayload = await tenantAgentState.response.json();
  if (!tenantAgentState.response.ok || !Array.isArray(tenantAgentPayload.data)
    || tenantAgentPayload.meta?.defaultAgent !== "claude-code" || JSON.stringify(tenantAgentPayload).includes("secretRef")) {
    throw new Error("tenant Agent settings projection contract failed");
  }
  const unknownFieldMarker = "unknown-agent-field-must-not-be-echoed";
  const forgedTenantProfile = await request(baseUrl, "/api/settings/agents/profiles", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-forged-tenant-profile" },
    body: JSON.stringify({ scope: "project", scopeId: unknownFieldMarker, credentialId: unknownFieldMarker }),
  });
  const forgedTenantProfileText = await forgedTenantProfile.response.text();
  if (forgedTenantProfile.response.status !== 400
    || JSON.parse(forgedTenantProfileText).error?.code !== "UNEXPECTED_FIELD"
    || forgedTenantProfileText.includes(unknownFieldMarker)) {
    throw new Error("tenant Agent Profile endpoint did not reject a forged scope without echoing it");
  }
  const rejectedApiKey = "valid-but-rejected-key";
  const forgedCredential = await request(baseUrl, "/api/settings/agents/credentials", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-forged-tenant-credential" },
    body: JSON.stringify({ label: "Forged legacy credential", apiKey: rejectedApiKey, credentialId: unknownFieldMarker }),
  });
  const forgedCredentialText = await forgedCredential.response.text();
  if (forgedCredential.response.status !== 400
    || JSON.parse(forgedCredentialText).error?.code !== "UNEXPECTED_FIELD"
    || forgedCredentialText.includes(unknownFieldMarker) || forgedCredentialText.includes(rejectedApiKey)) {
    throw new Error("tenant credential endpoint did not reject a legacy field without echoing it");
  }
  const forgedRollout = await request(baseUrl, "/api/admin/agent-rollouts/claude-installation-214/rollback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "smoke-forged-agent-rollout",
      "x-deviludo-role": "PlatformAgentAdmin",
    },
    body: JSON.stringify({ toPercent: 0 }),
  });
  const forgedRolloutPayload = await forgedRollout.response.json();
  if (forgedRollout.response.status !== 400 || forgedRolloutPayload.error?.code !== "UNEXPECTED_FIELD") {
    throw new Error("Agent rollout endpoint accepted a caller-supplied rollout target");
  }
  const stateAfterRejectedMutations = await request(baseUrl, "/api/admin/agents");
  const stateAfterRejectedPayload = await stateAfterRejectedMutations.response.json();
  const credentialsBefore = adminPayload.meta?.credentials?.length;
  const credentialsAfter = stateAfterRejectedPayload.meta?.credentials?.length;
  const rolloutBefore = adminPayload.meta?.rollouts?.["claude-installation-214"]?.percent;
  const rolloutAfter = stateAfterRejectedPayload.meta?.rollouts?.["claude-installation-214"]?.percent;
  if (!stateAfterRejectedMutations.response.ok || credentialsAfter !== credentialsBefore || rolloutAfter !== rolloutBefore
    || stateAfterRejectedPayload.meta?.profiles?.length !== adminPayload.meta?.profiles?.length) {
    throw new Error("rejected Agent mutations changed the deployed local control-plane projection");
  }
  const tenantCredential = await request(baseUrl, "/api/settings/agents/credentials", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-tenant-agent-credential-v1" },
    body: JSON.stringify({ label: "Smoke tenant Provider", apiKey: "smoke-local-provider-key-material" }),
  });
  const tenantCredentialText = await tenantCredential.response.text();
  const tenantCredentialPayload = JSON.parse(tenantCredentialText);
  if (![200, 201].includes(tenantCredential.response.status) || !tenantCredentialPayload.data?.id
    || tenantCredentialText.includes("smoke-local-provider-key-material") || tenantCredentialText.includes("secretRef")) {
    throw new Error("tenant Agent credential ingress contract failed");
  }
  const tenantProfile = await request(baseUrl, "/api/settings/agents/profiles", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-tenant-agent-profile-r1" },
    body: JSON.stringify({
      agent: "claude-code",
      installationId: "claude-installation-214",
      credentialVersionId: tenantCredentialPayload.data.id,
      baseUrl: "https://gateway.example.com/v1",
      authentication: "x-api-key",
      primaryModel: "claude-sonnet-4-6-20250514",
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
      dataRegion: "us-east",
      retentionPolicy: "zero application retention",
      trainingPolicy: "no training",
      maxBudgetUsd: 25,
      maxTurns: 100,
      timeoutSeconds: 7200,
    }),
  });
  const tenantProfilePayload = await tenantProfile.response.json();
  if (![200, 201].includes(tenantProfile.response.status)
    || tenantProfilePayload.data?.profile?.scope !== "tenant"
    || tenantProfilePayload.data?.profile?.scopeId !== "tenant-local"
    || tenantProfilePayload.data?.provider?.state !== "DRAFT") {
    throw new Error("tenant Agent Profile draft contract failed");
  }
  const tenantProfileProbe = await request(
    baseUrl,
    `/api/settings/agents/profiles/${encodeURIComponent(tenantProfilePayload.data.profile.id)}/validate`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-tenant-agent-profile-probe-r1" },
      body: "{}",
    },
  );
  const tenantProfileProbePayload = await tenantProfileProbe.response.json();
  if (tenantProfileProbe.response.status !== 503
    || tenantProfileProbePayload.error?.code !== "PROVIDER_PROBE_NOT_CONFIGURED") {
    throw new Error("local tenant Agent Profile probe fabricated an external trust result");
  }
  const invitationGatePayload = await invitationGate.response.json();
  if (invitationGate.response.status !== 503 || invitationGatePayload.error?.code !== "IDENTITY_ADMIN_BROKER_REQUIRED") {
    throw new Error("local admin unexpectedly fabricated a production invitation");
  }
  const sessionPayload = await localSession.response.json();
  if (!localSession.response.ok || sessionPayload.data?.tenantId !== "tenant-local"
    || sessionPayload.data?.githubLogin !== "local-developer" || sessionPayload.data?.role !== "TenantAdmin") {
    throw new Error("local browser session fixture contract failed");
  }
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
  const specHealth = await specRuntime.response.json();
  if (!specRuntime.response.ok || specHealth.service !== "deviludo-local-spec-runtime" || specHealth.mode !== "deterministic-loopback") {
    throw new Error("local specification dialogue service is not ready");
  }
  const specPayload = await specDialogue.response.json();
  if (specDialogue.response.status !== 201 || specPayload.data?.revision !== 1
    || !specPayload.data?.result?.spec || !specPayload.data?.testPlanDigest
    || specPayload.data.result.testPlan.version !== "godot-testkit-1.0.0") {
    throw new Error("local specification dialogue contract failed");
  }
  const specApproval = await request(baseUrl, `/api/projects/${smokeSpecProject}/spec-revisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-spec-approval-1" },
    body: JSON.stringify({
      action: "approve",
      revision: "SPEC-001",
      conversationId: specPayload.data.conversationId,
      expectedRevision: specPayload.data.revision,
      specRevisionId: specPayload.data.specRevisionId,
      testPlanRevisionId: specPayload.data.testPlanRevisionId,
    }),
  });
  const approvalPayload = await specApproval.response.json();
  if (![200, 201].includes(specApproval.response.status) || approvalPayload.data?.authority?.state !== "APPROVED"
    || approvalPayload.data.authority.revision !== 2 || approvalPayload.data.run?.state !== "QUEUED") {
    throw new Error("local specification approval contract failed");
  }
  const validationDialogue = await request(baseUrl, `/api/projects/${smokeValidationProject}/conversation`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-validation-dialogue-1" },
    body: JSON.stringify({ expectedRevision: 0, message: "制作一个用于真实 Godot 验证的固定桌面单机样例" }),
  });
  const validationDialoguePayload = await validationDialogue.response.json();
  if (validationDialogue.response.status !== 201 || validationDialoguePayload.data?.revision !== 1) {
    throw new Error("local validation specification dialogue failed");
  }
  const validationApproval = await request(baseUrl, `/api/projects/${smokeValidationProject}/spec-revisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-validation-approval-1" },
    body: JSON.stringify({
      action: "approve",
      revision: "SPEC-001",
      conversationId: validationDialoguePayload.data.conversationId,
      expectedRevision: validationDialoguePayload.data.revision,
      specRevisionId: validationDialoguePayload.data.specRevisionId,
      testPlanRevisionId: validationDialoguePayload.data.testPlanRevisionId,
    }),
  });
  const validationApprovalPayload = await validationApproval.response.json();
  if (![200, 201].includes(validationApproval.response.status) || validationApprovalPayload.data?.run?.state !== "QUEUED") {
    throw new Error("local validation specification approval failed");
  }
  const localValidation = await request(baseUrl, `/api/projects/${smokeValidationProject}/local-validation`, {
    method: "POST",
    headers: { "idempotency-key": "smoke-local-validation-1" },
  }, 90_000);
  const localValidationPayload = await localValidation.response.json();
  const expectedLocalValidationStatus = localValidationPayload.data?.releaseGate === "WAITING_EXPORT_TEMPLATES"
    ? "WAITING_DEPENDENCY"
    : "TESTS_PASSED";
  if (![200, 201].includes(localValidation.response.status)
    || localValidationPayload.data?.status !== expectedLocalValidationStatus
    || !/^[a-f0-9]{64}$/.test(String(localValidationPayload.data?.bundleDigest))) {
    throw new Error("authenticated local Godot validation did not produce bound evidence");
  }
  const localManifest = await request(baseUrl, `/api/projects/${smokeValidationProject}/local-validation/evidence/manifest.json`);
  const localManifestPayload = await localManifest.response.json();
  if (!localManifest.response.ok
    || localManifestPayload.projectId !== smokeValidationProject
    || localManifestPayload.runId !== validationApprovalPayload.data.run.id
    || localManifestPayload.bundleDigest !== localValidationPayload.data.bundleDigest) {
    throw new Error("authenticated local evidence download did not preserve the validation binding");
  }
  const earlyFeedback = await request(baseUrl, `/api/projects/${smokeValidationProject}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-feedback-too-early" },
    body: JSON.stringify({ feedback: "新手前五分钟最多出现一次风暴" }),
  });
  const earlyFeedbackPayload = await earlyFeedback.response.json();
  if (earlyFeedback.response.status !== 409 || earlyFeedbackPayload.error?.code !== "LOCAL_FEEDBACK_NOT_ALLOWED") {
    throw new Error("local feedback bypassed the candidate E2E acceptance gate");
  }
  let feedbackProject = smokeValidationProject;
  let feedbackDialoguePayload = validationDialoguePayload.data;
  let validationGateBlock = null;
  let validationAcceptance;
  if (localValidationPayload.data?.releaseGate === "WAITING_EXPORT_TEMPLATES") {
    validationGateBlock = await request(baseUrl, `/api/projects/${smokeValidationProject}/delivery`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-validation-export-gate" },
      body: JSON.stringify({ action: "advance" }),
    });
    const gatePayload = await validationGateBlock.response.json();
    if (validationGateBlock.response.status !== 409
      || gatePayload.error?.code !== "LOCAL_EXPORT_TEMPLATES_REQUIRED") {
      throw new Error("missing Godot export templates did not block target-matrix E2E");
    }

    feedbackProject = smokeFeedbackProject;
    const fixtureDialogue = await request(baseUrl, `/api/projects/${feedbackProject}/conversation`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-feedback-dialogue-1" },
      body: JSON.stringify({ expectedRevision: 0, message: "制作一个用于反馈迭代门禁演练的桌面单机样例" }),
    });
    feedbackDialoguePayload = await fixtureDialogue.response.json().then((payload) => payload.data);
    if (fixtureDialogue.response.status !== 201 || feedbackDialoguePayload?.revision !== 1) {
      throw new Error("local feedback fixture dialogue failed");
    }
    const fixtureApproval = await request(baseUrl, `/api/projects/${feedbackProject}/spec-revisions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-feedback-fixture-approval-1" },
      body: JSON.stringify({
        action: "approve",
        revision: "SPEC-001",
        conversationId: feedbackDialoguePayload.conversationId,
        expectedRevision: feedbackDialoguePayload.revision,
        specRevisionId: feedbackDialoguePayload.specRevisionId,
        testPlanRevisionId: feedbackDialoguePayload.testPlanRevisionId,
      }),
    });
    if (fixtureApproval.response.status !== 201) throw new Error("local feedback fixture approval failed");
    for (let index = 0; index < 6; index += 1) {
      validationAcceptance = await request(baseUrl, `/api/projects/${feedbackProject}/delivery`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `smoke-feedback-fixture-e2e-${index + 1}` },
        body: JSON.stringify({ action: "advance" }),
      });
      if (!validationAcceptance.response.ok) throw new Error("local feedback fixture could not reach user acceptance");
    }
  } else {
    for (let index = 0; index < 4; index += 1) {
      validationAcceptance = await request(baseUrl, `/api/projects/${smokeValidationProject}/delivery`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `smoke-validation-e2e-${index + 1}` },
        body: JSON.stringify({ action: "advance" }),
      });
      if (!validationAcceptance.response.ok) throw new Error("local validation candidate could not reach user acceptance");
    }
  }
  const validationAcceptancePayload = await validationAcceptance.response.json();
  if (validationAcceptancePayload.data?.stage !== "AWAITING_ACCEPTANCE"
    || validationAcceptancePayload.data?.evidenceValid !== true) {
    throw new Error("local validation candidate did not freeze its target-matrix evidence");
  }
  const feedbackRequest = {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-feedback-iteration-1" },
    body: JSON.stringify({ feedback: "新手前五分钟最多出现一次风暴，并保持其余验收标准" }),
  };
  const feedbackIteration = await request(baseUrl, `/api/projects/${feedbackProject}/feedback`, feedbackRequest);
  const feedbackIterationPayload = await feedbackIteration.response.json();
  const feedbackSnapshot = feedbackIterationPayload.data?.snapshot;
  if (feedbackIteration.response.status !== 201
    || feedbackSnapshot?.state !== "DRAFT" || feedbackSnapshot.revision !== 3
    || feedbackSnapshot.conversationId === feedbackDialoguePayload.conversationId
    || feedbackIterationPayload.data?.delivery?.stage !== "AWAITING_SPEC_APPROVAL"
    || (feedbackProject === smokeValidationProject
      ? feedbackIterationPayload.data?.delivery?.localValidation?.valid !== false
      : feedbackIterationPayload.data?.delivery?.localValidation !== null)
    || feedbackIterationPayload.data?.delivery?.evidenceValid !== false
    || JSON.stringify(feedbackIterationPayload.data?.delivery?.targetResults) !== JSON.stringify({
      linux: "INVALIDATED", windows: "INVALIDATED", macos: "INVALIDATED",
    })) {
    throw new Error("local feedback did not create a distinct immutable draft and invalidate old evidence");
  }
  const feedbackReplay = await request(baseUrl, `/api/projects/${feedbackProject}/feedback`, feedbackRequest);
  const feedbackReplayPayload = await feedbackReplay.response.json();
  if (feedbackReplay.response.status !== 200
    || feedbackReplayPayload.meta?.idempotentReplay !== true
    || JSON.stringify(feedbackReplayPayload.data?.snapshot) !== JSON.stringify(feedbackSnapshot)) {
    throw new Error("local feedback idempotency did not replay the exact successor draft");
  }
  const iterationApproval = await request(baseUrl, `/api/projects/${feedbackProject}/spec-revisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-feedback-approval-1" },
    body: JSON.stringify({
      action: "approve",
      revision: "SPEC-003",
      conversationId: feedbackSnapshot.conversationId,
      expectedRevision: feedbackSnapshot.revision,
      specRevisionId: feedbackSnapshot.specRevisionId,
      testPlanRevisionId: feedbackSnapshot.testPlanRevisionId,
    }),
  });
  const iterationApprovalPayload = await iterationApproval.response.json();
  if (iterationApproval.response.status !== 201
    || iterationApprovalPayload.data?.authority?.revision !== 4
    || iterationApprovalPayload.data?.run?.state !== "QUEUED"
    || iterationApprovalPayload.data?.run?.id === validationApprovalPayload.data.run.id) {
    throw new Error("local feedback successor could not be approved into a new immutable run");
  }
  const iterationValidation = await request(baseUrl, `/api/projects/${feedbackProject}/local-validation`, {
    method: "POST",
    headers: { "idempotency-key": "smoke-feedback-validation-1" },
  }, 90_000);
  const iterationValidationPayload = await iterationValidation.response.json();
  const expectedIterationStatus = iterationValidationPayload.data?.releaseGate === "WAITING_EXPORT_TEMPLATES"
    ? "WAITING_DEPENDENCY"
    : "TESTS_PASSED";
  if (iterationValidation.response.status !== 201
    || iterationValidationPayload.data?.status !== expectedIterationStatus
    || iterationValidationPayload.data?.bundleDigest === localValidationPayload.data.bundleDigest) {
    throw new Error("local feedback successor did not produce a distinct Godot evidence bundle");
  }
  const iterationManifest = await request(baseUrl, `/api/projects/${feedbackProject}/local-validation/evidence/manifest.json`);
  const iterationManifestPayload = await iterationManifest.response.json();
  if (!iterationManifest.response.ok
    || iterationManifestPayload.runId !== iterationApprovalPayload.data.run.id
    || iterationManifestPayload.bundleDigest !== iterationValidationPayload.data.bundleDigest
    || iterationManifestPayload.runId === localManifestPayload.runId) {
    throw new Error("local feedback successor evidence was not bound to the new run");
  }
  const providerWait = await request(baseUrl, `/api/projects/${smokeSpecProject}/delivery`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-provider-wait-1" },
    body: JSON.stringify({ action: "provider-fail" }),
  });
  const providerWaitPayload = await providerWait.response.json();
  const waitingProfile = JSON.stringify(providerWaitPayload.data?.lockedProfile);
  if (!providerWait.response.ok || providerWaitPayload.data?.stage !== "WAITING_PROVIDER"
    || providerWaitPayload.data?.resumeStage !== "AGENT_QUEUED"
    || providerWaitPayload.data?.events?.[0]?.type !== "PROVIDER_UNAVAILABLE") {
    throw new Error("local Provider outage did not preserve the waiting lock");
  }
  const providerResume = await request(baseUrl, `/api/projects/${smokeSpecProject}/delivery`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-provider-resume-1" },
    body: JSON.stringify({ action: "provider-resume" }),
  });
  const providerResumePayload = await providerResume.response.json();
  if (!providerResume.response.ok || providerResumePayload.data?.stage !== "AGENT_QUEUED"
    || providerResumePayload.data?.resumeStage !== null
    || providerResumePayload.data?.events?.[0]?.type !== "PROVIDER_RESUMED"
    || JSON.stringify(providerResumePayload.data?.lockedProfile) !== waitingProfile) {
    throw new Error("local Provider recovery changed the immutable Agent lock");
  }
  const failureActions = [
    "advance", "advance", "advance", "advance", "advance", "advance", "accept", "advance", "main-gate-fail",
  ];
  let acceptanceBypass;
  let acceptanceReplay;
  let postMergeFailure;
  for (const [index, action] of failureActions.entries()) {
    if (action === "accept") {
      acceptanceBypass = await request(baseUrl, `/api/projects/${smokeSpecProject}/delivery`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "smoke-acceptance-bypass" },
        body: JSON.stringify({ action }),
      });
      const bypassPayload = await acceptanceBypass.response.json();
      if (acceptanceBypass.response.status !== 400 || bypassPayload.error?.code !== "UNSUPPORTED_ACTION") {
        throw new Error("generic local delivery endpoint accepted candidate authority");
      }
    }
    const operationKey = `smoke-post-merge-${index + 1}`;
    postMergeFailure = await localWorkflowAction(baseUrl, smokeSpecProject, operationKey, action);
    if (!postMergeFailure.response.ok) {
      throw new Error(`local post-merge failure action ${action} was rejected`);
    }
    if (action === "accept") {
      const acceptancePayload = await postMergeFailure.response.clone().json();
      if (postMergeFailure.response.status !== 201 || acceptancePayload.data?.stage !== "MERGING"
        || acceptancePayload.meta?.idempotentReplay !== false) {
        throw new Error("formal candidate acceptance did not enter the merge gate");
      }
      acceptanceReplay = await localWorkflowAction(baseUrl, smokeSpecProject, operationKey, action);
      const replayPayload = await acceptanceReplay.response.json();
      if (acceptanceReplay.response.status !== 200 || replayPayload.data?.stage !== "MERGING"
        || replayPayload.meta?.idempotentReplay !== true) {
        throw new Error("formal candidate acceptance did not replay the exact decision");
      }
    }
  }
  const postMergeFailurePayload = await postMergeFailure.response.json();
  if (postMergeFailurePayload.data?.stage !== "AWAITING_SPEC_APPROVAL"
    || postMergeFailurePayload.data?.repairHandoff?.reason !== "MAIN_GATE_FAILURE"
    || postMergeFailurePayload.data?.repairHandoff?.baselineMainSha !== "f21c0de"
    || postMergeFailurePayload.data?.mainSha !== null
    || postMergeFailurePayload.data?.steamBranch !== null
    || postMergeFailurePayload.data?.mfaApprovalId !== null
    || postMergeFailurePayload.data?.steamBuildId !== null
    || postMergeFailurePayload.data?.steamReleaseId !== null
    || !Array.isArray(postMergeFailurePayload.data?.externalApprovals)
    || postMergeFailurePayload.data.externalApprovals.length !== 0
    || postMergeFailurePayload.data?.evidenceValid !== false) {
    throw new Error("local post-merge failure did not revoke release authority");
  }
  const cancellation = await request(baseUrl, `/api/projects/${smokeSpecProject}/delivery`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-delivery-cancel-1" },
    body: JSON.stringify({ action: "cancel", reason: "local smoke cancellation" }),
  });
  const cancellationPayload = await cancellation.response.json();
  if (!cancellation.response.ok || cancellationPayload.data?.stage !== "CANCELLED"
    || cancellationPayload.data?.evidenceValid !== false
    || cancellationPayload.data?.steamBranch !== null
    || cancellationPayload.data?.events?.[0]?.type !== "DELIVERY_CANCELLED") {
    throw new Error("local cancellation did not revoke delivery authority");
  }
  const releaseDialogue = await request(baseUrl, `/api/projects/${smokeReleaseProject}/conversation`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-release-dialogue-1" },
    body: JSON.stringify({ expectedRevision: 0, message: "制作一款可完整演练 Steam 顺序发布门禁的桌面单机游戏" }),
  });
  const releaseDialoguePayload = await releaseDialogue.response.json();
  if (![200, 201].includes(releaseDialogue.response.status) || releaseDialoguePayload.data?.revision !== 1) {
    throw new Error("local release-gate dialogue contract failed");
  }
  const releaseApproval = await request(baseUrl, `/api/projects/${smokeReleaseProject}/spec-revisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-release-approval-1" },
    body: JSON.stringify({
      action: "approve", revision: "SPEC-001",
      conversationId: releaseDialoguePayload.data.conversationId,
      expectedRevision: releaseDialoguePayload.data.revision,
      specRevisionId: releaseDialoguePayload.data.specRevisionId,
      testPlanRevisionId: releaseDialoguePayload.data.testPlanRevisionId,
    }),
  });
  const releaseApprovalPayload = await releaseApproval.response.json();
  if (![200, 201].includes(releaseApproval.response.status)
    || releaseApprovalPayload.data?.run?.agent !== "claude-code"
    || releaseApprovalPayload.data?.run?.profileRevisionId !== "profile-claude-platform-r5"
    || releaseApprovalPayload.data?.run?.configurationSource !== `project:${smokeReleaseProject}`) {
    throw new Error("local release-gate approval did not lock the selected Claude Profile");
  }
  const releaseActions = [
    "advance", "advance", "advance", "advance", "advance", "advance",
    "accept", "advance", "advance", "confirm-mfa", "advance", "advance",
    "external-approve", "external-approve", "external-approve",
  ];
  let completedRelease;
  for (const [index, action] of releaseActions.entries()) {
    completedRelease = await localWorkflowAction(
      baseUrl, smokeReleaseProject, `smoke-release-gate-${index + 1}`, action,
    );
    if (!completedRelease.response.ok) throw new Error(`local release-gate action ${action} was rejected`);
  }
  const completedReleasePayload = await completedRelease.response.json();
  if (completedReleasePayload.data?.stage !== "RELEASED"
    || completedReleasePayload.data?.externalGate !== null
    || JSON.stringify(completedReleasePayload.data?.externalApprovals) !== JSON.stringify([
      "LOCAL_VALVE_REVIEW_APPROVED", "LOCAL_FIRST_RELEASE_COMPLETED", "LOCAL_DEFAULT_BRANCH_CONFIRMED",
    ])
    || completedReleasePayload.data?.events?.[0]?.type !== "DEFAULT_BRANCH_CONFIRMED") {
    throw new Error("local release did not preserve all three ordered external approvals");
  }
  const codexDialogue = await request(baseUrl, `/api/projects/${smokeCodexProject}/conversation`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-codex-dialogue-1" },
    body: JSON.stringify({ expectedRevision: 0, message: "使用 Codex Profile 开发同一套 Godot 桌面交付样例" }),
  });
  const codexDialoguePayload = await codexDialogue.response.json();
  if (![200, 201].includes(codexDialogue.response.status) || codexDialoguePayload.data?.revision !== 1) {
    throw new Error("local Codex specification dialogue contract failed");
  }
  const codexApproval = await request(baseUrl, `/api/projects/${smokeCodexProject}/spec-revisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-codex-approval-1" },
    body: JSON.stringify({
      action: "approve", revision: "SPEC-001",
      conversationId: codexDialoguePayload.data.conversationId,
      expectedRevision: codexDialoguePayload.data.revision,
      specRevisionId: codexDialoguePayload.data.specRevisionId,
      testPlanRevisionId: codexDialoguePayload.data.testPlanRevisionId,
    }),
  });
  const codexApprovalPayload = await codexApproval.response.json();
  if (![200, 201].includes(codexApproval.response.status)
    || codexApprovalPayload.data?.run?.agent !== "codex-cli"
    || codexApprovalPayload.data?.run?.profileRevisionId !== "profile-codex-platform-r2"
    || codexApprovalPayload.data?.run?.configurationSource !== `project:${smokeCodexProject}`
    || codexApprovalPayload.data?.run?.providerProtocol !== "openai-responses") {
    throw new Error("local Codex specification approval did not freeze the selected Profile");
  }
  let completedCodexRelease;
  for (const [index, action] of releaseActions.entries()) {
    completedCodexRelease = await localWorkflowAction(
      baseUrl, smokeCodexProject, `smoke-codex-release-${index + 1}`, action,
    );
    if (!completedCodexRelease.response.ok) throw new Error(`local Codex release action ${action} was rejected`);
  }
  const completedCodexPayload = await completedCodexRelease.response.json();
  if (completedCodexPayload.data?.stage !== "RELEASED"
    || completedCodexPayload.data?.lockedProfile?.agent !== "codex-cli"
    || completedCodexPayload.data?.lockedProfile?.profileRevisionId !== "profile-codex-platform-r2"
    || JSON.stringify(completedCodexPayload.data?.targetResults) !== JSON.stringify({ linux: "PASSED", windows: "PASSED", macos: "PASSED" })) {
    throw new Error("local Codex Profile did not remain locked through the complete release chain");
  }
  const preflightPayload = await agentPreflight.response.json();
  if (!agentPreflight.response.ok || !preflightPayload.data || !["BLOCKED", "READY"].includes(preflightPayload.data.status)) {
    throw new Error("local Agent preflight contract failed");
  }
  const executionGatePayload = await agentExecutionGate.response.json();
  if (![409, 503].includes(agentExecutionGate.response.status)
    || !["INSTALLATION_UNAVAILABLE", "INSTALLATION_MISMATCH", "WORKER_IMAGE_MISMATCH", "WAITING_PROVIDER", "EXECUTION_DISABLED", "LOCAL_AGENT_EXECUTOR_NOT_CONFIGURED"].includes(executionGatePayload.error?.code)) {
    throw new Error("local Agent execution gate did not fail closed");
  }
  const forgedAgentRequestPayload = await forgedAgentRequest.response.json();
  if (forgedAgentRequest.response.status !== 403
    || forgedAgentRequestPayload.error?.code !== "LOCAL_AGENT_RUNTIME_AUTH_REQUIRED") {
    throw new Error("local Agent runtime accepted the legacy static header without a signed assertion");
  }
  const forgedRuntimeRequestPayload = await forgedRuntimeRequest.response.json();
  if (forgedRuntimeRequest.response.status !== 403
    || forgedRuntimeRequestPayload.error?.code !== "LOCAL_RUNTIME_AUTH_REQUIRED") {
    throw new Error("local Godot runtime accepted the legacy static header without a signed assertion");
  }
  const forgedSpecRequestPayload = await forgedSpecRequest.response.json();
  if (forgedSpecRequest.response.status !== 403
    || forgedSpecRequestPayload.error?.code !== "LOCAL_SPEC_RUNTIME_AUTH_REQUIRED") {
    throw new Error("local specification runtime accepted the legacy static header without a signed assertion");
  }
  const runnerIngressPayload = await runnerIngress.response.json();
  if (runnerIngress.response.status !== 503 || runnerIngressPayload.error?.code !== "RUNNER_MTLS_INGRESS_REQUIRED") {
    throw new Error("public Web process unexpectedly accepted a Runner event write");
  }
  const githubAuthorizationPayload = await githubAuthorization.response.json();
  if (githubAuthorization.response.status !== 503 || githubAuthorizationPayload.error?.code !== "GITHUB_APP_INSTALLATION_BROKER_REQUIRED") {
    throw new Error("public Web process fabricated a GitHub App authorization");
  }
  const steamEnrollmentPayload = await steamEnrollment.response.json();
  if (steamEnrollment.response.status !== 503 || steamEnrollmentPayload.error?.code !== "STEAM_GUARD_ENROLLMENT_BROKER_REQUIRED") {
    throw new Error("public Web process fabricated a Steam Guard session");
  }
  const steamProjectConfigurationPayload = await steamProjectConfiguration.response.json();
  if (steamProjectConfiguration.response.status !== 503
    || steamProjectConfigurationPayload.error?.code !== "STEAM_PROJECT_CONFIGURATION_BROKER_REQUIRED"
    || /SecretRef|branchPassword|branch_password|privateBeta/.test(JSON.stringify(steamProjectConfigurationPayload))) {
    throw new Error("local Web process fabricated or exposed a Steam project release configuration");
  }
  const steamPublishPayload = await steamPublish.response.json();
  if (steamPublish.response.status !== 503 || steamPublishPayload.error?.code !== "STEAM_PUBLISH_DISPATCH_REQUIRED") {
    throw new Error("public Web process accepted client-asserted Steam release gates");
  }

  console.log(`✓ GET /              ${home.response.status} (${home.elapsedMs}ms) · HTML shell`);
  console.log(`✓ GET /login         ${login.response.status} (${login.elapsedMs}ms) · invite-only login`);
  console.log(`✓ GET /projects      ${projects.response.status} (${projects.elapsedMs}ms) · project catalog`);
  console.log(`✓ GET /runners       ${runnersPage.response.status} (${runnersPage.elapsedMs}ms) · project-scoped runners`);
  console.log(`✓ GET /evidence      ${evidencePage.response.status} (${evidencePage.elapsedMs}ms) · project-scoped evidence`);
  console.log(`✓ Project catalog    ${projectCatalog.response.status} (${projectCatalog.elapsedMs}ms) · ${projectCatalogPayload.data.length} accessible`);
  console.log(`✓ GET /admin/agents  ${admin.response.status} (${admin.elapsedMs}ms) · Agent console`);
  console.log(`✓ GET /admin/invitations ${invitations.response.status} (${invitations.elapsedMs}ms) · invite console`);
  console.log(`✓ GET /settings/agents ${tenantAgents.response.status} (${tenantAgents.elapsedMs}ms) · tenant Agent settings`);
  console.log(`✓ GET project Agent   ${projectAgents.response.status} (${projectAgents.elapsedMs}ms) · inherited Profile selector`);
  console.log(`✓ GET project Steam   ${steamSettingsPage.response.status} (${steamSettingsPage.elapsedMs}ms) · isolated release settings`);
  console.log(`✓ Admin state        ${adminState.response.status} (${adminState.elapsedMs}ms) · default=${adminPayload.meta.defaultAgent}`);
  console.log(`✓ Agent inheritance  ${adminState.response.status} (${adminState.elapsedMs}ms) · platform/tenant/project bound`);
  console.log(`✓ Tenant Agent state ${tenantAgentState.response.status} (${tenantAgentState.elapsedMs}ms) · scoped projection`);
  console.log(`✓ Agent body contract ${forgedTenantProfile.response.status}/${forgedCredential.response.status}/${forgedRollout.response.status} · unknown fields rejected without state drift`);
  console.log(`✓ Tenant Agent write ${tenantProfile.response.status} (${tenantProfile.elapsedMs}ms) · scoped immutable draft`);
  console.log(`✓ Provider probe gate ${tenantProfileProbe.response.status} (${tenantProfileProbe.elapsedMs}ms) · external trust required`);
  console.log(`✓ Invitation gate    ${invitationGate.response.status} (${invitationGate.elapsedMs}ms) · ${invitationGatePayload.error.code}`);
  console.log(`✓ Local session      ${localSession.response.status} (${localSession.elapsedMs}ms) · @${sessionPayload.data.githubLogin}`);
  console.log(`✓ GET /api/health    ${health.response.status} (${health.elapsedMs}ms) · status=ok`);
  console.log(`✓ Local runtime     ${runtime.response.status} (${runtime.elapsedMs}ms) · Godot ${runtimeHealth.godotVersion}`);
  console.log(`✓ Agent readiness   ${agentRuntime.response.status} (${agentRuntime.elapsedMs}ms) · ${agentSummary}`);
  console.log(`✓ Spec dialogue     ${specDialogue.response.status} (${specDialogue.elapsedMs}ms) · revision=${specPayload.data.revision}`);
  console.log(`✓ Spec approval     ${specApproval.response.status} (${specApproval.elapsedMs}ms) · revision=${approvalPayload.data.authority.revision}`);
  console.log(`✓ Godot validation ${localValidation.response.status} (${localValidation.elapsedMs}ms) · ${localValidationPayload.data.releaseGate}`);
  console.log(validationGateBlock
    ? `✓ Export dependency ${validationGateBlock.response.status} (${validationGateBlock.elapsedMs}ms) · target E2E blocked`
    : "✓ Export dependency ready · production export authorized target E2E");
  console.log(`✓ Evidence download ${localManifest.response.status} (${localManifest.elapsedMs}ms) · signed sidecar request`);
  console.log(`✓ Feedback gate     ${earlyFeedback.response.status} (${earlyFeedback.elapsedMs}ms) · ${earlyFeedbackPayload.error.code}`);
  console.log(`✓ Feedback draft    ${feedbackIteration.response.status} (${feedbackIteration.elapsedMs}ms) · revision ${feedbackSnapshot.revision} → approved ${iterationApprovalPayload.data.authority.revision}`);
  console.log(`✓ Iteration E2E     ${iterationValidation.response.status} (${iterationValidation.elapsedMs}ms) · distinct signed Godot evidence`);
  console.log(`✓ Provider recovery ${providerResume.response.status} (${providerResume.elapsedMs}ms) · same immutable Profile`);
  console.log(`✓ Acceptance bypass ${acceptanceBypass.response.status} (${acceptanceBypass.elapsedMs}ms) · generic delivery rejected`);
  console.log(`✓ Acceptance replay 201/${acceptanceReplay.response.status} (${acceptanceReplay.elapsedMs}ms) · formal empty-body decision`);
  console.log(`✓ Failure handoff  ${postMergeFailure.response.status} (${postMergeFailure.elapsedMs}ms) · ${postMergeFailurePayload.data.repairHandoff.reason}`);
  console.log(`✓ Delivery cancel ${cancellation.response.status} (${cancellation.elapsedMs}ms) · ${cancellationPayload.data.stage}`);
  console.log(`✓ Ordered Steam gates ${completedRelease.response.status} (${completedRelease.elapsedMs}ms) · ${completedReleasePayload.data.externalApprovals.length}/3 → ${completedReleasePayload.data.stage}`);
  console.log(`✓ Dual Agent release ${completedCodexRelease.response.status} (${completedCodexRelease.elapsedMs}ms) · Claude Code + Codex CLI locked end-to-end`);
  console.log(`✓ Agent preflight   ${agentPreflight.response.status} (${agentPreflight.elapsedMs}ms) · ${preflightPayload.data.code}`);
  console.log(`✓ Agent execution   ${agentExecutionGate.response.status} (${agentExecutionGate.elapsedMs}ms) · ${executionGatePayload.error.code}`);
  console.log(`✓ Agent auth gate   ${forgedAgentRequest.response.status} (${forgedAgentRequest.elapsedMs}ms) · ${forgedAgentRequestPayload.error.code}`);
  console.log(`✓ Godot auth gate   ${forgedRuntimeRequest.response.status} (${forgedRuntimeRequest.elapsedMs}ms) · ${forgedRuntimeRequestPayload.error.code}`);
  console.log(`✓ Spec auth gate    ${forgedSpecRequest.response.status} (${forgedSpecRequest.elapsedMs}ms) · ${forgedSpecRequestPayload.error.code}`);
  console.log(`✓ Runner ingress    ${runnerIngress.response.status} (${runnerIngress.elapsedMs}ms) · ${runnerIngressPayload.error.code}`);
  console.log(`✓ GitHub auth       ${githubAuthorization.response.status} (${githubAuthorization.elapsedMs}ms) · ${githubAuthorizationPayload.error.code}`);
  console.log(`✓ Steam enrollment  ${steamEnrollment.response.status} (${steamEnrollment.elapsedMs}ms) · ${steamEnrollmentPayload.error.code}`);
  console.log(`✓ Steam config      ${steamProjectConfiguration.response.status} (${steamProjectConfiguration.elapsedMs}ms) · ${steamProjectConfigurationPayload.error.code}`);
  console.log(`✓ Steam publish     ${steamPublish.response.status} (${steamPublish.elapsedMs}ms) · ${steamPublishPayload.error.code}`);
  console.log("[local:smoke] All local smoke checks passed.");
} catch (error) {
  console.error(`[local:smoke] ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[local:smoke] Confirm that \`npm run local:dev -- --port ${port}\` is still running.`);
  process.exitCode = 1;
}
