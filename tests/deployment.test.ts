import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Claude and Codex images contain persistent Runtime, signed Skills and built-in MCP", async () => {
  for (const file of ["Dockerfile.agent-claude", "Dockerfile.agent-codex"]) {
    const dockerfile = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(dockerfile, /services\/project-runtime\/runtime\.mjs/);
    assert.match(dockerfile, /services\/project-runtime\/turn\.mjs/);
    assert.match(dockerfile, /services\/project-runtime\/mcp-server\.mjs/);
    assert.match(dockerfile, /services\/project-runtime\/skills \/opt\/deviludo\/skills/);
    assert.match(dockerfile, /sha256sum > \/opt\/deviludo\/skills\.sha256/);
    assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/deviludo-project-runtime"\]/);
    assert.doesNotMatch(dockerfile, /task-runner|docker\.sock|\/dev\/kvm/);
  }
});

test("project Runtime container has source access but no Docker or hypervisor authority", async () => {
  const supervisor = await readFile(
    new URL("../services/sandbox-executor/src/project-runtime-supervisor.ts", import.meta.url),
    "utf8",
  );
  assert.match(supervisor, /--read-only/);
  assert.match(supervisor, /--user=10001:1001/);
  assert.match(supervisor, /--group-add=1001/);
  assert.match(supervisor, /deviludo\.projects-volume/);
  assert.match(supervisor, /deviludo\.kind=project-runtime-state/);
  assert.match(supervisor, /deviludo-runtime-volume-init/);
  assert.match(await readFile(new URL("../services/project-runtime/runtime.mjs", import.meta.url), "utf8"), /setInterval\(\(\) => \{\}, 60_000\)/);
  assert.match(supervisor, /--cap-drop=ALL/);
  assert.match(supervisor, /--security-opt=no-new-privileges/);
  assert.match(supervisor, /volume-subpath=/);
  assert.match(supervisor, /dst=\/var\/lib\/deviludo-runtime/);
  assert.match(supervisor, /--tmpfs=\/run\/deviludo:rw,noexec,nosuid,nodev/);
  assert.doesNotMatch(supervisor, /docker\.sock|\/dev\/kvm|Hyper-V|libvirt/);
});

