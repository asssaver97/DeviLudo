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
  assert.match(vaultInit, /chown 1001:1001 \/tokens\/api\.token/);
  assert.match(vaultInit, /chmod 0400 \/tokens\/api\.token/);
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
  assert.match(localUp, /DEVILUDO_EXECUTOR_ALLOWED_IMAGES: \[\.\.\.new Set\(\[\.\.\.imageIds, \.\.\.retainedJobRuntimeImages\]\)\]/);
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

test("E2E signing failures and isolation cleanup remove transient workspaces", async () => {
  const executor = await readFile(new URL("../deploy/assets/e2e-job-executor.mjs", import.meta.url), "utf8");
  const windows = await readFile(new URL("../deploy/assets/e2e-windows-isolation.ps1", import.meta.url), "utf8");
  assert.match(executor, /if \(!signedOutputReady\) await rm\(workspace/);
  assert.match(windows, /Filter "deviludo-\$JobId-\*"[\s\S]*Remove-Item -Recurse -Force/);
});

test("the settings route is rendered inside the shared product shell", async () => {
  const page = await readFile(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<ProductShell>[\s\S]*<AgentSettings \/>[\s\S]*<\/ProductShell>/);
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
