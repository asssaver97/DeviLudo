#!/usr/bin/env node

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_LOCAL_RUNTIME_PORT = 4311;
const DEFAULT_LOCAL_AGENT_RUNTIME_PORT = 4312;
const DEFAULT_LOCAL_SPEC_RUNTIME_PORT = 4313;
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

try {
  const health = await waitForHealth(baseUrl);
  const [home, login, projects, runnersPage, evidencePage, admin, invitations, tenantAgents, projectAgents, projectCatalog, adminState, tenantAgentState, invitationGate, localSession, runtime, agentRuntime, specRuntime, specDialogue, agentPreflight, agentExecutionGate, runnerIngress, githubAuthorization, steamEnrollment, steamPublish] = await Promise.all([
    checkHtmlRoute(baseUrl, "/", "DeviLudo"),
    checkHtmlRoute(baseUrl, "/login", "受邀登录"),
    checkHtmlRoute(baseUrl, "/projects", "游戏项目"),
    checkHtmlRoute(baseUrl, "/runners", "运行节点"),
    checkHtmlRoute(baseUrl, "/evidence", "证据中心"),
    checkHtmlRoute(baseUrl, "/admin/agents", "Agent"),
    checkHtmlRoute(baseUrl, "/admin/invitations", "受邀账号管理"),
    checkHtmlRoute(baseUrl, "/settings/agents", "开发 Agent"),
    checkHtmlRoute(baseUrl, "/projects/ember-archipelago/agent-settings", "项目 Agent 选择"),
    request(baseUrl, "/api/projects"),
    request(baseUrl, "/api/admin/agents"),
    request(baseUrl, "/api/settings/agents"),
    request(baseUrl, "/api/admin/invitations", { method: "POST" }),
    request(baseUrl, "/api/auth/session"),
    request(runtimeUrl, "/health"),
    request(agentRuntimeUrl, "/health"),
    request(specRuntimeUrl, "/health"),
    request(baseUrl, "/api/projects/smoke-spec/conversation", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-spec-dialogue-1" },
      body: JSON.stringify({ expectedRevision: 0, message: "制作一款十分钟一局的 2D 桌面单机游戏" }),
    }),
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
    request(baseUrl, "/api/connections/github", {
      method: "POST",
      headers: { "idempotency-key": "smoke-github-authorization" },
    }),
    request(baseUrl, "/api/connections/steam", { method: "POST" }),
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
  const specApproval = await request(baseUrl, "/api/projects/smoke-spec/spec-revisions", {
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
  const failureActions = [
    "advance", "advance", "advance", "advance", "advance", "advance", "accept", "advance", "main-gate-fail",
  ];
  let postMergeFailure;
  for (const [index, action] of failureActions.entries()) {
    postMergeFailure = await request(baseUrl, "/api/projects/smoke-spec/delivery", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `smoke-post-merge-${index + 1}` },
      body: JSON.stringify({ action }),
    });
    if (!postMergeFailure.response.ok) {
      throw new Error(`local post-merge failure action ${action} was rejected`);
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
  const cancellation = await request(baseUrl, "/api/projects/smoke-spec/delivery", {
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
  const releaseDialogue = await request(baseUrl, "/api/projects/smoke-release-gates/conversation", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-release-dialogue-1" },
    body: JSON.stringify({ expectedRevision: 0, message: "制作一款可完整演练 Steam 顺序发布门禁的桌面单机游戏" }),
  });
  const releaseDialoguePayload = await releaseDialogue.response.json();
  if (![200, 201].includes(releaseDialogue.response.status) || releaseDialoguePayload.data?.revision !== 1) {
    throw new Error("local release-gate dialogue contract failed");
  }
  const releaseApproval = await request(baseUrl, "/api/projects/smoke-release-gates/spec-revisions", {
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
  if (![200, 201].includes(releaseApproval.response.status)) throw new Error("local release-gate approval was rejected");
  const releaseActions = [
    "advance", "advance", "advance", "advance", "advance", "advance",
    "accept", "advance", "advance", "confirm-mfa", "advance", "advance",
    "external-approve", "external-approve", "external-approve",
  ];
  let completedRelease;
  for (const [index, action] of releaseActions.entries()) {
    completedRelease = await request(baseUrl, "/api/projects/smoke-release-gates/delivery", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `smoke-release-gate-${index + 1}` },
      body: JSON.stringify({ action }),
    });
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
  const githubAuthorizationPayload = await githubAuthorization.response.json();
  if (githubAuthorization.response.status !== 503 || githubAuthorizationPayload.error?.code !== "GITHUB_APP_INSTALLATION_BROKER_REQUIRED") {
    throw new Error("public Web process fabricated a GitHub App authorization");
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
  console.log(`✓ GET /login         ${login.response.status} (${login.elapsedMs}ms) · invite-only login`);
  console.log(`✓ GET /projects      ${projects.response.status} (${projects.elapsedMs}ms) · project catalog`);
  console.log(`✓ GET /runners       ${runnersPage.response.status} (${runnersPage.elapsedMs}ms) · project-scoped runners`);
  console.log(`✓ GET /evidence      ${evidencePage.response.status} (${evidencePage.elapsedMs}ms) · project-scoped evidence`);
  console.log(`✓ Project catalog    ${projectCatalog.response.status} (${projectCatalog.elapsedMs}ms) · ${projectCatalogPayload.data.length} accessible`);
  console.log(`✓ GET /admin/agents  ${admin.response.status} (${admin.elapsedMs}ms) · Agent console`);
  console.log(`✓ GET /admin/invitations ${invitations.response.status} (${invitations.elapsedMs}ms) · invite console`);
  console.log(`✓ GET /settings/agents ${tenantAgents.response.status} (${tenantAgents.elapsedMs}ms) · tenant Agent settings`);
  console.log(`✓ GET project Agent   ${projectAgents.response.status} (${projectAgents.elapsedMs}ms) · inherited Profile selector`);
  console.log(`✓ Admin state        ${adminState.response.status} (${adminState.elapsedMs}ms) · default=${adminPayload.meta.defaultAgent}`);
  console.log(`✓ Agent inheritance  ${adminState.response.status} (${adminState.elapsedMs}ms) · platform/tenant/project bound`);
  console.log(`✓ Tenant Agent state ${tenantAgentState.response.status} (${tenantAgentState.elapsedMs}ms) · scoped projection`);
  console.log(`✓ Invitation gate    ${invitationGate.response.status} (${invitationGate.elapsedMs}ms) · ${invitationGatePayload.error.code}`);
  console.log(`✓ Local session      ${localSession.response.status} (${localSession.elapsedMs}ms) · @${sessionPayload.data.githubLogin}`);
  console.log(`✓ GET /api/health    ${health.response.status} (${health.elapsedMs}ms) · status=ok`);
  console.log(`✓ Local runtime     ${runtime.response.status} (${runtime.elapsedMs}ms) · Godot ${runtimeHealth.godotVersion}`);
  console.log(`✓ Agent readiness   ${agentRuntime.response.status} (${agentRuntime.elapsedMs}ms) · ${agentSummary}`);
  console.log(`✓ Spec dialogue     ${specDialogue.response.status} (${specDialogue.elapsedMs}ms) · revision=${specPayload.data.revision}`);
  console.log(`✓ Spec approval     ${specApproval.response.status} (${specApproval.elapsedMs}ms) · revision=${approvalPayload.data.authority.revision}`);
  console.log(`✓ Failure handoff  ${postMergeFailure.response.status} (${postMergeFailure.elapsedMs}ms) · ${postMergeFailurePayload.data.repairHandoff.reason}`);
  console.log(`✓ Delivery cancel ${cancellation.response.status} (${cancellation.elapsedMs}ms) · ${cancellationPayload.data.stage}`);
  console.log(`✓ Ordered Steam gates ${completedRelease.response.status} (${completedRelease.elapsedMs}ms) · ${completedReleasePayload.data.externalApprovals.length}/3 → ${completedReleasePayload.data.stage}`);
  console.log(`✓ Agent preflight   ${agentPreflight.response.status} (${agentPreflight.elapsedMs}ms) · ${preflightPayload.data.code}`);
  console.log(`✓ Agent execution   ${agentExecutionGate.response.status} (${agentExecutionGate.elapsedMs}ms) · ${executionGatePayload.error.code}`);
  console.log(`✓ Runner ingress    ${runnerIngress.response.status} (${runnerIngress.elapsedMs}ms) · ${runnerIngressPayload.error.code}`);
  console.log(`✓ GitHub auth       ${githubAuthorization.response.status} (${githubAuthorization.elapsedMs}ms) · ${githubAuthorizationPayload.error.code}`);
  console.log(`✓ Steam enrollment  ${steamEnrollment.response.status} (${steamEnrollment.elapsedMs}ms) · ${steamEnrollmentPayload.error.code}`);
  console.log(`✓ Steam publish     ${steamPublish.response.status} (${steamPublish.elapsedMs}ms) · ${steamPublishPayload.error.code}`);
  console.log("[local:smoke] All local smoke checks passed.");
} catch (error) {
  console.error(`[local:smoke] ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[local:smoke] Confirm that \`npm run local:dev -- --port ${port}\` is still running.`);
  process.exitCode = 1;
}
