import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local deployment keeps Core private by default and exposes it only for explicit remote E2E", async () => {
  const compose = await readFile(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  const coreImage = await readFile(new URL("../Dockerfile.core", import.meta.url), "utf8");
  const executorImage = await readFile(new URL("../Dockerfile.executor", import.meta.url), "utf8");
  const [claudeAgentImage, codexAgentImage] = await Promise.all([
    readFile(new URL("../Dockerfile.agent-claude", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile.agent-codex", import.meta.url), "utf8"),
  ]);
  assert.match(compose, /x-core: &core[\s\S]*image: deviludo-core:local/);
  for (const service of ["core-api", "core-scheduler", "core-sandbox"]) {
    assert.match(compose, new RegExp(`\\n  ${service}:\\n    <<: \\*core`));
  }
  assert.match(compose, /web:[\s\S]*127\.0\.0\.1:\$\{DEVILUDO_WEB_HOST_PORT:-3100\}:3000/);
  assert.match(compose, /core-api:[\s\S]*\$\{DEVILUDO_CORE_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{DEVILUDO_CORE_HOST_PORT:-8080\}:8080/);
  assert.match(compose, /minio:[\s\S]*\$\{DEVILUDO_ARTIFACT_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{DEVILUDO_MINIO_HOST_PORT:-39000\}:9000/);
  assert.match(compose, /DEVILUDO_CLAUDE_CODE_VERSION/);
  assert.match(compose, /DEVILUDO_CODEX_CLI_VERSION/);
  assert.match(compose, /NPM_CONFIG_REGISTRY: \$\{DEVILUDO_NPM_REGISTRY:-https:\/\/registry\.npmjs\.org\/\}/);
  assert.match(coreImage, /ARG CODEX_CLI_VERSION=0\.149\.0/);
  assert.match(coreImage, /DEVILUDO_BUNDLED_CODEX_CLI_VERSION=\$\{CODEX_CLI_VERSION\}/);
  assert.match(codexAgentImage, /ARG CODEX_CLI_VERSION=0\.149\.0/);
  assert.match(compose, /DEVILUDO_CODEX_ACCOUNT_DEFAULT_MODEL/);
  assert.match(compose, /DEVILUDO_CODEX_MODELS_CACHE_FILE: \/run\/deviludo-codex\/models_cache\.json/);
  assert.match(compose, /DEVILUDO_CODEX_RUN_ROOT: \/var\/lib\/deviludo-codex/);
  assert.match(compose, /codex-models-cache\.json:\/run\/deviludo-codex\/models_cache\.json:ro/);
  assert.match(compose, /\/var\/lib\/deviludo-codex:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=1001,gid=1001/);
  assert.match(compose, /DEVILUDO_SANDBOX_CONCURRENCY: \$\{DEVILUDO_SANDBOX_CONCURRENCY:-1\}/);
  assert.match(compose, /DEVILUDO_INSTALLATION_ID: \$\{DEVILUDO_INSTALLATION_ID:-\}/);
  assert.match(compose, /project-sources-init:[\s\S]*cap_add: \["CHOWN", "FOWNER", "FSETID"\][\s\S]*chmod 2770 \/var\/lib\/deviludo-projects/);
  const webSection = compose.match(/\n  web:([\s\S]*?)\nnetworks:/)?.[1] ?? "";
  assert.doesNotMatch(webSection, /DATABASE_URL|VAULT|OBJECT_STORE|S3_/);
  assert.match(webSection, /- edge[\s\S]*- core/);
  assert.doesNotMatch(webSection, /- data/);
  const vaultInit = await readFile(new URL("../infra/vault/local-init.sh", import.meta.url), "utf8");
  assert.match(vaultInit, /issue_service_token api deviludo-api 1001:1001 0400/);
  assert.match(vaultInit, /mv -f "\$temporary" "\/tokens\/\$\{name\}\.token"/);
  assert.doesNotMatch(vaultInit, /chown 1001:1001 \/tokens\/(?:root|executor)\.token/);
  const localMac = await readFile(new URL("../scripts/local-macos-e2e.mjs", import.meta.url), "utf8");
  assert.match(localMac, /const \{ main \} = await import\("\.\.\/services\/e2e-node\/src\/main\.ts"\);/);
  assert.match(localMac, /await main\(\);/);
  const localE2eDaemon = await readFile(new URL("../scripts/local-e2e-daemon.mjs", import.meta.url), "utf8");
  assert.match(localE2eDaemon, /await stopManagedGuestRunners\(\)/);
  assert.match(localE2eDaemon, /guestRunnerPath[\s\S]*local-tart-guest-runner\.mjs/);
  assert.match(localE2eDaemon, /process\.kill\(pid, "SIGTERM"\)[\s\S]*signalProcessGroup\(pid, "SIGKILL"\)/);
  const tartGuest = await readFile(new URL("../scripts/executors/local-tart-guest-runner.mjs", import.meta.url), "utf8");
  assert.match(tartGuest, /tart-e2e\.json/);
  assert.match(tartGuest, /DEVILUDO_E2E_HOST_OUTPUT/);
  assert.match(tartGuest, /HostKeyAlias=deviludo-tart-guest/);
  assert.match(tartGuest, /\/usr\/local\/lib\/deviludo\/executors\/godot-window-e2e-guest\.mjs/);
  const localUp = await readFile(new URL("../scripts/local-up.mjs", import.meta.url), "utf8");
  assert.match(localUp, /stopLocalE2e/);
  assert.match(localUp, /fingerprintLocalTartE2eRuntimeInputs\(\)/);
  assert.match(localUp, /"e2e-macos", imageInputFingerprint, e2eRuntimeFingerprint/);
  assert.match(localUp, /retainActiveJobRuntimeImages\(baseEnvironment\)/);
  assert.match(localUp, /state IN \('QUEUED', 'RETRY', 'RUNNING'\)/);
  assert.match(localUp, /deviludo-retained-job-runtime/);
  assert.match(localUp, /DEVILUDO_EXECUTOR_ALLOWED_IMAGES: \[\.\.\.new Set\(\[\s*\.\.\.Object\.values\(JSON\.parse\(runtimeImages\)\), imageIds\["deviludo-agent-fixture:local"\], \.\.\.retainedJobRuntimeImages/);
  assert.match(localUp, /persistLocalComposeEnvironment\(environment\)/);
  assert.match(localUp, /resolveMachineInstallationId\(\)/);
  assert.match(localUp, /resolveLocalCodexAccountDefaultModel\(detectedCodexLoginMethod, detectedCodexVersion\)/);
  assert.match(localUp, /DEVILUDO_DOCKER_GID/);
  assert.match(localUp, /BEGIN DEVILUDO LOCAL RUNTIME/);
  assert.match(localUp, /detectLocalProviderUpstreamProxy\(\)/);
  assert.match(localUp, /npm["], \["config", "get", "registry"\]/);
  assert.match(localUp, /DEVILUDO_NPM_REGISTRY: npmRegistry/);
  assert.match(localUp, /198\.18\.0\.0\/15 fake IP/);
  assert.match(localUp, /supportsHttpConnectProxy/);
  assert.match(localUp, /optionValue\("--remote-e2e"\)/);
  assert.match(localUp, /isPrivateNetworkIpv4/);
  assert.match(localUp, /networkInterfaces\(\)/);
  assert.match(localUp, /not assigned to a local network interface/);
  assert.match(localUp, /DEVILUDO_CORE_BIND_ADDRESS: remoteE2eHost \? "0\.0\.0\.0" : "127\.0\.0\.1"/);
  assert.match(localUp, /DEVILUDO_ARTIFACT_BIND_ADDRESS: remoteE2eHost \? "0\.0\.0\.0" : "127\.0\.0\.1"/);
  assert.match(localUp, /coreUrl: process\.env\.DEVILUDO_CORE_API_URL\?\.trim\(\) \|\| remoteE2eConfiguration\.coreUrl/);
  assert.match(localUp, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(compose, /DEVILUDO_PROVIDER_UPSTREAM_PROXY/);
  assert.match(compose, /api\.anthropic\.com,api\.openai\.com,chatgpt\.com/);
  assert.match(compose, /DEVILUDO_CODEX_PROXY_URL: http:\/\/provider-proxy:3128/);
  assert.match(executorImage, /services\/core\/src\/codex-cli\.ts/);
  assert.match(claudeAgentImage, /install -y --no-install-recommends ca-certificates unzip/);
  assert.match(codexAgentImage, /install -y --no-install-recommends ca-certificates unzip/);
  const providerProxy = await readFile(new URL("../services/sandbox-executor/proxy-entrypoint.sh", import.meta.url), "utf8");
  assert.match(providerProxy, /cache_peer %s parent %s 0 no-query default/);
  assert.match(providerProxy, /never_direct allow all/);
  assert.match(localUp, /--reset-incompatible-baseline/);
  assert.match(localUp, /INCOMPATIBLE_BASELINE_RESET_REQUIRED/);
  assert.match(localUp, /"down", "--volumes", "--remove-orphans"/);
  assert.match(localUp, /npm run local:reset:self-hosted/);
  assert.doesNotMatch(compose, /deviludo-local-client(?:-secret)?/);
});

test("local shutdown and E2E recovery reap resources after interrupted work", async () => {
  const [down, e2eDaemon, tartPreparation, tartRecovery, runner, executor, codexCli, compose, systemdExecutor] = await Promise.all([
    readFile(new URL("../scripts/local-down.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-e2e-daemon.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-tart-prepare.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-tart-orphans.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/e2e-node/src/runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/codex-cli.ts", import.meta.url), "utf8"),
    readFile(new URL("../infra/docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/deviludo-executord.service", import.meta.url), "utf8"),
  ]);
  assert.match(down, /Promise\.allSettled\(\[/);
  assert.match(down, /"down", "--remove-orphans"/);
  assert.match(down, /label=deviludo\.managed=true/);
  assert.match(down, /cleanupLocalTartOrphans/);
  assert.match(e2eDaemon, /waitForProcessExit\(pid, 120_000\)/);
  assert.match(e2eDaemon, /signalProcessGroup\(pid, "SIGKILL"\)/);
  assert.match(tartPreparation, /signal = null[\s\S]*signal\?\.throwIfAborted/);
  assert.match(tartPreparation, /finally \{[\s\S]*\["stop", stagingName\]/);
  assert.match(tartRecovery, /jobVmName[\s\S]*stagingName[\s\S]*\["stop", name\][\s\S]*\["delete", name\]/);
  assert.match(e2eDaemon, /for \(const pid of pids\) signalProcessGroup\(pid, "SIGTERM"\)/);
  assert.match(e2eDaemon, /for \(const pid of survivors\) signalProcessGroup\(pid, "SIGKILL"\)/);
  assert.match(runner, /await isolation\.reap\(\);[\s\S]*finally \{[\s\S]*await isolation\.reap\(\)/);
  assert.ok(executor.indexOf("for (const execution of liveExecutions) execution.abort()") < executor.indexOf("await serverClosed"));
  assert.match(codexCli, /detached: killProcessGroup/);
  assert.match(codexCli, /process\.kill\(-Number\(child\.pid\), signal\)/);
  assert.match(codexCli, /Codex CLI timed out after \$\{timeoutMs\} ms/);
  assert.match(codexCli, /Codex run root cannot be inside the system temporary directory/);
  assert.match(codexCli, /model_catalog_json=\$\{modelCatalog\}/);
  assert.match(compose, /sandbox-executord:[\s\S]*stop_grace_period: 90s/);
  assert.match(systemdExecutor, /docker stop --time 90/);
});

test("production E2E service managers allow recovery to finish before force termination", async () => {
  const [linuxService, macosPlist, linuxDeploy, macosDeploy, windowsDeploy] = await Promise.all([
    readFile(new URL("../deploy/assets/deviludo-e2e.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/com.deviludo.e2e.plist", import.meta.url), "utf8"),
    readFile(new URL("../deploy/e2e-linux/deploy.sh", import.meta.url), "utf8"),
    readFile(new URL("../deploy/e2e-macos/deploy.sh", import.meta.url), "utf8"),
    readFile(new URL("../deploy/e2e-windows/deploy.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(linuxService, /TimeoutStopSec=15min/);
  assert.match(macosPlist, /<key>ExitTimeOut<\/key><integer>900<\/integer>/);
  assert.match(linuxDeploy, /role_stop\(\)[\s\S]*e2e-linux-isolation\.sh reap/);
  assert.match(macosDeploy, /role_stop\(\)[\s\S]*e2e-macos-isolation\.sh reap/);
  assert.match(windowsDeploy, /AppStopMethodConsole 900000[\s\S]*AppKillProcessTree 1/);
});

test("local deployment terminal output is English", async () => {
  const sources = await Promise.all([
    "local-up.mjs", "local-down.mjs", "local-bootstrap.mjs", "local-prepare.mjs",
    "local-e2e-daemon.mjs", "local-git-import-daemon.mjs", "local-macos-e2e.mjs",
    "local-tart-prepare.mjs", "local-status.mjs", "local-logs.mjs",
  ].map(file => readFile(new URL(`../scripts/${file}`, import.meta.url), "utf8")));
  for (const source of sources) assert.doesNotMatch(source, /[\u3400-\u9fff]/);
});

test("local quick start prepares the container runtime without a separate bootstrap command", async () => {
  const [english, chinese] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8"),
  ]);
  for (const readme of [english, chinese]) {
    const quickStart = readme.slice(readme.indexOf("git clone"), readme.indexOf("```", readme.indexOf("git clone")));
    assert.match(quickStart, /npm ci[\s\S]*npm run local:up/);
    assert.doesNotMatch(quickStart, /local:bootstrap/);
  }
});

test("production Core derives one anonymous installation ID from the host machine", async () => {
  const [compose, deploy, e2e] = await Promise.all([
    readFile(new URL("../deploy/assets/core.compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("../deploy/core/deploy.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-e2e.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(compose, /DEVILUDO_INSTALLATION_ID: \$\{DEVILUDO_INSTALLATION_ID:\?machine installation ID is required\}/);
  assert.match(deploy, /< \/etc\/machine-id/);
  assert.match(deploy, /deviludo\.machine-installation\.v1\\0linux\\0/);
  assert.match(deploy, /DEVILUDO_INSTALLATION_ID=%s/);
  assert.match(e2e, /DEVILUDO_INSTALLATION_ID: "00000000-0000-5000-8000-000000000001"/);
  assert.match(e2e, /DEVILUDO_TELEMETRY_ENDPOINT: "http:\/\/127\.0\.0\.1:9\/v1\/active-installations"/);
});

test("Core sandbox concurrency is bounded and assigns independent worker ids", async () => {
  const [config, main] = await Promise.all([
    readFile(new URL("../services/core/src/config.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/main.ts", import.meta.url), "utf8"),
  ]);
  assert.match(config, /DEVILUDO_SANDBOX_CONCURRENCY[\s\S]*?1,[\s\S]*?2,/);
  assert.match(main, /Array\.from\(\{ length: config\.sandboxConcurrency \}/);
  assert.match(main, /`\$\{baseWorkerId\}-\$\{index \+ 1\}`/);
});

test("the isolated E2E launcher maps the actual Docker socket group into executord", async () => {
  const launcher = await readFile(new URL("../scripts/run-e2e.mjs", import.meta.url), "utf8");
  assert.match(launcher, /resolveDockerSocketGid\(\)/);
  assert.match(launcher, /DEVILUDO_DOCKER_GID: dockerSocketGid/);
  assert.match(launcher, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
  assert.match(launcher, /"e2e-macos-image", "migrate"[\s\S]*?run", "--rm", "migrate"/);
});

test("Agent generation continues from the persistent source revision instead of an object artifact", async () => {
  const runner = await readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8");
  const daemon = await readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8");
  assert.match(runner, /typeof plan\.job\.payload\.sourceRelativePath === "string"/);
  assert.match(daemon, /projectSources\.archive\(sourceRelativePath\)/);
  assert.match(daemon, /projectSources\.archive\(baselineSourceRelativePath\)/);
  assert.match(daemon, /"input:baseline-source\.tar\.gz"/);
  assert.match(runner, /read-only \/workspace\/baseline/);
  assert.match(runner, /restore accidentally deleted or structurally damaged existing declarations/);
  assert.match(daemon, /"read-source"/);
  assert.match(daemon, /projectSources\.publishFiles\(/);
  assert.match(runner, /Continue developing the existing Godot 4 project/);
  assert.match(runner, /Create a complete Godot 4 project/);
  assert.doesNotMatch(runner, /input\.kind === "SOURCE"/);
});

test("bound local projects read the live directory and write back only when its baseline is unchanged", async () => {
  const [daemon, repository, bridge] = await Promise.all([
    readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-git-import-server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(repository, /localDirectoryBindingId/);
  assert.match(daemon, /readLocalProjectSource\(localDirectoryBindingId\)/);
  assert.match(daemon, /syncLocalProjectSource\(localDirectoryBindingId, localDirectoryBaseDigest, sourceStream\)/);
  assert.match(daemon, /projectSources\.saveCheckpoint/);
  assert.match(bridge, /sourceDigest\(current\) !== expectedDigest/);
  assert.match(bridge, /LOCAL_PROJECT_CHANGED/);
  assert.match(bridge, /shouldIncludeProjectPath\(path\)/);
});

test("successful E2E queues a safe host-side Git commit without pushing", async () => {
  const [scheduler, repository, bridge, proxy, gitCommit] = await Promise.all([
    readFile(new URL("../services/core/src/scheduler.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-git-import-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-project-bridge-proxy.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-git-commit.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(scheduler, /claimLocalGitCommit\(180\)/);
  assert.match(scheduler, /\/internal\/directory\/git\/commit/);
  assert.match(repository, /deviludo\.complete_local_git_commit/);
  assert.match(bridge, /commitVerifiedGitDirectory/);
  assert.match(proxy, /\/internal\/directory\/git\/commit/);
  assert.match(gitCommit, /GIT_INDEX_NOT_CLEAN/);
  assert.match(gitCommit, /--pathspec-from-file=/);
  assert.match(gitCommit, /DeviLudo-Workflow:/);
  assert.doesNotMatch(gitCommit, /\bpush\b/);
});

test("Agent generation preserves partial work and retries transient Provider failures in place", async () => {
  const [runner, claudeImage, codexImage] = await Promise.all([
    readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile.agent-claude", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile.agent-codex", import.meta.url), "utf8"),
  ]);
  const daemon = await readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8");
  const checkpointRestore = await readFile(new URL("../services/sandbox-executor/src/checkpoint-restore.ts", import.meta.url), "utf8");
  assert.match(runner, /const maxProviderAttempts = 16/);
  assert.match(runner, /attempt <= maxProviderAttempts/);
  assert.match(runner, /failure\.code === "INCOMPLETE_OUTPUT"[\s\S]*\? 4[\s\S]*failure\.code === "GUIDANCE_PENDING" \? 3[\s\S]*failure\.code === "PROVIDER_ERROR" \? maxProviderAttempts : 2/);
  assert.match(runner, /readAgentGuidanceSnapshot/);
  assert.match(runner, /agentGuidanceArrivedDuringRun/);
  assert.doesNotMatch(runner, /TEST_MANIFEST_INVALID|testManifestValidationIssues|requirementCatalog/);
  assert.match(runner, /cross-platform E2E node owns test-plan generation/);
  assert.match(runner, /Object\.hasOwn\(value, "testManifest"\)/);
  assert.match(runner, /await readGeneratedAgentManifest\(\)/);
  assert.doesNotMatch(runner, /E2E_REPAIR_INCOMPLETE|interactionRepairProgressIssue|repairLocator/);
  assert.match(runner, /isRepairPass \? 8 \* 60_000 : undefined/);
  assert.doesNotMatch(claudeImage, /e2e-repair-contract/);
  assert.doesNotMatch(codexImage, /e2e-repair-contract/);
  assert.match(claudeImage, /COPY services\/sandbox-executor\/agent-guidance-contract\.mjs \/usr\/local\/lib\/deviludo\/agent-guidance-contract\.mjs/);
  assert.match(codexImage, /COPY services\/sandbox-executor\/agent-guidance-contract\.mjs \/usr\/local\/lib\/deviludo\/agent-guidance-contract\.mjs/);
  assert.match(runner, /idleTimeoutMs: 8 \* 60_000/);
  assert.match(runner, /classifyAgentFailure/);
  assert.match(runner, /codex_models_manager\|failed to refresh available models/);
  assert.match(runner, /cloudflare\|cf-ray\|sorry, you have been blocked/);
  assert.match(runner, /agentRetryDelaySeconds\(failure, attempt\)/);
  assert.match(runner, /maximum\[ _-\]\?turns\|max\[ _-\]\?turns/);
  assert.match(runner, /"--resume" : "--session-id"/);
  assert.match(runner, /Do not restart analysis or spawn background agents, background shell commands, or background tasks/);
  assert.match(runner, /"--tools", "Read,Write,Edit,Glob,Grep,Bash"/);
  assert.match(runner, /"--disallowedTools", "Agent,Task"/);
  assert.match(runner, /"--dangerously-bypass-approvals-and-sandbox"/);
  assert.match(runner, /model_provider=deviludo_chatgpt/);
  assert.match(runner, /model_providers\.deviludo_chatgpt\.supports_websockets=false/);
  assert.match(runner, /The task container is already the security boundary/);
  assert.match(runner, /environment\.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1"/);
  assert.doesNotMatch(runner, /interactionScript contains only events|launchProfile shape|PLAYER_INTERACTION requirement/);
  assert.match(runner, /Implement the real game behavior, deterministic hooks, and read-only UI Probe/);
  assert.match(runner, /E2E node will verify texture placement, visibility, aspect, and gameplay\/UI context/);
  assert.match(runner, /deviludo\.e2e-ui-probe/);
  assert.match(runner, /asynchronous UI lifecycle changes/);
  assert.match(runner, /Show and hide must both advance the sequence/);
  assert.match(runner, /Map every control and embedded Window\/Popup rectangle against the root game client viewport/);
  assert.match(runner, /never use a child window's own content size as the root scale/);
  assert.match(runner, /A node detached from the scene tree or without a live root viewport must never be published as visible or enabled/);
  assert.match(runner, /Never invent a fallback viewport size to make a detached node appear actionable/);
  assert.match(runner, /If real dialog content exceeds the root client, fix the production UI with a bounded window and scrollable content/);
  assert.match(runner, /waitForAgentGuidanceQuiescence\(guidanceAfter\)/);
  assert.match(runner, /Live player guidance arrived before completion was committed/);
  assert.match(runner, /Every control reported visible and enabled for an action must be connected to its production input handler/);
  assert.match(runner, /successful, rejected, and asynchronously completed actions must all converge on a final UI refresh/);
  assert.match(runner, /Math\.min\(80 \* 60_000/);
  assert.match(runner, /trimBufferedTail\(stdout, stdoutBytes, 2 \* 1024 \* 1024\)/);
  assert.match(runner, /checkpoint\.tar\.gz/);
  assert.match(runner, /Continue only the interrupted implementation; do not start a general project audit/);
  assert.match(runner, /CLI exited without a diagnostic/);
  assert.match(daemon, /projectSources\.saveCheckpoint/);
  assert.match(daemon, /archiveCheckpoint\(plan\.job\.workspaceId, plan\.job\.projectId, plan\.job\.workflowId\)/);
  assert.match(daemon, /本次已保存/);
  assert.match(daemon, /"AGENT_COMPLETE"/);
  assert.match(daemon, /saveAgentCheckpoint\(taskName, plan, "PARTIAL"/);
  assert.match(checkpointRestore, /LOCAL_PROJECT_CHANGED/);
  assert.match(checkpointRestore, /DISCARD_STALE/);
});

test("Core waits for the sandbox executor before claiming jobs", async () => {
  const sandbox = await readFile(new URL("../services/core/src/sandbox.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../services/sandbox-executor/client.mjs", import.meta.url), "utf8");
  const daemon = await readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8");
  assert.match(sandbox, /await backend\.probe\(signal\)[\s\S]*repository\.claimJob/);
  assert.match(sandbox, /sandbox_executor_unavailable/);
  assert.match(client, /\/v2\/live/);
  assert.match(daemon, /request\.url === "\/v2\/live"/);
});

test("non-Builder task images can start without the Godot-only helper module", async () => {
  const taskRunner = await readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(taskRunner, /^import .*godot-build\.mjs/m);
  assert.match(taskRunner, /async function runGodotBuild\(plan\)[\s\S]*await import\("\.\/godot-build\.mjs"\)/);
});

test("production deployment has exactly five role-local idempotent entrypoints", async () => {
  const scripts = [
    "web/deploy.sh",
    "core/deploy.sh",
    "e2e-linux/deploy.sh",
    "e2e-windows/deploy.ps1",
    "e2e-macos/deploy.sh",
  ] as const;
  for (const script of scripts) {
    const content = await readFile(new URL(`../deploy/${script}`, import.meta.url), "utf8");
    if (script.endsWith(".ps1")) {
      for (const action of ["preflight", "bootstrap", "deploy", "status", "rollback"]) {
        assert.match(content.toLowerCase(), new RegExp(action));
      }
    } else {
      assert.match(content, /source [\s\S]*\/common[\s\S]*\/lib\.sh/);
      assert.match(content, /dispatch "\$@"/);
    }
  }
  const common = await readFile(new URL("../deploy/common/lib.sh", import.meta.url), "utf8");
  assert.match(common, /preflight\) load_config; role_preflight/);
  assert.match(common, /bootstrap\) load_config; with_lock role_bootstrap/);
  assert.match(common, /deploy\) with_lock deploy_release/);
  assert.match(common, /status\) role_status/);
  assert.match(common, /rollback\) with_lock rollback_release/);
  const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  for (const bundle of ["WEB.tar.gz", "CORE.tar.gz", "E2E_LINUX.tar.gz", "E2E_WINDOWS.zip", "E2E_MACOS.tar.gz"]) {
    assert.match(release, new RegExp(bundle.replace(".", "\\.")));
  }
  assert.match(release, /cosign sign --yes/);
  assert.match(release, /cosign sign-blob --yes --bundle/);
});

test("production E2E service accounts can read only installed runtime inputs", async () => {
  const linux = await readFile(new URL("../deploy/e2e-linux/deploy.sh", import.meta.url), "utf8");
  assert.match(linux, /require_file "\$DEVILUDO_GOLDEN_VM_FILE\.pem"/);
  assert.match(linux, /install -m 0400 -o deviludo-e2e -g deviludo-e2e "\$DEVILUDO_GOLDEN_VM_FILE" "\$golden_vm"/);
  assert.match(linux, /chown deviludo-e2e:deviludo-e2e \/etc\/deviludo\/e2e\/node\.env/);
  assert.match(linux, /DEVILUDO_GOLDEN_VM_FILE=\$golden_vm/);

  const macos = await readFile(new URL("../deploy/e2e-macos/deploy.sh", import.meta.url), "utf8");
  assert.match(macos, /require_file "\$DEVILUDO_GOLDEN_VM_FILE\.sig"/);
  assert.match(macos, /install -m 0400 -o deviludo-e2e -g staff "\$DEVILUDO_GOLDEN_VM_FILE" "\$golden_vm"/);
  assert.match(macos, /DEVILUDO_GOLDEN_VM_FILE="\$golden_vm"/);

  const windows = await readFile(new URL("../deploy/e2e-windows/deploy.ps1", import.meta.url), "utf8");
  assert.match(windows, /function Set-RestrictedAcl/);
  assert.match(windows, /function Set-RestrictedAcl \{[\s\S]*SupportsShouldProcess=\$true[\s\S]*\$PSCmdlet\.ShouldProcess/);
  assert.match(windows, /function Get-ReleaseHeader \{[\s\S]*?OutputType\(\[System\.Collections\.Hashtable\]\)/);
  assert.match(windows, /function Get-ServiceEnvironment \{[\s\S]*?OutputType\(\[System\.Object\[\]\]\)/);
  assert.match(windows, /\*S-1-5-18:\(OI\)\(CI\)F/);
  assert.match(windows, /Copy-Item -LiteralPath \$c\.goldenVmFile -Destination \$goldenVmArchive -Force/);
  assert.match(windows, /Expand-Archive -LiteralPath \$goldenVmArchive/);
  assert.match(windows, /Get-ChildItem -LiteralPath \$goldenImage -Recurse -File -Filter '\*\.vmcx'/);
  assert.match(windows, /Set-ServiceConfiguration -Config \$c -NodeId \$nodeId -GoldenVmArchive \$goldenVmArchive -GoldenVmConfiguration \$goldenVmConfiguration/);
  assert.match(windows, /Get-ServiceEnvironment -Config \$Config -NodeId \$NodeId -GoldenVmArchive \$GoldenVmArchive -GoldenVmConfiguration \$GoldenVmConfiguration/);
  assert.match(windows, /\$ServiceAccount="NT SERVICE\\\$Service"/);
  assert.match(windows, /Get-LocalGroup -SID 'S-1-5-32-578'/);
  assert.match(windows, /sc\.exe config \$Service "obj= \$ServiceAccount"/);
  assert.match(windows, /Grant-ServiceAcl \(Join-Path \$State 'credentials'\) '\(OI\)\(CI\)M'/);
  assert.match(windows, /Grant-ServiceAcl \(Join-Path \$State 'jobs'\) '\(OI\)\(CI\)M'/);
  assert.match(windows, /Grant-ServiceAcl \(Join-Path \$State 'golden'\) '\(OI\)\(CI\)RX'/);
  assert.match(windows, /New-ScheduledTaskPrincipal -UserId \$ServiceAccount -LogonType ServiceAccount -RunLevel Limited/);
  assert.match(windows, /Initialize-GuestCredential/);
  assert.match(windows, /guest-credential\.bootstrap\.json/);
  assert.match(windows, /Remove-Item -LiteralPath \$bootstrap -Force/);
  assert.doesNotMatch(windows, /Register-ScheduledTask[^\n]+-User 'SYSTEM'/);
});

test("remote E2E enrollment is node-bound and public networks keep production mTLS", async () => {
  const [client, api, repository, enroll, localWindows, windowsIsolation, release] = await Promise.all([
    readFile(new URL("../services/e2e-node/src/core-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/remote-e2e-enroll.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-remote-windows-e2e.ps1", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/e2e-windows-isolation.ps1", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);
  assert.match(client, /"x-deviludo-node-id": this\.config\.nodeId/);
  assert.match(api, /\/v1\/e2e\/enroll-development/);
  assert.match(api, /process\.env\.NODE_ENV === "production"/);
  assert.match(api, /nodeAuthTokenHash/);
  assert.match(api, /authenticateDevelopmentE2eNode/);
  assert.match(api, /heartbeatServerNode/);
  assert.match(api, /\/v1\/e2e\/nodes\/:nodeId\/preparation/);
  assert.match(api, /INVALID_E2E_PREPARATION_PROGRESS/);
  assert.match(repository, /updateE2eNodePreparation/);
  assert.match(repository, /node\.development_auth_token_hash = \$2/);
  assert.doesNotMatch(repository, /authenticateDevelopmentE2eNode[\s\S]{0,500}e2e_enrollment_tokens/);
  assert.match(enroll, /Plain HTTP enrollment is restricted to a private LAN\/VPN IPv4 address/);
  assert.match(enroll, /enrollment-token-file/);
  assert.match(enroll, /node-auth-token/);
  assert.match(enroll, /nodeAuthTokenHash/);
  assert.match(enroll, /every\(isAbsolute\)/);
  assert.match(localWindows, /ValidateSet\('enroll','run','status'\)/);
  assert.match(localWindows, /DEVILUDO_E2E_ALLOW_UNSIGNED_LOCAL_RUNTIME='1'/);
  assert.match(windowsIsolation, /DEVILUDO_GOLDEN_VM_ARCHIVE/);
  assert.match(windowsIsolation, /Import-VM[\s\S]*-VhdDestinationPath[\s\S]*-SnapshotFilePath/);
  assert.match(release, /e2e-windows-initialize-credential\.ps1/);
});

test("architecture verification uses only the Node.js filesystem API", async () => {
  const verifier = await readFile(new URL("../scripts/verify-architecture.mjs", import.meta.url), "utf8");
  assert.match(verifier, /readdir\(directory, \{ withFileTypes: true \}\)/);
  assert.doesNotMatch(verifier, /node:child_process|execFile|["']rg["']/);
});

test("Core keeps Docker authority in executord and isolates Agent and Steam egress", async () => {
  const compose = await readFile(new URL("../deploy/assets/core.compose.yaml", import.meta.url), "utf8");
  const sandbox = compose.match(/\n  sandbox:([\s\S]*?)\n  provider-proxy:/)?.[1] ?? "";
  assert.match(sandbox, /DEVILUDO_SANDBOX_EXECUTOR: \/usr\/local\/bin\/sandbox-executor-client/);
  assert.doesNotMatch(sandbox, /docker\.sock/);
  assert.match(compose, /provider-proxy:[\s\S]*networks: \[executor-agent, egress\]/);
  assert.match(compose, /steam-proxy:[\s\S]*networks: \[executor-steam, egress\]/);
  assert.match(compose, /executor-agent:[\s\S]*internal: true/);
  assert.match(compose, /executor-steam:[\s\S]*internal: true/);
  assert.doesNotMatch(compose, /github-proxy|executor-github/);
  const service = await readFile(new URL("../deploy/assets/deviludo-executord.service", import.meta.url), "utf8");
  assert.match(service, /src=\/var\/run\/docker\.sock,dst=\/var\/run\/docker\.sock/);
  const proxy = await readFile(new URL("../Dockerfile.provider-proxy", import.meta.url), "utf8");
  assert.match(proxy, /USER proxy/);
  assert.match(compose, /\/run:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=13,gid=13/);
  const taskRunner = await readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8");
  assert.match(taskRunner, /readFile\("\/workspace\/inputs\/specification\.json"/);
  assert.doesNotMatch(taskRunner, /Specification: \$\{JSON\.stringify\(plan\.job\.payload\)\}/);
  assert.match(taskRunner, /"-p", "--disable-slash-commands"/);
  assert.match(taskRunner, /"--output-format", "stream-json", "--include-partial-messages"/);
  assert.match(taskRunner, /"--max-turns", "100"/);
  assert.match(taskRunner, /"--disallowedTools", "Agent,Task"/);
  assert.match(taskRunner, /projectTreeDigest\("\/workspace\/project"\)/);
  assert.match(taskRunner, /Agent returned before making required source changes/);
  assert.match(taskRunner, /"INCOMPLETE_OUTPUT"/);
  assert.match(taskRunner, /failure\.code === "INCOMPLETE_OUTPUT"[\s\S]*\? 4/);
  assert.match(taskRunner, /const maxProviderAttempts = 16/);
  assert.match(taskRunner, /for \(let attempt = 1; attempt <= maxProviderAttempts; attempt \+= 1\)/);
  assert.match(taskRunner, /All[\s\S]*calls still share the single 80-minute deadline/);
  assert.match(taskRunner, /previous response stopped before changing any source files/);
  assert.doesNotMatch(taskRunner, /Core has already validated the existing agent\.json|existingManifestValid|testManifestValidationIssues/);
  assert.match(taskRunner, /cross-platform E2E node owns test-plan generation/);
  assert.match(taskRunner, /agent\.json must contain exactly the current assetManifest/);
  assert.match(taskRunner, /BLOCKING E2E REPAIR:[\s\S]*E2E failure summary:[\s\S]*e2eRepairPromptSummary\(e2eRepairContext\)/);
  assert.match(taskRunner, /When present, report\.json interactionContracts contains the complete frozen native-input contract[\s\S]*when its interactionContract is present, perform one bounded consistency pass over that same failed feature[\s\S]*remaining targetId and changeTargetId[\s\S]*remaining postcondition\/checkpoint key/);
  assert.match(taskRunner, /plan\.job\.payload\.repairFailureKind === "ARTIFACT_BUILD"/);
  assert.match(taskRunner, /repairFailureSummary\.length <= 1_800/);
  assert.match(taskRunner, /BLOCKING BUILD REPAIR:[\s\S]*Builder failure summary: \$\{JSON\.stringify\(upstreamFailureSummary\)\}/);
  assert.match(taskRunner, /const isRepairPass = e2eRepairContext !== null \|\| upstreamFailureSummary !== null/);
  assert.doesNotMatch(taskRunner, /E2E failure report:[\s\S]*e2eRepairContext\.report/);
  assert.match(taskRunner, /failures\.filter\(value => typeof value === "string"\)\.slice\(0, 50\)/);
  assert.match(taskRunner, /`Specification: \$\{JSON\.stringify\(specification\)\}`/);
  assert.match(taskRunner, /`Current revision notes: \$\{JSON\.stringify\(specification\.revisionNotes/);
  assert.doesNotMatch(taskRunner, /requiredCoreStartAssertions|requiredCoreReadyAssertions/);
  assert.match(taskRunner, /make the first concrete source edit before inspecting broad regression coverage/);
  assert.match(taskRunner, /Open only the exact source\/test file named by the evidence first/);
  assert.match(taskRunner, /\n      5 \* 60_000,\n[\s\S]*isRepairPass \? 8 \* 60_000 : undefined/);
  assert.doesNotMatch(taskRunner, /e2eRepairContext \? 60_000 : undefined/);
  assert.match(taskRunner, /initialProgressDeadlineMs: verifyCompletion \? initialProgressDeadlineMs/);
  assert.match(taskRunner, /completionQuiescenceMs: verifyCompletion \? completionQuiescenceMs/);
  assert.match(taskRunner, /setTimeout\(acceptCompletedProgress, options\.completionQuiescenceMs\)/);
  assert.match(taskRunner, /if \(acceptedAfterProgress\)/);
  assert.match(taskRunner, /detached: options\.killProcessGroup === true/);
  assert.match(taskRunner, /process\.kill\(-child\.pid, signal\)/);
  assert.match(taskRunner, /The latest live guidance is the highest-priority scope constraint/);
  assert.match(taskRunner, /The next controlled builder stage performs real Godot validation/);
  assert.match(taskRunner, /prepareGodotProject\("\/workspace\/project", plan\.job\.payload\.targetPlatforms\)/);
  assert.match(taskRunner, /read \/run\/deviludo\/guidance\.ndjson/);
  assert.match(taskRunner, /event\.event\?\.delta\?\.text/);
  assert.match(taskRunner, /kind === "AGENT_OUTPUT" \? sanitized : sanitized\.trim\(\)/);
  assert.doesNotMatch(taskRunner, /String\(content\).*\.trim\(\)\.slice\(0, 4000\)/);
  assert.doesNotMatch(taskRunner, /if \(!normalized\.trim\(\)\)/);
  assert.match(taskRunner, /if \(content\.length > 0\) emitProgress\("AGENT_OUTPUT", content\)/);
  const repository = await readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8");
  assert.match(repository, /kind === "AGENT_OUTPUT" \? sanitized : sanitized\.trim\(\)/);
  const executor = await readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8");
  assert.match(executor, /progressLineBuffer/);
  assert.match(executor, /Builder 已开始验证并构建项目/);
  assert.match(executor, /ProjectSourceStore/);
  assert.doesNotMatch(executor, /resolveGitHubCredential|GITHUB_ONLY|GIT_ASKPASS|REMOTE_DIVERGED/);
  assert.doesNotMatch(taskRunner, /GIT_ASKPASS|REMOTE_DIVERGED|https:\/\/x-access-token:/);
  assert.match(taskRunner, /function stripTerminalControlSequences/);
  assert.match(taskRunner, /const errorLineIndexes = diagnosticLines/);
  const e2eToolPath = await readFile(new URL("../services/e2e-node/src/tool-path.ts", import.meta.url), "utf8");
  assert.match(e2eToolPath, /executable\.endsWith\("\.mjs"\)/);
  assert.match(e2eToolPath, /executable: nodeExecutable/);
  const e2eIsolation = await readFile(new URL("../services/e2e-node/src/isolation.ts", import.meta.url), "utf8");
  assert.match(e2eIsolation, /DEVILUDO_E2E_IDENTITY_KEY_FILE: process\.env\.DEVILUDO_E2E_IDENTITY_KEY_FILE/);
  const builder = await readFile(new URL("../services/sandbox-executor/godot-build.mjs", import.meta.url), "utf8");
  assert.match(builder, /writeFile\([\s\S]*export_presets\.cfg[\s\S]*controlledExportPresets/);
  assert.match(builder, /codesign\/codesign=1/);
  assert.match(builder, /codesign\/enable=false/);
  const builderImage = await readFile(new URL("../Dockerfile.godot-builder", import.meta.url), "utf8");
  assert.match(builderImage, /COPY services\/sandbox-executor\/godot-build\.mjs \/usr\/local\/bin\/godot-build\.mjs/);
  const coreSandbox = await readFile(new URL("../services/core/src/sandbox.ts", import.meta.url), "utf8");
  assert.match(coreSandbox, /parseExecutorStderrLine/);
  assert.match(coreSandbox, /discardOrphanedAgentSource\(repository, projectSources, job\)/);
  assert.match(coreSandbox, /projectSourceRevisionExists[\s\S]*discardUnregisteredRevision/);
  assert.doesNotMatch(coreSandbox, /Sandbox executor failed: \$\{Buffer\.concat\(stderr\)/);
});

test("production Agent execution requires a pinned Kata microVM runtime", async () => {
  const executor = await readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8");
  const deployment = await readFile(new URL("../deploy/core/deploy.sh", import.meta.url), "utf8");
  const manifest = await readFile(new URL("../scripts/release-manifest.mjs", import.meta.url), "utf8");
  assert.match(executor, /const agentJob = job\.jobKind === "AGENT_GENERATION" \|\| job\.jobKind === "PROJECT_DOCUMENT_MAINTENANCE"[\s\S]*agentJob && !developmentContainersAllowed[\s\S]*\? "MICROVM"/);
  assert.match(executor, /typeof item\.targetPlatform === "string"[\s\S]*\? \{ targetPlatform:[\s\S]*: \{\}/);
  assert.match(executor, /--runtime=\$\{microvmRuntime\}/);
  assert.match(deployment, /DEVILUDO_EXECUTOR_MICROVM_RUNTIME=io\.containerd\.kata\.v2/);
  assert.match(deployment, /verify_sha256 "\$expected" "\$archive"/);
  assert.match(manifest, /externalArtifacts: \{ kata \}/);
  assert.match(manifest, /artifactHostCommandsAllowed: false/);
  assert.match(manifest, /guestReportContract: "deviludo\.godot-guest-report"/);
  assert.doesNotMatch(manifest, /GODOT:\s*\{\s*version:/);
  assert.match(manifest, /runtimeInputSmoke: "GODOT_SYSTEM_KEYBOARD_POINTER_GAMEPAD"/);
  assert.match(manifest, /gamepadBackends: \{ macos: "CORE_HID", linux: "UINPUT", windows: "KMDF_VHF" \}/);
  assert.match(manifest, /macosGoldenImage: "TAHOE_26"/);
});

test("CI gates code changes on the isolated API and cross-browser E2E suite", async () => {
  const [workflow, packageSource, launcher, e2eCompose, coreApi, e2eFixture] = await Promise.all([
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-e2e.mjs", import.meta.url), "utf8"),
    readFile(new URL("../infra/docker-compose.e2e.yml", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/executors/e2e-fixture-job.mjs", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.["test:e2e:code"], "node scripts/run-e2e.mjs");
  assert.match(workflow, /code-e2e:[\s\S]*name: Code E2E \(API and browsers\)/);
  assert.match(workflow, /playwright install --with-deps chromium firefox webkit/);
  assert.match(workflow, /npm run test:e2e:code/);
  assert.match(workflow, /if: failure\(\)[\s\S]*playwright-report\/[\s\S]*test-results\//);
  assert.match(launcher, /DEVILUDO_MINIO_HOST_PORT: String\(minioPort\)/);
  assert.match(launcher, /DEVILUDO_S3_PUBLIC_ENDPOINT: `http:\/\/127\.0\.0\.1:\$\{minioPort\}`/);
  assert.match(e2eCompose, /DEVILUDO_E2E_PLAYER_POLICY_FIXTURE: "1"/);
  assert.match(coreApi, /process\.env\.NODE_ENV === "test"[\s\S]*DEVILUDO_E2E_PLAYER_POLICY_FIXTURE === "1"/);
  assert.match(coreApi, /if \(e2ePlayerPolicyFixture\)[\s\S]*markTestPolicyReady/);
  assert.match(e2eFixture, /const protocolInput = createInterface[\s\S]*await lines\.next\(\);[\s\S]*protocolInput\.close\(\);/);
});

test("CI uses the fixed no-provider Agent while local macOS requires Tart E2E", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const [localUp, localMac] = await Promise.all([
    readFile(new URL("../scripts/local-up.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-macos-e2e.mjs", import.meta.url), "utf8"),
  ]);
  const smoke = await readFile(new URL("../scripts/local-executor-smoke.mjs", import.meta.url), "utf8");
  const tartProvision = await readFile(new URL("../scripts/local-tart-provision.sh", import.meta.url), "utf8");
  assert.match(workflow, /DEVILUDO_LOCAL_CI: "1"/);
  assert.match(workflow, /DEVILUDO_SKIP_NATIVE_E2E: "1"/);
  assert.match(workflow, /stop core-sandbox core-scheduler/);
  assert.match(workflow, /npm run local:logs -- --no-follow/);
  assert.doesNotMatch(localUp, /preflightLocalTartE2e|prepareLocalTartE2e/);
  assert.match(localMac, /prepareLocalTartE2e\(\{/);
  assert.match(localUp, /error\?\.code !== "ENOENT"/);
  assert.match(localUp, /hash\.update\("missing", "utf8"\)/);
  assert.doesNotMatch(localUp, /requireGodot|local-macos-job/);
  assert.match(smoke, /const specificationKey = `\$\{objectPrefix\(agentJobId\)\}\/specification\.json`/);
  assert.match(smoke, /inputObjects: \[specificationObject\]/);
  const tartPrepare = await readFile(new URL("../scripts/local-tart-prepare.mjs", import.meta.url), "utf8");
  assert.match(tartPrepare, /if \(preflight\) await preflightLocalTartE2e\(\)/);
  assert.match(tartPrepare, /assertHomebrewCommandLineTools\(\)/);
  assert.match(tartPrepare, /Command Line Tools are too outdated/);
  assert.match(tartPrepare, /developer\.apple\.com\/download\/all/);
  assert.match(tartPrepare, /\["trust", "--formula", \.\.\.trustedFormulae\]/);
  assert.match(tartPrepare, /trustedFormulae\.add\("cirruslabs\/cli\/softnet"\)/);
  assert.match(tartPrepare, /`cirruslabs\/cli\/\$\{formula\}`/);
  assert.match(tartPrepare, /\["clone", baseImage, baseCacheName\]/);
  assert.match(tartPrepare, /const updateFromGolden = !refresh/);
  assert.match(tartPrepare, /const updateSource = updateFromGolden \? goldenName : baseCacheName/);
  assert.match(tartPrepare, /\["clone", updateSource, stagingName\]/);
  assert.match(tartPrepare, /if \(updateFromGolden\) \{[\s\S]*?waitForGuestSsh\(ip\)/);
  assert.match(tartPrepare, /installGuestRuntime\(ip, \{ rotateCredentials: !updateFromGolden \}\)/);
  assert.match(tartProvision, /DEVILUDO_ROTATE_GUEST_CREDENTIALS/);
  assert.match(tartPrepare, /if \(refresh \|\| !cacheExists\) await requireDiskSpace\(\)/);
  assert.doesNotMatch(tartPrepare.match(/export async function prepareLocalTartE2e[\s\S]*?(?=async function ensureHomebrewTools)/)?.[0] ?? "", /requireDiskSpace\(\)/);
  assert.match(tartPrepare, /canonicalPrefix/);
  assert.match(tartPrepare, /\^sha256:\[0-9a-f\]\{64\}/);
  assert.doesNotMatch(tartPrepare, /JSON\.stringify\(row, Object\.keys\(row\)\.sort\(\)\)/);
  assert.doesNotMatch(tartPrepare, /legacyFingerprint/);
  assert.match(tartPrepare, /macos-tahoe-base/);
  assert.match(tartPrepare, /rows\.some\(item => \[item\?\.Name, item\?\.name\]\.includes\(name\)\)/);
  assert.match(tartPrepare, /split\(\/\\s\+\/\)\.includes\(name\)/);
  assert.match(tartPrepare, /\["set", stagingName, "--memory", "6144", "--display", "1440x900"\]/);
  assert.match(tartPrepare, /ensureAliasedKnownHosts\(\)/);
  assert.match(tartPrepare, /HostKeyAlias=\$\{guestHostKeyAlias\}/);
  assert.match(tartPrepare, /ssh-keyscan", \["-T", "5", "-H", ip\]/);
  assert.match(tartPrepare, /attempt < 20 && !knownHosts/);
  assert.match(tartPrepare, /!line\.startsWith\("#"\)[\s\S]*line\.split\(\/\\s\+\/\)\.length >= 3/);
  assert.match(tartPrepare, /PreferredAuthentications=password/);
  assert.match(tartPrepare, /attempt < 20 && !authorized/);
  assert.match(tartPrepare, /key_press/);
  assert.match(tartPrepare, /key_release/);
  assert.match(tartPrepare, /"-target", "arm64-apple-macosx15\.0"/);
  assert.match(tartPrepare, /"-Onone", "-parse-as-library", "-target", "arm64-apple-macosx15\.0"/);
  assert.match(tartPrepare, /godot-system-gamepad-smoke/);
  assert.match(tartPrepare, /gamepad-smoke-ok/);
  assert.match(tartPrepare, /"-Onone"/);
  assert.match(tartPrepare, /\[hostGuiDriverFile, "\/Users\/Shared\/deviludo-gui-driver"\]/);
  const gamepadDriver = await readFile(new URL("../scripts/executors/macos-gamepad-driver.swift", import.meta.url), "utf8");
  assert.match(gamepadDriver, /import CoreHID/);
  assert.match(gamepadDriver, /HIDVirtualDevice\(properties:/);
  assert.doesNotMatch(gamepadDriver, /IOHIDUserDeviceCreate|IOHIDUserDeviceHandleReport/);
  assert.doesNotMatch(tartProvision, /amfi_get_out_of_my_way|codesign/);
  assert.match(tartPrepare, /gamepad-smoke-unavailable/);
  assert.match(tartPrepare, /gamepadAvailable/);
  const tartGuest = await readFile(new URL("../scripts/executors/local-tart-guest-runner.mjs", import.meta.url), "utf8");
  assert.match(tartGuest, /configuration\.gamepadAvailable === true/);
  assert.match(tartProvision, /sudo -u admin -H \/opt\/homebrew\/bin\/brew install ffmpeg/);
  assert.match(tartProvision, /HOMEBREW_NO_AUTO_UPDATE=1/);
  assert.match(tartPrepare, /"admin\\n", 45 \* 60_000/);
  assert.doesNotMatch(tartProvision, /^\s*\/opt\/homebrew\/bin\/brew install ffmpeg/m);
  assert.match(tartPrepare, /gui-event-batches\.mjs"\), "\/Users\/Shared\/gui-event-batches\.mjs"/);
  assert.match(tartPrepare, /e2e-regression-actions\.mjs"\), "\/Users\/Shared\/e2e-regression-actions\.mjs"/);
  assert.match(tartPrepare, /e2e-performance\.mjs"\), "\/Users\/Shared\/e2e-performance\.mjs"/);
  assert.match(tartPrepare, /export async function fingerprintLocalTartE2eRuntimeInputs\(\)/);
  assert.match(tartPrepare, /randomBytes\(12\)\.toString\("hex"\)/);
  assert.doesNotMatch(tartPrepare, /\/Users\/Shared\/macos-gui-driver\.swift/);
  assert.match(tartPrepare, /const rebootedVm = spawn\("tart"/);
  assert.match(tartPrepare, /await waitForGuestSsh\(rebootedIp\)/);
  assert.match(tartPrepare, /await waitForGuestDesktop\(rebootedIp\)/);
  assert.match(tartPrepare, /launchctl print gui\/501/);
  assert.match(tartPrepare, /attempt < 30/);
  assert.match(tartPrepare, /await smokeGuestRuntime\(rebootedIp\)/);
  assert.match(tartPrepare, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)/);
  assert.match(tartPrepare, /loginwindow can report the desktop session before ScreenCaptureKit/);
  assert.match(tartPrepare, /String\(error\?\.stderr \?\? ""\)\.trim\(\)/);
  assert.match(tartPrepare, /Tart real-window smoke testing failed after reboot/);
  assert.match(tartProvision, /\/usr\/sbin\/sysadminctl[\s\\]*-resetPasswordFor admin/);
  assert.match(tartProvision, /dscl \. -authonly admin/);
  assert.match(tartProvision, /writeFileSync\("\/Users\/Shared\/deviludo-kcpassword"/);
  assert.match(tartProvision, /install -o root -g wheel -m 0600 \/Users\/Shared\/deviludo-kcpassword \/etc\/kcpassword/);
  assert.match(tartProvision, /com\.apple\.loginwindow autoLoginUser admin/);
  assert.match(tartProvision, /kcpassword_size=.*stat -f/);
  assert.match(tartProvision, /sudo sync/);
  assert.match(tartProvision, /gui-event-batches\.mjs \"\$guest_root\/executors\/gui-event-batches\.mjs\"/);
  assert.match(tartProvision, /e2e-regression-actions\.mjs \"\$guest_root\/e2e-regression-actions\.mjs\"/);
  assert.match(tartProvision, /e2e-performance\.mjs/);
  assert.doesNotMatch(tartProvision, /sysadminctl[\s\\]*-autologin set/);
  assert.match(smoke, /deviludo-agent-fixture:local/);
  assert.match(smoke, /skipRealWindowE2e \? null : await runTartMacE2e/);
  assert.doesNotMatch(smoke, /DEVELOPMENT_NATIVE/);
  const fixtureMain = await readFile(new URL("../fixtures/godot-smoke/scripts/main.gd", import.meta.url), "utf8");
  assert.match(fixtureMain, /func _unhandled_key_input\(event: InputEvent\)/);
  assert.match(fixtureMain, /Input\.is_key_pressed\(KEY_D\)/);
  assert.match(fixtureMain, /func _on_game_input\(event: InputEvent\)/);
  assert.match(fixtureMain, /get_tree\(\)\.quit\(\)/);
});

test("Godot E2E plans at the platform node and runs a real window with portable visual evidence", async () => {
  const [guest, evidence, builder, macDriver, linuxDriver, windowsDriver, linuxIsolation, planner, nodeExecutor, hostExecutor, performance] = await Promise.all([
    readFile(new URL("../scripts/executors/godot-window-e2e-guest.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/e2e-evidence.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/executors/macos-gui-driver.swift", import.meta.url), "utf8"),
    readFile(new URL("../scripts/executors/linux-x11-gui-driver.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/executors/windows-gui-driver.ps1", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/e2e-linux-isolation.sh", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/e2e-test-plan.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/e2e-node/src/executor.ts", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/e2e-job-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/e2e-performance.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(nodeExecutor, /verifyPlayerPolicy\(job\)[\s\S]*generateTestPlan\(job\)/);
  assert.match(nodeExecutor, /testPlan: generatedPlan/);
  assert.match(hostExecutor, /test-plan\.json/);
  assert.match(hostExecutor, /"--test-plan"/);
  assert.match(planner, /regressionOperations/);
  assert.match(planner, /regressionUi/);
  assert.match(planner, /changeImpact/);
  assert.match(planner, /assetApplication/);
  assert.match(planner, /loaded, visible in the correct game\/UI context, correctly cropped\/aspected/);
  assert.match(guest, /deviludo\.test-manifest/);
  assert.match(guest, /deviludo\.e2e-ui-probe|waitForProbeSnapshot/);
  assert.match(guest, /interactionContracts:[\s\S]*verificationMethod === "interactive"[\s\S]*interactionScript: feature\.interactionScript/);
  assert.match(guest, /gameWindowArguments\(gameLogPath\)/);
  assert.match(guest, /measurePerformance \? \["--debug", "--print-fps"\]/);
  assert.match(guest, /--print-fps/);
  assert.match(performance, /GAME_STUTTER_DETECTED/);
  assert.match(guest, /summarizeE2ePerformance/);
  assert.match(guest, /conclusivePerformanceFailure[\s\S]*GAME_STUTTER_DETECTED/);
  assert.match(guest, /catch \(error\)[\s\S]*measuredStutter[\s\S]*primaryFailure = productFailure/);
  assert.match(guest, /isGameWindowReadinessTimeout[\s\S]*PACKAGE_WINDOW_TIMEOUT/);
  assert.match(guest, /PACKAGE_WINDOW_TIMEOUT[\s\S]*startupRuntimeDiagnostic/);
  assert.match(evidence, /Runtime Smoothness/);
  assert.match(builder, /PERFORMANCE REPAIR/);
  assert.match(builder, /Do not change E2E thresholds/);
  assert.match(builder, /PACKAGE_WINDOW_TIMEOUT[\s\S]*product startup failure/);
  assert.match(builder, /renderer and device names reported by a virtualized runner as environment context/);
  assert.match(builder, /preserve application launch, window creation, and compatible fallbacks/);
  assert.ok(builder.indexOf("const SOURCE_IMAGE_EXTENSIONS") < builder.indexOf("await mkdir(\"/workspace/inputs\""));
  assert.match(guest, /type: "mouse_click",[\s\S]*x: point\.x,[\s\S]*y: point\.y/);
  assert.match(guest, /"--log-file", logPath/);
  assert.match(guest, /DEVILUDO_E2E_CHECKPOINT_FILE: checkpointOutputPath/);
  assert.match(guest, /isolatedGameEnvironment\(`unit-\$\{unitIndex\}`\)/);
  const unitRunner = guest.match(/async function runUnitTests[\s\S]*?(?=async function runJourney)/)?.[0] ?? "";
  assert.match(unitRunner, /godotUnitRuntime\(\)/);
  assert.match(unitRunner, /"--headless", "--main-pack", gamePackage\.projectPack, "--script", script/);
  assert.doesNotMatch(unitRunner, /gamePackage\.executable/);
  assert.match(guest, /projectPacks\.length !== 1/);
  assert.match(guest, /isolatedGameEnvironment\(runId/);
  assert.match(guest, /XDG_DATA_HOME: xdgData/);
  assert.match(guest, /APPDATA: appData/);
  assert.match(guest, /checkpointOutputSeen\(\[await readOptionalLog\(gameLogPath\), await readOptionalLog\(checkpointOutputPath\)\]/);
  assert.match(guest, /waitForCheckpointOutput\([\s\S]*CHECKPOINT_VISUAL_SETTLE_MS/);
  assert.match(guest, /MIN_STATE_TRANSITION_DIFFERENCE_RATIO\s*=\s*0\.001/);
  assert.match(guest, /MIN_FULL_FRAME_TRANSITION_PIXELS\s*=\s*32/);
  assert.match(guest, /FULL_FRAME_FALLBACK/);
  assert.match(guest, /CHECKPOINT_VISUAL_STATE_UNCHANGED/);
  assert.match(guest, /--windowed/);
  assert.doesNotMatch(guest.match(/async function runJourney[\s\S]*?(?=async function runVisualCheck)/)?.[0] ?? "", /--headless/);
  assert.match(guest, /JOURNEYS_MISSING/);
  assert.match(guest, /PLAYER_REQUIREMENT_COVERAGE_MISSING/);
  assert.match(guest, /nativeInputEvents\(event, before\)/);
  assert.match(guest, /testEnvironment\.sequence\(nativeEvents/);
  assert.match(guest, /ACTION_STATE_UNCHANGED/);
  assert.match(guest, /MACOS_LAUNCH_SERVICES/);
  assert.match(guest, /"-n", "-o", stdoutPath, "--stderr", stderrPath/);
  assert.match(guest, /Godot's[\s\S]*--print-fps output is stdout-only/);
  assert.match(guest, /process\.kill\(pid, "SIGINT"\)/);
  assert.match(guest, /recordFrameRateRun\(runId, await readOptionalLog\(gameLogPath\), logs\.stdout\)/);
  assert.match(guest, /launchArguments\.push\("--env"/);
  assert.match(guest, /execute\("\/usr\/bin\/open", launchArguments/);
  assert.doesNotMatch(guest, /"launchctl", \["setenv"/);
  assert.match(guest, /WINDOWS_FINAL_EXE/);
  assert.match(guest, /LINUX_RELEASE_EXECUTABLE/);
  assert.match(guest, /plannedTimeoutMs/);
  assert.match(guest, /ADAPTIVE_ROLLOUT_COUNT\s*=\s*3/);
  assert.match(guest, /ADAPTIVE_REQUIRED_SUCCESSES\s*=\s*2/);
  assert.match(guest, /PLAYER_STUCK/);
  assert.match(guest, /solidifyRegression/);
  assert.match(guest, /compactRegressionActions/);
  assert.match(guest, /plannedCoreRegressionCandidates/);
  assert.match(guest, /resolveProbeControlAtPoint/);
  assert.match(guest, /所有成功候选轨迹均未能连续完成两次干净语义回放/);
  assert.doesNotMatch(guest, /find\(rollout => rollout\.decisions\.flatMap\(decision => decision\.semanticActions\)/);
  assert.doesNotMatch(guest, /STEAM_CLIENT_INSTALL|steam-clean-install/);
  assert.match(guest, /journey\.timeoutMs/);
  assert.match(guest, /UNIT_TIMEOUT/);
  assert.match(guest, /const termination = result\.signal[\s\S]*退出码 \$\{result\.code\}/);
  assert.match(guest, /UNIT_RESULT_MISSING[\s\S]*未输出 DEVILUDO_E2E_RESULT（\$\{termination\}）/);
  assert.match(guest, /child\.once\("close", \(code, signal\)/);
  assert.match(guest, /timedOut = true/);
  assert.match(guest, /inspectScreenshot/);
  assert.match(guest, /godotErrorLines/);
  assert.match(builder, /DEVILUDO_E2E_CHECKPOINT_FILE/);
  assert.match(builder, /cross-platform E2E node owns test-plan generation/);
  assert.doesNotMatch(builder, /existingManifestValid|testManifestValidationIssues/);
  assert.match(builder, /agentRetryDelaySeconds\(failure, attempt\)/);
  assert.match(builder, /memory overloaded[\s\S]*Math\.min\(120, 30 \* Math\.max\(1, attempt\)\)/);
  assert.match(evidence, /index\.html/);
  assert.match(evidence, /report\.json/);
  assert.match(evidence, /logs\/stdout\.log/);
  assert.match(evidence, /manifest\.json/);
  assert.match(evidence, /data:image\/png;base64/);
  assert.match(evidence, /玩家需求覆盖/);
  assert.match(evidence, /ZIP cannot contain symbolic links/);
  assert.doesNotMatch(builder, /preparePackagedE2eContract|copyPackagedE2eContract|\.deviludo-e2e-package/);
  assert.match(builder, /BUILD_PRODUCT: Godot reported script errors despite exit code 0/);
  assert.match(builder, /BUILD_PRODUCT: Godot project validation failed/);
  assert.match(macDriver, /CGEvent\(keyboardEventSource/);
  assert.match(macDriver, /"P": 35/);
  assert.match(macDriver, /value\.hasPrefix\("KEY_"\)/);
  assert.match(macDriver, /SCScreenshotManager\.captureImage/);
  assert.match(macDriver, /let backgroundColor = CGColor\(gray: 0, alpha: 1\)/);
  assert.match(macDriver, /withExtendedLifetime\(retainedBackgroundColor\)/);
  assert.match(macDriver, /case "resize"/);
  assert.match(macDriver, /case "sequence"/);
  assert.match(macDriver, /func waitForFocusedGameWindow\(pid: pid_t, timeout: TimeInterval = 2\.0\)/);
  assert.match(macDriver, /focus\(pid: pid\)[\s\S]*application\?\.isActive == true[\s\S]*window\.isOnScreen/);
  assert.match(macDriver, /AXUIElementSetAttributeValue\(app, kAXFrontmostAttribute/);
  const macFocus = macDriver.match(/func focus\(pid: pid_t\)[\s\S]*?(?=func waitForFocusedGameWindow)/)?.[0] ?? "";
  assert.doesNotMatch(macFocus, /guard AXUIElementCopyAttributeValue\(app, kAXFocusedWindowAttribute/);
  assert.match(macFocus, /!application\.isTerminated/);
  const macInput = macDriver.match(/case "event":[\s\S]*?(?=case "capture")/)?.[0] ?? "";
  assert.match(macInput, /waitForFocusedGameWindow\(pid: pid\)/);
  assert.doesNotMatch(macInput, /activate\(options: \[\.activateAllWindows\]\)[\s\S]*performInputEvent/);
  assert.match(macDriver, /ProcessInfo\.processInfo\.systemUptime/);
  assert.match(macDriver, /sequenceStartedAt \+ dueOffset/);
  const macWait = macDriver.match(/case "wait":[\s\S]*?(?=case "event")/)?.[0] ?? "";
  assert.match(macWait, /NSRunningApplication\(processIdentifier: pid\)/);
  assert.match(macWait, /gameWindow\(pid: pid\)/);
  assert.match(macWait, /window\.isOnScreen/);
  assert.doesNotMatch(macWait, /focus\(pid: pid\)/);
  assert.match(macDriver, /CGWindowListCopyWindowInfo\(\[\.optionAll, \.excludeDesktopElements\]/);
  assert.match(macDriver, /windowDiagnostics\(pid: pid\)/);
  assert.match(macDriver, /case "find-pid"|command == "find-pid"/);
  assert.match(macDriver, /NSWorkspace\.shared\.runningApplications/);
  assert.match(macDriver, /if left\.isOnScreen != right\.isOnScreen/);
  assert.match(macDriver, /NSScreen\.main\?\.backingScaleFactor/);
  assert.match(macDriver, /window\.bounds\.width \* backingScale\(\) >= width/);
  assert.match(macDriver, /CGFloat\(x\) \/ backingScale\(\)/);
  assert.match(macDriver, /if type == "mouse_click" \{ Thread\.sleep\(forTimeInterval: 0\.05\) \}/);
  assert.match(macDriver, /if let x = event\["x"\] as\? Int, let y = event\["y"\] as\? Int/);
  assert.match(macDriver, /window\.bounds\.width \* scale/);
  assert.doesNotMatch(macDriver, /CGWindowListCreateImage/);
  assert.match(linuxDriver, /xdotool/);
  assert.match(linuxDriver, /unsupported keyboard input/);
  assert.match(linuxDriver, /command === "sequence"/);
  assert.match(linuxDriver, /const startedAt = performance\.now\(\)/);
  assert.match(linuxDriver, /startedAt \+ dueOffsetMs/);
  assert.match(windowsDriver, /SendInput/);
  assert.match(windowsDriver, /name\.StartsWith\("KEY_"/);
  assert.match(windowsDriver, /\$Command -eq 'sequence'/);
  assert.match(windowsDriver, /\[Diagnostics\.Stopwatch\]::StartNew\(\)/);
  assert.match(windowsDriver, /\$dueMilliseconds-\$clock\.Elapsed\.TotalMilliseconds/);
  assert.match(linuxIsolation, /--graphics spice,listen=none --video virtio/);
  assert.doesNotMatch(linuxIsolation, /--graphics none/);
});

test("a validated Test Agent manifest is frozen across product repair and E2E reruns", async () => {
  const [api, repository] = await Promise.all([
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8"),
  ]);
  assert.match(api, /readFrozenE2eTestPlan/);
  assert.match(api, /freezeE2eTestPlan/);
  assert.match(api, /projectTestContract: frozen\.testManifest/);
  assert.match(repository, /ON CONFLICT \(workspace_id, workflow_id, target_platform\) DO NOTHING/);
  assert.match(repository, /Frozen E2E test plan belongs to another project/);
});

test("release is blocked on native Linux, Windows, and macOS Godot acceptance", async () => {
  const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const runner = await readFile(new URL("../scripts/real-platform-e2e.mjs", import.meta.url), "utf8");
  for (const platform of ["linux", "windows", "macos"]) assert.match(release, new RegExp(`platform: ${platform}`));
  assert.match(release, /runner: ubuntu-24\.04/);
  assert.match(release, /runner: windows-2025/);
  assert.match(release, /runner: macos-14/);
  assert.match(release, /needs: real-platform-acceptance/);
  assert.match(release, /npm run test:e2e:platform -- --platform=\$\{\{ matrix\.platform \}\}/);
  assert.match(release, /npm run check/);
  assert.match(runner, /REAL_PLATFORM_MISMATCH/);
  assert.match(runner, /DEVILUDO_E2E_RESULT/);
  assert.match(runner, /missingChecks/);
  assert.match(runner, /deviludo\.real-platform-acceptance\.v1/);
});

test("state backup and restore cover all durable stores with integrity and empty-target guards", async () => {
  const backup = await readFile(new URL("../scripts/backup-state.mjs", import.meta.url), "utf8");
  const restore = await readFile(new URL("../scripts/restore-state.mjs", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../Dockerfile.core", import.meta.url), "utf8");
  assert.match(dockerfile, /postgresql17-client/);
  assert.match(backup, /LOCK TABLE .* IN SHARE MODE/);
  assert.match(backup, /pg_dump/);
  assert.match(backup, /DEVILUDO_PROJECTS_ROOT/);
  assert.match(backup, /ListObjectsV2Command/);
  assert.match(backup, /Referenced object is missing or inconsistent/);
  assert.match(backup, /schemaVersion: "deviludo\.state-backup\.v1"/);
  assert.match(restore, /--confirm=RESTORE_DEVILUDO_BACKUP/);
  assert.match(restore, /already contains the deviludo schema/);
  assert.match(restore, /Restore target database is not empty/);
  assert.match(restore, /artifact bucket is not empty/);
  assert.match(restore, /pg_restore/);
  assert.match(restore, /--single-transaction/);
  assert.match(restore, /ALTER FUNCTION %s OWNER TO deviludo_claim_executor/);
  assert.match(restore, /Restored migration ledger does not match the backup/);
});

test("E2E failures and isolation cleanup remove transient workspaces", async () => {
  const [executor, linux, macos, windows] = await Promise.all([
    readFile(new URL("../deploy/assets/e2e-job-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/e2e-linux-isolation.sh", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/e2e-macos-isolation.sh", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/e2e-windows-isolation.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(executor, /if \(!evidenceOutputReady\) await rm\(workspace/);
  assert.doesNotMatch(executor, /signedOutputReady|ARTIFACT_SIGN|STEAM_CLEAN_INSTALL/);
  assert.match(executor, /executable\.endsWith\("\.mjs"\)[\s\S]*process\.execPath[\s\S]*\[executable, \.\.\.arguments_\]/);
  assert.doesNotMatch(executor, /spawn\(guestRunner,/);
  assert.match(executor, /Guest runner outcome contract is invalid: \$\{JSON\.stringify\(diagnostic\)\}/);
  assert.match(linux, /action == reap[\s\S]*virsh destroy[\s\S]*virsh undefine/);
  assert.match(macos, /action == reap[\s\S]*tart stop[\s\S]*tart delete/);
  assert.match(windows, /Action -eq 'reap'[\s\S]*Stop-VM[\s\S]*Remove-VM/);
  assert.match(windows, /Filter "deviludo-\$JobId-\*"[\s\S]*Remove-Item -Recurse -Force/);
});

test("the shared product shell is mounted once so route changes preserve the local instance", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  assert.match(layout, /<LanguageProvider[\s\S]*<ProductShell>\{children\}<\/ProductShell>[\s\S]*<\/LanguageProvider>/);
  assert.match(page, /<AgentSettings \/>/);
  assert.doesNotMatch(page, /ProductShell/);
});

test("the shell supports persistent light, dark, and live system themes without a hydration flash", async () => {
  const [layout, provider, shell, themes] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/theme/ThemeProvider.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ProductShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/theme.css", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /const themeBootstrap = `[\s\S]*deviludo_theme[\s\S]*prefers-color-scheme: dark/);
  assert.match(layout, /<head><script dangerouslySetInnerHTML=\{\{ __html: themeBootstrap \}\} \/><\/head>/);
  assert.match(layout, /<ThemeProvider>[\s\S]*<LanguageProvider/);
  assert.match(provider, /export type ThemeMode = "system" \| "light" \| "dark"/);
  assert.match(provider, /localStorage\.setItem\(THEME_STORAGE_KEY, nextMode\)/);
  assert.match(provider, /media\.addEventListener\("change", handleSystemChange\)/);
  assert.match(provider, /document\.documentElement\.dataset\.theme = resolved/);
  assert.match(shell, /<ThemeSwitcher compact \/>/);
  assert.match(themes, /html\[data-theme="light"\] \.app-shell/);
  assert.match(themes, /html\[data-theme="light"\] \.auth-screen/);
  assert.match(themes, /html\[data-theme="light"\] \.product-delivery-configuration > summary/);
  assert.match(themes, /html\[data-theme="light"\] \.product-delivery-config-toggle/);
  assert.match(themes, /html\[data-theme="light"\] \.badge\.is-ready[\s\S]*background: #19845d/);
  assert.match(themes, /\.theme-switcher button\[aria-pressed="true"\]/);
});

test("image generation is part of the selected Agent connection", async () => {
  const [page, agent, assetSettings] = await Promise.all([
    readFile(new URL("../app/settings/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AgentSettings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AssetAutoGenerationSetting.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /ImageGenerationSettings/);
  assert.match(agent, /setImageModel/);
  assert.doesNotMatch(agent, /updateModelOverride\("image"/);
  assert.match(agent, /the image-generation backend follows the selected runtime automatically/);
  assert.match(agent, /Codex built-in ImageGen \(gpt-image-2\)/);
  assert.match(assetSettings, /imageGenerationReady/);
});

test("settings and project details use unnumbered sections and Codex remains selectable", async () => {
  const [settingsPage, agent, studio] = await Promise.all([
    readFile(new URL("../app/settings/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AgentSettings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(`${settingsPage}\n${agent}\n${studio}`, /section-number|step-number|stage-number|agent-settings-summary|agent-config-security/);
  assert.match(agent, /<input checked=\{agentRuntime === kind\} name="agentRuntime" onChange=\{\(\) => selectRuntime\(kind\)\} type="radio"/);
  assert.doesNotMatch(agent, /disabled=\{[^}]*CODEX_CLI/);
  assert.match(settingsPage, /settings-secondary-grid/);
});

test("English mode is the first-run default and localizes settings, assets, metadata, and server fallbacks", async () => {
  const [agentSettings, assetPanel, language, layout, metadata, proxy] = await Promise.all([
    readFile(new URL("../components/AgentSettings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AssetManifestPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/i18n/LanguageProvider.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/web/localized-metadata.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/[...segments]/route.ts", import.meta.url), "utf8"),
  ]);
  for (const component of [agentSettings, assetPanel]) {
    assert.match(component, /useLanguage\(\)/);
    assert.doesNotMatch(component, />\s*[\p{Script=Han}][^<{]*</u);
  }
  assert.match(language, /locale === "en" && \/\\p\{Script=Han\}\//);
  assert.match(layout, /localizedMetadata\(/);
  assert.match(layout, /storedLocale === "zh" \? "zh" : "en"/);
  assert.match(metadata, /value !== "zh"/);
  assert.match(proxy, /=== "zh" \? chinese : english/);
  assert.match(proxy, /requestText\(request, "请求来源校验失败", "Request origin validation failed"\)/);
});

test("remote E2E node connectivity refreshes from server heartbeats", async () => {
  const dashboard = await readFile(new URL("../components/ServerPoolDashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /window\.setTimeout\(\(\) => refresh\(0\), preparing \? 2_000 : 15_000\)/);
  assert.match(dashboard, /isRecentlyConnected\(node\.lastHeartbeatAt\)/);
  assert.match(dashboard, /node\.preparation\.progress/);
  assert.match(dashboard, /role="progressbar"/);
  assert.match(dashboard, /Date\.now\(\) - Date\.parse\(value\) < 90_000/);
  assert.match(dashboard, /pool\.readiness === "READY" \? "is-ready" : "is-not-ready"/);
});

test("product pages share local instance data and never poll an idle project", async () => {
  const shell = await readFile(new URL("../components/ProductShell.tsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../components/ProductDashboard.tsx", import.meta.url), "utf8");
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const telemetry = await readFile(new URL("../components/TelemetrySettings.tsx", import.meta.url), "utf8");
  assert.match(shell, /fetch\("\/api\/instance"/);
  for (const source of [dashboard,studio,telemetry]) assert.doesNotMatch(source,/fetch\("\/api\/instance"/);
  assert.doesNotMatch(telemetry, /type="checkbox"|method: "PUT"|setEnabled|OPT IN/);
  assert.match(telemetry, /AUTOMATIC REPORTING ACTIVE/);
  assert.match(telemetry, /official collector/);
  assert.doesNotMatch(studio,/setInterval|1500/);
  assert.match(studio,/workflowNeedsPolling\(workflowState\)/);
  assert.doesNotMatch(studio,/repositoryNeedsPolling|platformManaged|github\/repositories/);
});

test("the API Key field stays outside browser password managers", async () => {
  const component = await readFile(new URL("../components/AgentSettings.tsx", import.meta.url), "utf8");
  assert.match(component, /className="agent-api-key-input"/);
  assert.match(component, /autoComplete="off"/);
  assert.match(component, /data-form-type="other"/);
  assert.match(component, /name="providerCredential"/);
  assert.match(component, /placeholder=\{settings\.apiKeyMasked \?\? text\("输入 API Key", "Enter API Key"\)\}/);
  assert.doesNotMatch(component, /autoComplete="new-password"/);
  assert.doesNotMatch(component, /当前指纹/);
  assert.doesNotMatch(component, /已保存 \$\{settings\.apiKeyMasked/);
});

test("model settings let Codex choose text models while image generation follows the runtime", async () => {
  const component = await readFile(new URL("../components/AgentSettings.tsx", import.meta.url), "utf8");
  assert.match(component, /name="primaryModel"/);
  for (const role of ["design", "development", "test"]) {
    assert.match(component, new RegExp(`updateModelOverride\\("${role}"`));
  }
  assert.match(component, /onChange=\{setImageModel\}/);
  assert.match(component, /image generation does not inherit/);
  assert.match(component, /Codex built-in ImageGen/);
  assert.doesNotMatch(component, /updateModelOverride\("image"/);
  assert.doesNotMatch(component, /ModelMode|expandedModels|Opus|Sonnet|Haiku|Subagent/);
});

test("connection variables do not render helper copy below their inputs", async () => {
  const component = await readFile(new URL("../components/AgentSettings.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(component, /生产环境必须使用 HTTPS/);
  assert.doesNotMatch(component, /同时用于主模型/);
  assert.doesNotMatch(component, /支持 Base URL、AUTH TOKEN/);
  assert.doesNotMatch(component, /<small>\{variable\}<\/small>/);
});

test("Core product surfaces use their fixed local workspace without an identity selector", async () => {
  const shell = await readFile(new URL("../components/ProductShell.tsx", import.meta.url), "utf8");
  const home = await readFile(new URL("../components/HomeChat.tsx", import.meta.url), "utf8");
  const projects = await readFile(new URL("../components/ProductDashboard.tsx", import.meta.url), "utf8");
  assert.match(shell, /const workspace = instance\.workspace/);
  assert.match(shell, /Free self-hosted instance/);
  assert.doesNotMatch(shell, /Select workspace|Add workspace|No workspace selected/);
  assert.doesNotMatch(shell, /displayName|WorkspaceAdmin|SANDBOX LOCKED|PRODUCTION SLOT/);
  assert.doesNotMatch(home, /选择一个项目继续修改|从需求和细节开始沟通/);
  assert.doesNotMatch(projects, /这里只展示当前账号|PostgreSQL 工作区|CORE 工作流已绑定|隔离命名空间/);
});

test("image assets are a branched visual stage backed by asynchronous generation", async () => {
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../components/AssetManifestPanel.tsx", import.meta.url), "utf8");
  const assetSettings = await readFile(new URL("../components/AssetAutoGenerationSetting.tsx", import.meta.url), "utf8");
  // The serial pipeline must not contain an asset stage: it produces no job, so
  // the chain would stall waiting for one.
  const pipeline = studio.match(/const PIPELINE = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  assert.doesNotMatch(pipeline, /ASSET/);
  assert.deepEqual([...pipeline.matchAll(/\["([A-Z0-9_]+)"/g)].map(match => match[1]), [
    "AGENT_GENERATION", "ARTIFACT_BUILD", "E2E_TEST", "STEAM_PUBLISH",
  ]);
  assert.match(studio, /className="product-delivery-material-branch"/);
  assert.match(studio, /className="product-delivery-material-group"/);
  assert.match(studio, /product-delivery-material-stage status-/);
  assert.match(studio, /text\("美术", "ART"\)/);
  assert.match(studio, /text\("音乐", "MUSIC"\)/);
  assert.match(studio, /asset-manifest\/generate-missing/);
  assert.match(studio, /<AssetManifestPanel onManifestChange=\{setAssetManifestView\} onOpenSourceImage=\{openSourceImage\}/);
  // Applying assets has one entry point: the ordinary Build-node rerun icon.
  assert.doesNotMatch(panel, /rerun-stage|Rebuild with assets|使用素材重新构建/);
  assert.match(studio, /mutate\("rerun-stage", \{ stage: kind \}\)/);
  assert.match(studio, /\["ARTIFACT_BUILD", "制品构建", "Artifact Build"\]/);
  // The panel goes through the authenticated Core proxy, never straight to S3 or
  // the database. Generation readiness belongs to the delivery setting, while
  // the expanded panel is only responsible for status, uploads, and rebuilds.
  assert.doesNotMatch(panel, /FormData|s3|S3Client|aws-sdk/);
  assert.doesNotMatch(panel, /imageGenerationReady|toggleAutoGenerate/);
  assert.match(assetSettings, /imageGenerationReady/);
  assert.doesNotMatch(`${panel}\n${assetSettings}`, /apiKeyMask|apiKey\b/);
  assert.match(panel, /accept="image\/png,image\/jpeg,image\/webp"/);
});

test("image assets gate the first build and Steam upload remains an explicit local decision", async () => {
  const sql = await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8");
  const api = await readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8");
  const repository = await readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8");
  const daemon = await readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8");
  const runner = await readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8");
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const steamPanel = await readFile(new URL("../components/ProjectSteamPanel.tsx", import.meta.url), "utf8");
  const steamSettings = await readFile(new URL("../components/SteamSettings.tsx", import.meta.url), "utf8");
  const scheduler = await readFile(new URL("../services/core/src/scheduler.ts", import.meta.url), "utf8");
  assert.match(sql, /state = 'ASSET_GENERATING'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION deviludo\.advance_asset_workflows/);
  assert.match(sql, /item\.status NOT IN \('generated', 'uploaded', 'existing'\)/);
  assert.match(scheduler, /advanceReadyWorkflows\(\)/);
  assert.match(sql, /snapshot_artifact_build_assets/);
  assert.match(repository, /kind: "ASSET", assetKey, bucket, key,[\s\S]*sha256: sha256 as ObjectReference/);
  assert.match(daemon, /Build asset inputs do not satisfy the fixed materialization contract/);
  assert.match(runner, /materializeBuildAssets\(plan\)/);
  assert.match(runner, /assertBuildAssetsReferenced\("\/workspace\/project", assets\.map\(asset => asset\.assetKey\)\)/);
  assert.match(runner, /BLOCKING BUILD REPAIR/);
  assert.match(runner, /ASSET USAGE REPAIR:[\s\S]*connect that generated texture visibly[\s\S]*remove the genuinely unnecessary key/);
  assert.match(runner, /res:\/\/assets\/generated\/\$\{asset\.assetKey\}\.\$\{extension\}/);
  assert.match(runner, /"data\/sprites\/", "data\/generated_assets\/"/);
  assert.match(await readFile(new URL("../services/core/src/asset-manifest.ts", import.meta.url), "utf8"), /"data\/sprites\/", "data\/generated_assets\/"/);
  assert.match(sql, /SET state = 'RELEASE_DECISION_PENDING'/);
  assert.match(sql, /CREATE TABLE deviludo\.workspace_steam_settings/);
  assert.match(sql, /CREATE TABLE deviludo\.project_steam_settings/);
  assert.match(sql, /CREATE TABLE deviludo\.steam_releases/);
  assert.match(api, /"\/v1\/projects\/:projectId\/steam-releases"/);
  assert.match(api, /"\/v1\/projects\/:projectId\/iterations\/:workflowId\/complete"/);
  assert.doesNotMatch(api, /principal\.role|workspaceRole|instanceAdmin/);
  assert.doesNotMatch(api, /approve-release|signing-grant/);
  assert.match(studio, /<ProjectSteamPanel/);
  assert.match(steamPanel, /APPROVE & UPLOAD TO STEAM/);
  assert.match(steamPanel, /FINISH WITHOUT PUBLISHING/);
  assert.match(steamPanel, /body === undefined \? \{\} : \{ "content-type": "application\/json" \}/);
  assert.match(steamSettings, /STEAM BUILD CREDENTIAL/);
  assert.match(runner, /file\.startsWith\(`build-\$\{platform\}-`\)/);
  assert.match(runner, /steam\.channel === "TEST" \? `  "SetLive"/);
  assert.doesNotMatch(runner, /signed-build-|STEAM_APP_ID|STEAM_DEPOT_/);
});

test("auto-generate never removes the user's own way to supply an asset", async () => {
  const [panel, assetSettings, studio] = await Promise.all([
    readFile(new URL("../components/AssetManifestPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AssetAutoGenerationSetting.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8"),
  ]);
  // Hiding upload while auto-generate was on was a trap: an asset whose prompt the
  // provider kept rejecting had no way forward, and a user holding the art had to
  // turn a setting off to use it. Only an in-flight generation hides it, because
  // that write would race the generator. A source-discovered file is already
  // supplied and is shown with its real source path instead of a duplicate upload.
  assert.match(panel, /\{item\.status !== "generating" && item\.status !== "existing" && \(/);
  assert.doesNotMatch(panel, /item\.status === "planned" && !autoGenerateEnabled/);
  // Policy now lives in the prominent delivery settings instead of being hidden
  // behind the asset-list disclosure. Every disabled state still explains itself.
  assert.match(studio, /<AssetAutoGenerationSetting/);
  assert.ok(studio.indexOf("product-delivery-configuration") < studio.indexOf("product-delivery-canvas"));
  assert.match(assetSettings, /const cannotEnable = !autoGenerateEnabled && !imageGenerationReady/);
  assert.match(assetSettings, /图片将由内置 ImageGen 生成/);
  assert.match(assetSettings, /Agent 生成素材清单后即可配置自动生成/);
  assert.doesNotMatch(`${panel}\n${assetSettings}`, /generationConfig|providerSupported|configComplete/);
  // Generation settles in the background with nothing to push the result, so the
  // panel polls while work is outstanding and stops when it is not.
  assert.match(panel, /const generationOutstanding = autoGenerateEnabled/);
  assert.match(panel, /if \(!generationOutstanding\) return;/);
  // A red failure count with no next step is a dead end; say what to do.
  assert.match(panel, /点击上方美术节点的重跑按钮，只补齐缺失素材/);
});

test("expanded image assets stay in a bounded scrolling list with one immediate picker", async () => {
  const [panel, studio, styles, core, bridge] = await Promise.all([
    readFile(new URL("../components/AssetManifestPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/asset-manifest.css", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-git-import-server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(styles, /\.asset-items-list\s*\{[\s\S]*max-height:[\s\S]*overflow-y: auto/);
  assert.match(styles, /overscroll-behavior: contain/);
  assert.equal([...panel.matchAll(/type="file"/g)].length, 1);
  assert.match(panel, /uploadInputRef\.current\.click\(\)/);
  assert.match(panel, /aria-label=\{text\("图片素材列表", "Image asset list"\)\}[\s\S]*role="region"[\s\S]*tabIndex=\{0\}/);
  assert.match(panel, /type AssetListFilter = "all" \| "complete" \| "generating" \| "failed"/);
  assert.match(panel, /assetFilter === "complete"[\s\S]*\["existing", "generated", "uploaded"\]\.includes\(item\.status\)/);
  assert.match(panel, /aria-pressed=\{assetFilter === "all"\}[\s\S]*setAssetFilter\("all"\)/);
  assert.match(panel, /aria-pressed=\{assetFilter === "complete"\}[\s\S]*setAssetFilter\("complete"\)/);
  assert.match(panel, /aria-pressed=\{assetFilter === "generating"\}[\s\S]*setAssetFilter\("generating"\)/);
  assert.match(panel, /\{filteredItems\.map\(item => \(/);
  assert.match(styles, /\.asset-manifest-filter\.is-active \{[\s\S]*border-color: var\(--blue\)/);
  assert.match(panel, /className="asset-source-preview"[\s\S]*<SourceAssetThumbnail/);
  assert.match(panel, /sourceImageUrl\(projectId, sourcePath\)/);
  assert.match(studio, /fetch\(`\$\{bridgeUrl\}\/directory\/file\/open`/);
  assert.match(core, /"\/v1\/projects\/:projectId\/source-image"/);
  assert.match(core, /projectSources\.readImage/);
  assert.match(core, /content-security-policy", "sandbox; default-src 'none'/);
  assert.match(bridge, /async function openBoundProjectFile/);
  assert.match(bridge, /execute\("\/usr\/bin\/open", \[canonical\]/);
});

test("all self-hosted artifacts open through the verified host bridge", async () => {
  const [studio, bridge, localUp] = await Promise.all([
    readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-git-import-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-up.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(studio, /const opensOnHost = true/);
  assert.match(studio, /fetch\(`\$\{bridgeUrl\}\/artifact\/open`/);
  assert.match(studio, /locale,[\s\S]*theme: document\.documentElement\.dataset\.theme/);
  assert.match(studio, /text\("打开", "OPEN"\)/);
  assert.match(bridge, /"E2E_REPORT"/);
  assert.match(bridge, /"PROJECT_DOCUMENT"/);
  assert.match(bridge, /if \(!BUILD_ARTIFACT_KINDS\.has\(kind\)\)[\s\S]*\/usr\/bin\/open/);
  assert.match(bridge, /sourceUrl\.origin !== artifactOrigin\.origin/);
  assert.match(bridge, /reportUrl\.searchParams\.set\("locale", locale\)/);
  assert.match(bridge, /reportUrl\.searchParams\.set\("theme", theme\)/);
  assert.match(bridge, /received !== expectedSize[\s\S]*hash\.digest\("hex"\)/);
  assert.match(bridge, /execute\("\/usr\/bin\/open", \[app\]/);
  assert.match(bridge, /assertSafeArchiveEntries/);
  assert.match(localUp, /artifactOrigin: `http:\/\/127\.0\.0\.1:\$\{artifactPort\}`/);
});

test("the asset panel only uses custom properties the themes actually define", async () => {
  const [assets, globals, product] = await Promise.all([
    readFile(new URL("../app/asset-manifest.css", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/product.css", import.meta.url), "utf8"),
  ]);
  // The panel was written against a token vocabulary this project never had
  // (--panel-bg, --error-color, …), so it rendered with no background, no borders,
  // and no status colours — the very thing that distinguishes "generating" from
  // "failed". An undefined custom property silently inherits, so nothing warns.
  const defined = new Set([...`${globals}\n${product}`.matchAll(/--([a-z][a-z0-9-]*)\s*:/g)].map(match => match[1]));
  const missing = [...new Set([...assets.matchAll(/var\(--([a-z][a-z0-9-]*)\)/g)].map(match => match[1]))]
    .filter(token => !defined.has(token));
  assert.deepEqual(missing, [], `asset-manifest.css references undefined tokens: ${missing.join(", ")}`);
});

test("asset generation runs off the delivery chain on its own cadence", async () => {
  const scheduler = await readFile(new URL("../services/core/src/scheduler.ts", import.meta.url), "utf8");
  const generation = await readFile(new URL("../services/core/src/asset-generation.ts", import.meta.url), "utf8");
  const compose = await readFile(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  // Driven by the scheduler tick, not by a job kind: a job would put assets back on
  // the serial chain they were deliberately taken off.
  assert.match(scheduler, /runAssetGenerationBatch/);
  assert.doesNotMatch(generation, /ASSET_GENERATION|enqueue_job|jobKind/);
  // The tick is sub-second so job recovery stays responsive; claiming assets that
  // often would be database churn against work that takes tens of seconds.
  assert.match(scheduler, /Date\.now\(\) >= nextAssetSweepAt/);
  assert.match(scheduler, /config\.assetGenerationPollMilliseconds/);
  // A deployment with no object store keeps running the rest of the tick rather
  // than crash-looping on a bucket it does not need.
  assert.match(scheduler, /if \(!assetGeneration\) \{/);
  assert.match(scheduler, /event: "asset_generation_disabled"/);
  // One asset failing must not abandon the batch, and the failure is recorded
  // against that item rather than thrown.
  assert.match(generation, /if \(settled\) generated \+= 1;\s*\n\s*else failed \+= 1;/);
  assert.match(generation, /repository\.assets\.failGeneration/);
  // The credential is resolved once per batch, not per asset.
  assert.match(generation, /Resolve the selected runtime's credential once per batch/);
  // The scheduler now needs the object store, a Vault token, and egress: `data` is
  // an internal network and cannot reach a provider on its own.
  const schedulerService = compose.match(/ {2}core-scheduler:([\s\S]*?)\n {2}core-sandbox:/)?.[1] ?? "";
  assert.match(schedulerService, /DEVILUDO_ARTIFACT_BUCKET/);
  assert.match(schedulerService, /DEVILUDO_VAULT_TOKEN_FILE/);
  assert.match(schedulerService, /networks:[\s\S]*- egress/);
});

test("the trusted Agent manifest reaches automatic image generation", async () => {
  const [runner, fixture, sandbox, objectStore, sql] = await Promise.all([
    readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/sandbox-executor/task-fixture-agent.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/sandbox.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/object-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8"),
  ]);
  // CLI stdout is JSONL/stream-json diagnostics. The contract lives in the
  // generated source's agent.json and both the real and fixture runners upload it.
  assert.match(runner, /readFile\("\/workspace\/project\/agent\.json", "utf8"\)/);
  assert.doesNotMatch(runner, /writeFile\("\/workspace\/outputs\/agent\.json", result\.stdout/);
  assert.match(fixture, /readFile\("\/workspace\/project\/agent\.json", "utf8"\)/);
  // Core re-reads the digest-checked output rather than trusting executor details,
  // then includes the asset manifest in complete_job's receipt.
  assert.match(objectStore, /async readAgentCompletion\(/);
  assert.match(objectStore, /readJsonOutput\(objects, "SPECIFICATION"/);
  assert.match(sandbox, /objectStore\.readAgentCompletion\(receipt\.outputObjects\)/);
  assert.doesNotMatch(sandbox, /projectSources\.readRevisionFile\(relativePath, "agent\.json"/);
  assert.match(sandbox, /\.\.\.\(agentCompletion \?\? \{\}\)/);
  assert.match(objectStore, /Object\.hasOwn\(parsed, "testManifest"\)/);
  assert.match(fixture, /delete generatedManifest\.testManifest/);
  // Planning immediately enables the asynchronous scheduler branch.
  assert.match(sql, /auto_generate_enabled boolean NOT NULL DEFAULT true/);
  assert.match(sql, /auto_generate_enabled = true/);
});

test("every delivery node stays visible, including stages this run will not reach", async () => {
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  // A profile filter on the rendered list made the signing and publication nodes
  // disappear from a VALIDATE project, so the pipeline no longer showed what was
  // still ahead. The track iterates the whole chain; the profile only decides how a
  // node is labelled and whether its rerun is offered.
  assert.match(studio, /<ol className="product-delivery-track">[\s\S]*discoveryStage\.title[\s\S]*\{PIPELINE\.map\(/);
  assert.match(studio, /text\("已有项目分析", "PROJECT ANALYSIS"\)/);
  assert.doesNotMatch(studio, /visibleStages/);
  assert.match(studio, /const inProfile = profileStages\.has\(kind\);/);
  assert.match(studio, /const view = inProfile[\s\S]*waitingForPredecessor \? waitingPipelineStageView\(text\) : pipelineStageView\(state, text\)[\s\S]*: OUT_OF_PROFILE_STAGE_VIEW\(text\)/);
  // An out-of-profile stage is not merely "not started": this run never runs it.
  assert.match(studio, /label: text\("不适用", "NOT APPLICABLE"\)/);
  // A failed stage outside the profile must not be offered as a retry target.
  assert.match(studio, /latestFailedJob && profileStages\.has\(latestFailedJob\.kind\)/);
  // The rerun control is now an icon that appears on hover.
  assert.match(studio, /className="product-delivery-stage-rerun-icon"/);
  assert.match(studio, /<RerunIcon \/>/);
});

test("the rerun control overlays the stage marker and stays reachable without hover", async () => {
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/product.css", import.meta.url), "utf8");
  const icons = await readFile(new URL("../components/console/Icons.tsx", import.meta.url), "utf8");
  assert.match(icons, /export function RerunIcon/);
  // The icon carries no text, so the label has to name the stage it reruns and the
  // downstream supersession — a bare "rerun" tooltip would not say what is lost.
  assert.match(studio, /aria-label=\{text\(\s*`从「\$\{chineseLabel\}」重新执行，之后的阶段都会重跑`/);
  const overlay = styles.match(/^\.product-delivery-stage-rerun-icon \{([\s\S]*?)\n\}/m)?.[1] ?? "";
  // It occupies the marker's own 36px square rather than floating below, where it
  // used to sit on top of the stage number and label.
  assert.match(overlay, /height: 36px/);
  assert.match(overlay, /width: 36px/);
  assert.match(overlay, /top: 0/);
  assert.doesNotMatch(overlay, /border-radius/);
  // Above the marker (z-index 1), so the two never blend into each other.
  assert.match(overlay, /z-index: 3/);
  // Hidden until the stage is hovered, and non-interactive while hidden so a click
  // on an invisible control cannot fire a rerun.
  assert.match(overlay, /opacity: 0/);
  assert.match(overlay, /pointer-events: none/);
  assert.match(styles, /\.product-delivery-stage:hover \.product-delivery-stage-rerun-icon \{\s*opacity: 1;\s*pointer-events: auto;/);
  // Keyboard users never hover, so focus has to reveal it too.
  assert.match(styles, /\.product-delivery-stage-rerun-icon:focus-visible \{[^}]*opacity: 1/);
  assert.match(styles, /\.product-delivery-stage-rerun-icon:focus-visible \{[^}]*pointer-events: auto/);
  // Neither does a touch screen: there the overlay is a persistent corner badge.
  assert.match(styles, /@media \(hover: none\) \{\s*\.product-delivery-stage-rerun-icon \{[^}]*opacity: 1/);
  // A dimmed not-started stage has to become legible once it is the hover target.
  assert.match(styles, /\.product-delivery-stage\.status-pending:hover \{\s*opacity: 1;/);
  // The click acknowledgement is motion, so it has to be dropped under reduce.
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.product-delivery-stage-rerun-icon:active svg \{ animation: none; \}/);
  // The old text button is gone from both the markup and the stylesheet.
  assert.doesNotMatch(studio, /product-delivery-stage-rerun"|从这里重跑|RE-RUN FROM HERE/);
  assert.doesNotMatch(styles, /\.product-delivery-stage-rerun \{/);
});

test("one rerun endpoint covers every delivery node once the workflow is at rest", async () => {
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8");
  // The three per-stage retry endpoints collapsed into one parameterized rerun.
  for (const retired of ["retry-agent", "retry-artifact-build", "retry-e2e"]) {
    assert.ok(!studio.includes(retired), `${retired} must no longer be called`);
    assert.ok(!api.includes(retired), `${retired} must no longer be served`);
  }
  assert.match(api, /"\/v1\/projects\/:projectId\/rerun-stage"/);
  assert.match(api, /"\/v1\/e2e\/jobs\/:jobId\/player-policy\/verify"/);
  assert.match(api, /PLAYER_POLICY_VISION_UNAVAILABLE[\s\S]*reply\.code\(503\)\.send/);
  assert.match(api, /Test Agent policy request failed[\s\S]*return reply\.code\(503\)\.send/);
  assert.match(studio, /mutate\("rerun-stage", \{ stage: kind \}\)/);
  assert.match(studio, /mutate\("rerun-stage", \{ stage: rerunnableFailedStage \}\)/);
  // Release-decision pending is quiescent: no executor holds a lease, so a Build
  // rerun can apply newly generated assets without forcing cancellation first.
  assert.match(studio, /RERUNNABLE_WORKFLOW_STATES = new Set\(\["RELEASE_DECISION_PENDING", "FAILED", "SUCCEEDED", "CANCELLED"\]\)/);
  assert.match(studio, /RERUNNABLE_WORKFLOW_STATES\.has\(project\.workflowState\)\s*&&\s*project\.jobs\.length > 0/);
  // Every in-profile node renders the same icon. Invalid states disable it
  // instead of replacing the node with a one-off asset rebuild control.
  assert.match(studio, /!viewingHistoricalIteration && inProfile \?/);
  assert.match(studio, /disabled=\{busy \|\| !canRerunStages/);
  assert.match(api, /repository\.rerunStage/);
  assert.match(api, /"RELEASE_DECISION_PENDING", "FAILED", "SUCCEEDED", "CANCELLED"/);
  assert.match(studio, /"idempotency-key": `stage-rerun:\$\{String\(body\?\.stage\)\}:\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(studio, /"idempotency-key": `cancel:\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(api, /requestIdempotencyKey\(request, `cancel:\$\{project\.workflowId\}`\)/);
});

test("Web holds no database pool or object store credentials of its own", async () => {
  const proxy = await readFile(new URL("../app/api/[...segments]/route.ts", import.meta.url), "utf8");
  // Every project mutation goes through Core, which is where workspace isolation
  // and authentication live. Web keeping a pool would bypass both.
  assert.doesNotMatch(proxy, /\bPool\b|aws-sdk|S3Client/);
  assert.match(proxy, /x-deviludo-web-auth/);
  // An 8 MB asset is 4/3 that size once base64-encoded in JSON, so the asset
  // route needs its own ceiling or legal uploads would be rejected in transit.
  assert.match(proxy, /ASSET_UPLOAD_PATH = \/\^projects\\\/\[\^\/\]\+\\\/asset-manifest\\\/uploads\$\//);
  assert.match(proxy, /MAX_ASSET_UPLOAD_BYTES = 12 \* 1024 \* 1024/);
  assert.match(proxy, /if \(ASSET_UPLOAD_PATH\.test\(routePath\)\) return MAX_ASSET_UPLOAD_BYTES/);
  const api = await readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8");
  assert.match(api, /MAX_ASSET_REQUEST_BYTES = Math\.ceil\(MAX_ASSET_BYTES \* 4 \/ 3\)/);
  assert.match(api, /\{ bodyLimit: MAX_ASSET_REQUEST_BYTES \}/);
});

test("project delivery is a top horizontal pipeline without the game specification panel", async () => {
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/product.css", import.meta.url), "utf8");
  assert.doesNotMatch(studio, /游戏规格|提交修订|批准规格|product-specification-panel/);
  assert.doesNotMatch(studio, /等待启动|启动交付|START DELIVERY/);
  assert.match(studio, /text\("按照当前需求开发", "BUILD CURRENT REQUIREMENTS"\)/);
  assert.ok(studio.indexOf('aria-label={text("交付流程", "Delivery pipeline")}') < studio.indexOf("project-conversations-section"));
  assert.ok(studio.indexOf("project-conversations-section") < studio.indexOf("project-document-section"));
  assert.match(studio, /className="project-collaboration-layout"[\s\S]*project-conversations-section[\s\S]*project-document-section/);
  assert.match(styles, /\.project-collaboration-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(300px, 360px\)/);
  assert.match(styles, /\.project-conversation-panel\s*\{[\s\S]*height:\s*min\(700px, calc\(100dvh - 140px\)\)[\s\S]*overflow:\s*hidden/);
  assert.match(styles, /\.project-conversation-box\s*\{[\s\S]*height:\s*100%[\s\S]*overflow:\s*hidden/);
  assert.match(styles, /\.project-conversation-box \.conversation-box-messages\s*\{[\s\S]*flex:\s*1 1 auto[\s\S]*max-height:\s*none/);
  assert.doesNotMatch(studio, /源码修订|SOURCE REVISION|受控目录|Managed path/);
  assert.match(studio, /product-delivery-stage-artifacts/);
  assert.match(studio, /product-delivery-configuration-grid/);
  assert.doesNotMatch(studio, /自动刷新|AUTO REFRESH/);
  assert.match(studio, /product-delivery-config-toggle-icon[\s\S]*product-delivery-config-toggle-closed[\s\S]*展开配置[\s\S]*product-delivery-config-toggle-open[\s\S]*收起配置/);
  assert.ok(studio.indexOf("product-delivery-configuration") < studio.indexOf("product-delivery-canvas"));
  assert.match(studio, /<AssetAutoGenerationSetting[\s\S]*projectId=\{projectId\}/);
  assert.match(styles, /\.product-delivery-configuration > summary:hover[\s\S]*\.product-delivery-configuration\[open\]/);
  assert.match(studio, /!editingLocalBranch[\s\S]*修改分支/);
  assert.match(studio, /label: text\("已完成", "COMPLETED"\)[\s\S]*label: text\("进行中", "IN PROGRESS"\)[\s\S]*label: text\("未开始", "NOT STARTED"\)[\s\S]*label: text\("等待中", "WAITING"\)/);
  assert.match(studio, /currentPipelineJobs\(viewedJobs\.filter[\s\S]*pipelineStageWaitsForPredecessor\(kind, viewedWorkflowState\)/);
  assert.match(styles, /\.product-delivery-track\s*\{[\s\S]*display:\s*flex/);
  assert.match(styles, /\.product-delivery-stage\.status-completed/);
  assert.match(styles, /\.product-delivery-stage\.status-active/);
  assert.match(styles, /\.product-delivery-stage\.status-pending/);
});

test("asset generation branches between Agent and build into matching Art and Music nodes", async () => {
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/product.css", import.meta.url), "utf8");
  const assetStyles = await readFile(new URL("../app/asset-manifest.css", import.meta.url), "utf8");
  assert.match(studio, /<div className="product-delivery-material-branch">[\s\S]*<fieldset className="product-delivery-material-group">/);
  assert.match(studio, /product-delivery-material-stages[\s\S]*text\("美术", "ART"\)[\s\S]*text\("音乐", "MUSIC"\)/);
  assert.doesNotMatch(studio, /product-delivery-async-branch/);
  assert.doesNotMatch(styles, /product-delivery-async-branch|8\.333%/);
  assert.match(styles, /\.product-delivery-material-branch \{[\s\S]*grid-template-columns: repeat\(5/);
  assert.match(studio, /data-stage-kind=\{kind\}[\s\S]*kind === "AGENT_GENERATION"[\s\S]*product-delivery-material-junction/);
  assert.match(styles, /\.product-delivery-stage\[data-stage-kind="AGENT_GENERATION"\]::before \{[\s\S]*bottom: -50px;[\s\S]*right: 0;/);
  assert.match(styles, /\.product-delivery-material-group \{[\s\S]*border: 2px dashed[\s\S]*grid-column: 2 \/ 4/);
  assert.match(styles, /\.product-delivery-material-stages \{[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(studio, /aria-expanded=\{!viewingHistoricalIteration && assetPanelExpanded\}/);
  assert.match(studio, /重新运行美术素材节点，只补齐未生成图片/);
  assert.match(studio, /className="product-delivery-stage-rerun-icon"[\s\S]*<RerunIcon \/>/);
  assert.match(assetStyles, /\.asset-source-preview \{[\s\S]*grid-template-columns: 72px/);
  assert.match(assetStyles, /\.asset-source-thumbnail img \{[\s\S]*object-fit: contain/);
});