test("credentials and MCP token are turn-scoped files and are erased after execution", async () => {
  const [supervisor, turn, io] = await Promise.all([
    readFile(new URL("../services/sandbox-executor/src/project-runtime-supervisor.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/project-runtime/turn.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/project-runtime/io.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(supervisor, /inject\(name, request\.turnId, "provider"/);
  assert.match(supervisor, /inject\(name, request\.turnId, "mcp"/);
  assert.match(supervisor, /inject\(name, request\.turnId, "models"/);
  assert.match(supervisor, /rm", "-rf", `\/run\/deviludo\/\$\{request\.turnId\}`/);
  assert.match(io, /`\/run\/deviludo\/\$\{turnId\}`/);
  assert.match(io, /target === "models"/);
  assert.match(turn, /await readFile\(credentialFile/);
  assert.match(turn, /rm\(credentialFile, \{ force: true \}\)/);
  assert.match(turn, /codexAuthFile[\s\S]*rm\(codexAuthFile, \{ force: true \}\)/);
  assert.match(turn, /ephemeralCodexHome = `\/run\/deviludo\/\$\{request\.turnId\}\/codex-home`/);
  assert.match(turn, /model_catalog_json=\$\{modelCatalog\}/);
  assert.match(turn, /supports_parallel_tool_calls: model\.supports_parallel_tool_calls \?\? false/);
  assert.doesNotMatch(turn, /codexAuthFile = `\$\{stateRoot\}/);
});

test("executor startup preserves current project containers and removes only disposable task containers", async () => {
  const daemon = await readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8");
  assert.match(daemon, /ProjectRuntimeSupervisor/);
  assert.match(daemon, /\/v2\/runtime\/ensure/);
  assert.match(daemon, /\/v2\/runtime\/pause/);
  assert.match(daemon, /\/v2\/runtime\/resume/);
  assert.match(daemon, /\/v2\/runtime\/cancel/);
  assert.match(daemon, /\/v2\/runtime\/destroy/);
  assert.match(daemon, /label=deviludo\.kind=task/);
  assert.doesNotMatch(daemon, /label=deviludo\.kind=project-runtime[^\n]*rm/);
});

test("compose grants Docker authority only to executord and shares the durable project volume", async () => {
  const compose = await readFile(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  const socketMounts = compose.match(/^\s*- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock$/gm) ?? [];
  assert.equal(socketMounts.length, 1);
  assert.match(compose, /DEVILUDO_PROJECTS_VOLUME/);
  assert.match(compose, /DEVILUDO_PROJECT_RUNTIME_MCP_GATEWAY: http:\/\/core-api:8080/);
  assert.match(compose, /DEVILUDO_CODEX_MODELS_CACHE_FILE: \/run\/deviludo-codex\/models_cache\.json/);
  assert.match(compose, /projects-data:\s*\n\s*name:/);
  assert.doesNotMatch(compose, /DEVILUDO_PROJECT_DOCUMENT_IDLE_SECONDS/);
});

test("platform E2E hosts run deterministic native drivers without Provider credentials or Agent Runtime", async () => {
  for (const file of [
    "deploy/e2e-linux/deploy.sh",
    "deploy/e2e-macos/deploy.sh",
    "deploy/e2e-windows/deploy.ps1",
  ]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|claude-code|@openai\/codex/);
  }
  const node = await readFile(new URL("../services/e2e-node/src/executor.ts", import.meta.url), "utf8");
  assert.match(node, /E2E_PLATFORM_RUN/);
  assert.doesNotMatch(node, /ProjectRuntimeService|AgentRuntimeKind/);
});

test("disposable Core task image handles only Builder and Steam publisher", async () => {
  const [runner, fixture, sandbox] = await Promise.all([
    readFile(new URL("../services/sandbox-executor/task-runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/sandbox-executor/task-fixture-agent.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/sandbox.ts", import.meta.url), "utf8"),
  ]);
  assert.match(runner, /jobKind === "BUILD"/);
  assert.match(runner, /jobKind === "STEAM_PUBLISH"/);
  assert.match(runner, /await import\("\/usr\/local\/lib\/deviludo\/e2e-evidence\.mjs"\)/);
  assert.doesNotMatch(runner, /AGENT_TURN/);
  assert.doesNotMatch(fixture, /AGENT_TURN/);
  assert.match(sandbox, /AGENT_TURN jobs must use the persistent Project Runtime/);
});

test("Core includes deterministic PDF text and page rendering tools", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile.core", import.meta.url), "utf8");
  assert.match(dockerfile, /apk add --no-cache[^\n]*poppler-utils/);
});

test("executor persists the canonical output MIME type in object storage", async () => {
  const daemon = await readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8");
  assert.match(daemon, /ContentType: contentType/);
  assert.match(daemon, /kind === "BUILD"[\s\S]*return "application\/gzip"/);
  assert.doesNotMatch(daemon, /metadata: Object\.freeze\(\{ contentType: typeof item\.contentType/);
});

test("CI validates code E2E and the Windows deployment scripts", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /npm run test:e2e:code/);
  assert.match(workflow, /windows-deploy-scripts:/);
  assert.match(workflow, /Invoke-Pester/);
});

test("code E2E isolates and removes project Runtime containers and session volumes before Compose networks", async () => {
  const script = await readFile(new URL("../scripts/run-e2e.mjs", import.meta.url), "utf8");
  assert.match(script, /DEVILUDO_PROJECTS_VOLUME: `\$\{projectName\}-projects-data`/);
  assert.match(script, /removeProjectRuntimeState\(environment\.DEVILUDO_PROJECTS_VOLUME, environment\)/);
  assert.match(script, /label=deviludo\.projects-volume=\$\{projectsVolume\}/);
  assert.match(script, /label=deviludo\.kind=project-runtime/);
  assert.match(script, /label=deviludo\.kind=project-runtime-state/);
  assert.ok(script.indexOf("removeProjectRuntimeState(environment.DEVILUDO_PROJECTS_VOLUME, environment)") < script.indexOf('"down", "--volumes"'));
});

test("local reset explicitly removes incompatible project Runtime containers and volumes", async () => {
  const [localUp, reset] = await Promise.all([
    readFile(new URL("../scripts/local-up.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/reset-self-hosted-baseline.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(localUp, /--reset-incompatible-baseline/);
  assert.match(localUp, /removeLocalProjectRuntimes/);
  assert.match(reset, /deviludo\.kind=project-runtime/);
  assert.match(reset, /deviludo-runtime-/);
});

test("English remains the default project-content language", async () => {
  const [context, shell] = await Promise.all([
    readFile(new URL("../services/core/src/project-context.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/product/locale.ts", import.meta.url), "utf8").catch(() => ""),
  ]);
  assert.match(context, /language: input\.language \?\? "en"/);
  if (shell) assert.match(shell, /en/);
});
