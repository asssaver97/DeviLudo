import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local deployment exposes only Web while Core roles share one image", async () => {
  const compose = await readFile(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /x-core: &core[\s\S]*image: deviludo-core:local/);
  for (const service of ["core-api", "core-scheduler", "core-sandbox"]) {
    assert.match(compose, new RegExp(`\\n  ${service}:\\n    <<: \\*core`));
  }
  assert.match(compose, /web:[\s\S]*127\.0\.0\.1:\$\{DEVILUDO_WEB_HOST_PORT:-3100\}:3000/);
  assert.match(compose, /core-api:[\s\S]*127\.0\.0\.1:\$\{DEVILUDO_CORE_HOST_PORT:-8080\}:8080/);
  assert.match(compose, /DEVILUDO_CLAUDE_CODE_VERSION/);
  assert.match(compose, /DEVILUDO_CODEX_CLI_VERSION/);
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
  const localMacJob = await readFile(new URL("../scripts/executors/local-macos-job.mjs", import.meta.url), "utf8");
  assert.match(localMacJob, /schemaVersion: "deviludo\.godot-guest-report\.v1"/);
  assert.match(localMacJob, /guest: \{/);
  const localUp = await readFile(new URL("../scripts/local-up.mjs", import.meta.url), "utf8");
  assert.match(localUp, /stopLocalE2e/);
  assert.match(localUp, /retainActiveJobRuntimeImages\(baseEnvironment\)/);
  assert.match(localUp, /state IN \('QUEUED', 'RETRY', 'RUNNING'\)/);
  assert.match(localUp, /deviludo-retained-job-runtime/);
  assert.match(localUp, /DEVILUDO_EXECUTOR_ALLOWED_IMAGES: \[\.\.\.new Set\(\[\s*\.\.\.Object\.values\(JSON\.parse\(runtimeImages\)\), \.\.\.retainedJobRuntimeImages/);
  assert.match(localUp, /persistLocalComposeEnvironment\(environment\)/);
  assert.match(localUp, /DEVILUDO_DOCKER_GID/);
  assert.match(localUp, /BEGIN DEVILUDO LOCAL RUNTIME/);
  assert.match(localUp, /detectLocalProviderUpstreamProxy\(\)/);
  assert.match(localUp, /198\.18\.0\.0\/15 Fake-IP/);
  assert.match(localUp, /supportsHttpConnectProxy/);
  assert.match(compose, /DEVILUDO_PROVIDER_UPSTREAM_PROXY/);
  const providerProxy = await readFile(new URL("../services/sandbox-executor/proxy-entrypoint.sh", import.meta.url), "utf8");
  assert.match(providerProxy, /cache_peer %s parent %s 0 no-query default/);
  assert.match(providerProxy, /never_direct allow all/);
  assert.match(localUp, /--reset-incompatible-baseline/);
  assert.match(localUp, /INCOMPATIBLE_BASELINE_RESET_REQUIRED/);
  assert.match(localUp, /"down", "--volumes", "--remove-orphans"/);
  assert.match(localUp, /npm run local:reset:source-v1/);
  assert.doesNotMatch(compose, /deviludo-local-client(?:-secret)?/);
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
  const runner = await readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8");
  const daemon = await readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8");
  assert.match(runner, /attempt <= 3/);
  assert.match(runner, /idleTimeoutMs: 8 \* 60_000/);
  assert.match(runner, /recoverableAgentFailure/);
  assert.match(runner, /checkpoint\.tar\.gz/);
  assert.match(runner, /CLI exited without a diagnostic/);
  assert.match(daemon, /projectSources\.saveCheckpoint/);
  assert.match(daemon, /archiveCheckpoint\(plan\.job\.workspaceId, plan\.job\.projectId, plan\.job\.workflowId\)/);
  assert.match(daemon, /本次已保存/);
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
  assert.match(windows, /\*S-1-5-18:\(OI\)\(CI\)F/);
  assert.match(windows, /Copy-Item -LiteralPath \$c\.goldenVmFile -Destination \$goldenVmFile -Force/);
  assert.match(windows, /Configure-Service \$c \$nodeId \$goldenVmFile/);
  assert.match(windows, /\$ServiceAccount="NT SERVICE\\\$Service"/);
  assert.match(windows, /sc\.exe config \$Service "obj= \$ServiceAccount"/);
  assert.match(windows, /Grant-ServiceAcl \(Join-Path \$State 'credentials'\) '\(OI\)\(CI\)M'/);
  assert.match(windows, /Grant-ServiceAcl \(Join-Path \$State 'jobs'\) '\(OI\)\(CI\)M'/);
  assert.match(windows, /Grant-ServiceAcl \(Join-Path \$State 'golden'\) '\(OI\)\(CI\)RX'/);
  assert.match(windows, /New-ScheduledTaskPrincipal -UserId \$ServiceAccount -LogonType ServiceAccount -RunLevel Limited/);
  assert.doesNotMatch(windows, /Register-ScheduledTask[^\n]+-User 'SYSTEM'/);
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
  assert.match(taskRunner, /"--no-session-persistence", "--disable-slash-commands"/);
  assert.match(taskRunner, /"--output-format", "stream-json", "--include-partial-messages"/);
  assert.match(taskRunner, /"--max-turns", "60"/);
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
  const e2eToolPath = await readFile(new URL("../services/e2e-node/src/tool-path.ts", import.meta.url), "utf8");
  assert.match(e2eToolPath, /executable\.endsWith\("\.mjs"\)/);
  assert.match(e2eToolPath, /executable: nodeExecutable/);
  const e2eIsolation = await readFile(new URL("../services/e2e-node/src/isolation.ts", import.meta.url), "utf8");
  assert.match(e2eIsolation, /DEVILUDO_E2E_IDENTITY_KEY_FILE: process\.env\.DEVILUDO_E2E_IDENTITY_KEY_FILE/);
  const builder = await readFile(new URL("../services/sandbox-executor/godot-build.mjs", import.meta.url), "utf8");
  assert.match(builder, /writeFile\([\s\S]*export_presets\.cfg[\s\S]*controlledExportPresets/);
  assert.match(builder, /codesign\/codesign=0/);
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
  assert.match(manifest, /guestReportProtocol: "deviludo\.godot-guest-report\.v1"/);
});

test("CI uses the fixed no-provider Agent while local macOS keeps native E2E", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const localUp = await readFile(new URL("../scripts/local-up.mjs", import.meta.url), "utf8");
  const smoke = await readFile(new URL("../scripts/local-executor-smoke.mjs", import.meta.url), "utf8");
  assert.match(workflow, /DEVILUDO_LOCAL_CI: "1"/);
  assert.match(workflow, /DEVILUDO_SKIP_NATIVE_E2E: "1"/);
  assert.match(localUp, /if \(!ciMode\) await requireGodot\(\)/);
  assert.match(smoke, /deviludo-agent-fixture:local/);
  assert.match(smoke, /skipNativeE2e \? null : await runNativeMacE2e/);
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

test("E2E signing failures and isolation cleanup remove transient workspaces", async () => {
  const executor = await readFile(new URL("../deploy/assets/e2e-job-executor.mjs", import.meta.url), "utf8");
  const windows = await readFile(new URL("../deploy/assets/e2e-windows-isolation.ps1", import.meta.url), "utf8");
  assert.match(executor, /if \(!signedOutputReady\) await rm\(workspace/);
  assert.match(windows, /Filter "deviludo-\$JobId-\*"[\s\S]*Remove-Item -Recurse -Force/);
});

test("the shared product shell is mounted once in the root layout so route changes preserve its session", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  assert.match(layout, /<LanguageProvider[\s\S]*<ProductShell>\{children\}<\/ProductShell>[\s\S]*<\/LanguageProvider>/);
  assert.match(page, /<AgentSettings \/>/);
  assert.doesNotMatch(page, /ProductShell/);
});

test("product pages share session data and never poll an idle project", async () => {
  const shell = await readFile(new URL("../components/ProductShell.tsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../components/ProductDashboard.tsx", import.meta.url), "utf8");
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const access = await readFile(new URL("../components/AccessSettings.tsx", import.meta.url), "utf8");
  assert.match(shell, /fetch\("\/api\/session"/);
  for (const source of [dashboard,studio,access]) assert.doesNotMatch(source,/fetch\("\/api\/session"/);
  assert.doesNotMatch(studio,/setInterval|1500/);
  assert.match(studio,/workflowNeedsPolling\(workflowState\)/);
  assert.match(studio,/repositoryNeedsPolling\(repositorySyncState\)/);
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

test("model mode uses adjacent directional controls instead of text tabs", async () => {
  const component = await readFile(new URL("../components/AgentSettings.tsx", import.meta.url), "utf8");
  assert.match(component, /className="agent-model-input-row"/);
  assert.match(component, /direction="left" disabled=\{loading \|\| saving\} expanded=\{false\}/);
  assert.match(component, /direction="down" disabled=\{loading \|\| saving\} expanded/);
  assert.match(component, /<span aria-hidden="true">&lt;<\/span>/);
  assert.doesNotMatch(component, /&lt;&lt;/);
  assert.doesNotMatch(component, /className="model-mode-switch"/);
  assert.doesNotMatch(component, />单一<\/button>|>展开<\/button>/);
});

test("connection variables do not render helper copy below their inputs", async () => {
  const component = await readFile(new URL("../components/AgentSettings.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(component, /生产环境必须使用 HTTPS/);
  assert.doesNotMatch(component, /同时用于主模型/);
  assert.doesNotMatch(component, /支持 Base URL、AUTH TOKEN/);
  assert.doesNotMatch(component, /<small>\{variable\}<\/small>/);
});

test("Core product surfaces use their asserted workspace without an account selector", async () => {
  const shell = await readFile(new URL("../components/ProductShell.tsx", import.meta.url), "utf8");
  const home = await readFile(new URL("../components/HomeChat.tsx", import.meta.url), "utf8");
  const projects = await readFile(new URL("../components/ProductDashboard.tsx", import.meta.url), "utf8");
  assert.match(shell, /const workspace = session\.selectedWorkspace/);
  assert.match(shell, /session\.authMode === "STANDALONE"/);
  assert.doesNotMatch(shell, /Select workspace|Add workspace|No workspace selected/);
  assert.doesNotMatch(shell, /displayName|WorkspaceAdmin|SANDBOX LOCKED|PRODUCTION SLOT/);
  assert.doesNotMatch(home, /选择一个项目继续修改|从需求和细节开始沟通/);
  assert.doesNotMatch(projects, /这里只展示当前账号|PostgreSQL 工作区|CORE 工作流已绑定|隔离命名空间/);
});

test("asset generation is an asynchronous panel rather than a delivery stage", async () => {
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../components/AssetManifestPanel.tsx", import.meta.url), "utf8");
  // The serial pipeline must not contain an asset stage: it produces no job, so
  // the chain would stall waiting for one.
  const pipeline = studio.match(/const PIPELINE = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  assert.doesNotMatch(pipeline, /ASSET/);
  assert.deepEqual([...pipeline.matchAll(/\["([A-Z0-9_]+)"/g)].map(match => match[1]), [
    "AGENT_GENERATION", "ARTIFACT_BUILD", "E2E_TEST",
    "ARTIFACT_SIGN", "STEAM_PUBLISH", "STEAM_CLEAN_INSTALL",
  ]);
  assert.match(studio, /<AssetManifestPanel onRerunStarted=\{\(\) => void loadProject\(true\)\} projectId=\{projectId\} \/>/);
  // Uploaded assets only reach the game through a build, so the panel's rebuild
  // is an ARTIFACT_BUILD rerun rather than a bespoke endpoint.
  assert.match(panel, /\/api\/projects\/\$\{projectId\}\/rerun-stage/);
  assert.match(panel, /stage: "ARTIFACT_BUILD"/);
  assert.doesNotMatch(panel, /rebuild-with-assets/);
  // The panel goes through the authenticated Core proxy, never straight to S3 or
  // the database, and the key is only ever shown masked.
  assert.doesNotMatch(panel, /FormData|s3|S3Client|aws-sdk/);
  assert.match(panel, /generationConfig\.apiKeyMask/);
  assert.doesNotMatch(panel, /generationConfig\.apiKey\b/);
  assert.match(panel, /accept="image\/png,image\/jpeg,image\/webp"/);
});

test("image assets gate the first build and Steam upload waits for an administrator", async () => {
  const sql = await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8");
  const api = await readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8");
  const repository = await readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8");
  const daemon = await readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8");
  const runner = await readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8");
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const scheduler = await readFile(new URL("../services/core/src/scheduler.ts", import.meta.url), "utf8");
  assert.match(sql, /state = 'ASSET_GENERATING'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION deviludo\.advance_asset_workflows/);
  assert.match(sql, /item\.status NOT IN \('generated', 'uploaded'\)/);
  assert.match(scheduler, /advanceReadyWorkflows\(\)/);
  assert.match(sql, /snapshot_artifact_build_assets/);
  assert.match(repository, /kind: "ASSET", assetKey, bucket, key,[\s\S]*sha256: sha256 as ObjectReference/);
  assert.match(daemon, /Build asset inputs do not satisfy the fixed materialization contract/);
  assert.match(runner, /materializeBuildAssets\(plan\)/);
  assert.match(runner, /res:\/\/assets\/generated\/\$\{asset\.assetKey\}\.\$\{extension\}/);
  assert.match(sql, /SET state = 'RELEASE_APPROVAL_PENDING'/);
  assert.match(api, /"\/v1\/projects\/:projectId\/approve-release"/);
  assert.match(api, /principal\.role !== "OWNER" && principal\.role !== "ADMIN"/);
  assert.match(api, /kind: "RELEASE_APPROVED"/);
  assert.match(studio, /mutate\("approve-release"\)/);
  assert.match(studio, /APPROVE STEAM UPLOAD/);
});

test("auto-generate never removes the user's own way to supply an asset", async () => {
  const panel = await readFile(new URL("../components/AssetManifestPanel.tsx", import.meta.url), "utf8");
  // Hiding upload while auto-generate was on was a trap: an asset whose prompt the
  // provider kept rejecting had no way forward, and a user holding the art had to
  // turn a setting off to use it. Only an in-flight generation hides it, because
  // that write would race the generator.
  assert.match(panel, /\{item\.status !== "generating" && \(/);
  assert.doesNotMatch(panel, /item\.status === "planned" && !autoGenerateEnabled/);
  // A disabled toggle with no explanation reads as a bug, so each blocking
  // condition names itself.
  assert.match(panel, /disabled=\{!autoGenerateEnabled && \(!configComplete \|\| !providerSupported\)\}/);
  assert.match(panel, /需要先在.*设置.*里配置图片生成模型和 API Key/);
  assert.match(panel, /providerSupported = generationConfig\?\.provider !== "midjourney"/);
  // An endpoint cannot authenticate a request, so endpoint-only is not configured.
  assert.match(panel, /configComplete = Boolean\(generationConfig\?\.provider && generationConfig\.apiKeyMask\)/);
  assert.doesNotMatch(panel, /generationConfig\.apiKeyMask \|\| generationConfig\.apiEndpoint/);
  // Generation settles in the background with nothing to push the result, so the
  // panel polls while work is outstanding and stops when it is not.
  assert.match(panel, /const generationOutstanding = autoGenerateEnabled/);
  assert.match(panel, /if \(!generationOutstanding\) return;/);
  // A red failure count with no next step is a dead end; say what to do.
  assert.match(panel, /可以直接在下方上传自备素材，或重跑 Agent 生成以重新规划提示词/);
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
  assert.match(generation, /Resolve the credential once per batch/);
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
  assert.match(sandbox, /projectSources\.readRevisionFile\(relativePath, "agent\.json"/);
  assert.match(sandbox, /\.\.\.\(agentCompletion \?\? \{\}\)/);
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
  assert.match(studio, /<ol className="product-delivery-track">\s*\{PIPELINE\.map\(/);
  assert.doesNotMatch(studio, /visibleStages/);
  assert.match(studio, /const inProfile = profileStages\.has\(kind\);/);
  assert.match(studio, /view = inProfile \? pipelineStageView\(state, text\) : OUT_OF_PROFILE_STAGE_VIEW\(text\)/);
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
  assert.match(studio, /mutate\("rerun-stage", \{ stage: kind \}\)/);
  assert.match(studio, /mutate\("rerun-stage", \{ stage: rerunnableFailedStage \}\)/);
  // A rerun supersedes downstream jobs, so it stays closed while executors may
  // still hold leases.
  assert.match(studio, /RERUNNABLE_WORKFLOW_STATES = new Set\(\["FAILED", "SUCCEEDED", "CANCELLED"\]\)/);
  assert.match(studio, /RERUNNABLE_WORKFLOW_STATES\.has\(project\.workflowState\)\s*&&\s*project\.jobs\.length > 0/);
  // VALIDATE has no signing or publication stages to offer, so their rerun is
  // withheld — but the node itself still renders, see the visibility test below.
  assert.match(studio, /canRerunStages && inProfile \?/);
  assert.match(studio, /"idempotency-key": `stage-rerun:\$\{String\(body\?\.stage\)\}:\$\{crypto\.randomUUID\(\)\}`/);
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
  assert.ok(studio.indexOf('aria-label={text("交付流程", "Delivery pipeline")}') < studio.indexOf("project-workspace-layout"));
  assert.match(studio, /label: text\("已完成", "COMPLETED"\)[\s\S]*label: text\("进行中", "IN PROGRESS"\)[\s\S]*label: text\("未开始", "NOT STARTED"\)/);
  assert.match(styles, /\.product-delivery-track\s*\{[\s\S]*display:\s*flex/);
  assert.match(styles, /\.product-delivery-stage\.status-completed/);
  assert.match(styles, /\.product-delivery-stage\.status-active/);
  assert.match(styles, /\.product-delivery-stage\.status-pending/);
});

test("the async asset branch is anchored to its stage, not placed by a guessed offset", async () => {
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/product.css", import.meta.url), "utf8");
  // The branch used to be a sibling of the track positioned at `calc(8.333% + 18px)`
  // — one twelfth of the canvas, chosen to look like the first of six stages. That
  // is wrong the moment anything changes: the fraction is of the padded canvas, the
  // track carries a min-width so it stops tracking the percentage once the panel
  // scrolls, and adding or reordering a stage silently moves the anchor. It now
  // renders inside the AGENT_GENERATION cell, which is also the stage that actually
  // plans the manifest.
  assert.match(studio, /kind === "AGENT_GENERATION" \? \(\s*<div className="product-delivery-async-branch">/);
  assert.doesNotMatch(styles, /8\.333%/);
  const branch = styles.match(/^\.product-delivery-async-branch \{([\s\S]*?)\n\}/m)?.[1] ?? "";
  assert.match(branch, /top: 100%/);
  assert.match(branch, /left: 50%/);
  assert.match(branch, /transform: translateX\(-50%\)/);
  // Capped by the stage's own width, so the branch cannot spill under a neighbour
  // however narrow the track gets.
  assert.match(branch, /width: min\(190px, 100%\)/);
  // Absolute positioning contributes no height, so the track has to reserve the
  // room or the branch overlaps whatever follows the pipeline.
  assert.match(styles, /^\.product-delivery-track \{[\s\S]*?margin: 0 0 88px;/m);
  // The branch inherits --stage-line from the stage, so it is themed by the same
  // status that colours the node it hangs from instead of a hardcoded grey.
  assert.match(styles, /\.product-delivery-branch-line \{[\s\S]*?border-left: 2px dashed var\(--stage-line\)/);
  assert.match(styles, /\.product-delivery-async-node \{[\s\S]*?border: 2px solid var\(--stage-line\)/);
  // A disclosure needs a disclosure glyph: the cycle icon means "run again" and is
  // already the rerun affordance on every stage in this same track.
  assert.match(studio, /<ArrowIcon aria-hidden="true" className="product-delivery-async-chevron"/);
  assert.match(styles, /\.product-delivery-async-node\.is-expanded \.product-delivery-async-chevron \{[\s\S]*?transform: rotate\(-90deg\)/);
  // aria-expanded is the state a screen reader announces, and the visible label has
  // to agree with it rather than always inviting the user to open.
  assert.match(studio, /aria-expanded=\{assetPanelExpanded\}/);
  assert.match(studio, /assetPanelExpanded\s*\?\s*text\("收起素材清单", "Hide asset list"\)/);
  assert.match(styles, /\.product-delivery-async-node:focus-visible \{[\s\S]*?outline: 2px solid var\(--blue\)/);
});

test("the baseline repair replays functions from the baseline rather than copying them", async () => {
  const repair = await readFile(new URL("../scripts/repair-local-baseline.mjs", import.meta.url), "utf8");
  const ddl = await readFile(
    new URL("../infra/postgres/repair/001_asset_baseline_catchup.sql", import.meta.url),
    "utf8",
  );
  // Duplicating the function bodies into the repair file is what would let the two
  // drift apart, recreating the problem the repair exists to fix. They are read out
  // of the baseline instead, and the count is checked against the file so a body the
  // scanner cannot parse fails loudly rather than being skipped.
  assert.doesNotMatch(ddl, /CREATE OR REPLACE FUNCTION/);
  assert.match(repair, /extractFunctions\(baseline\)/);
  assert.match(repair, /functions\.length !== declared/);
  // A SECURITY DEFINER function replaced without its owner would run as whoever ran
  // the repair, silently widening what the sweep can reach.
  assert.match(repair, /ALTER FUNCTION deviludo[\\.]+\$\{match\[1\]\}/);
  assert.match(repair, /OWNER TO \[a-z_\]\+/);
  // The repair rewrites function bodies in place, which is a local recovery step;
  // shared databases get the reviewed baseline.
  assert.match(repair, /NODE_ENV === "production"/);
  assert.match(repair, /Refusing to repair a production database/);
  // The digest is the claim that the repair completed, so it has to be written last.
  assert.ok(
    repair.indexOf("SET source_digest = $1") > repair.indexOf("applied.functions.push"),
    "the source digest must be stamped only after the functions are replaced",
  );
  // Re-running it must be safe: this is aimed at databases that already hold the
  // user's projects, so the DDL adds what is missing and never recreates a table.
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS deviludo\.asset_manifests/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS deviludo\.asset_items/);
  assert.doesNotMatch(ddl, /DROP TABLE|TRUNCATE|DELETE FROM/);
  // The asset tables carry workspace data, so isolation has to arrive with them.
  assert.match(ddl, /ENABLE ROW LEVEL SECURITY/);
  assert.match(ddl, /FORCE ROW LEVEL SECURITY/);
  assert.match(ddl, /workspace_id = deviludo\.current_workspace_id\(\)/);
  assert.match(ddl, /GRANT SELECT, UPDATE ON deviludo\.asset_items TO deviludo_claim_executor/);
});
