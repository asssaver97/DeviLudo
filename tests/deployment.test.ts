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
  const webSection = compose.match(/\n  web:([\s\S]*?)\nnetworks:/)?.[1] ?? "";
  assert.doesNotMatch(webSection, /DATABASE_URL|VAULT|OBJECT_STORE|S3_/);
  assert.match(webSection, /- edge[\s\S]*- core/);
  assert.doesNotMatch(webSection, /- data/);
  const localMac = await readFile(new URL("../scripts/local-macos-e2e.mjs", import.meta.url), "utf8");
  assert.match(localMac, /const \{ main \} = await import\("\.\.\/services\/e2e-node\/src\/main\.ts"\);/);
  assert.match(localMac, /await main\(\);/);
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
  assert.match(component, /placeholder=\{settings\.apiKeyMasked \?\? "输入 API Key"\}/);
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

test("product surfaces omit technical helper copy and start without a workspace selection", async () => {
  const shell = await readFile(new URL("../components/ProductShell.tsx", import.meta.url), "utf8");
  const home = await readFile(new URL("../components/HomeChat.tsx", import.meta.url), "utf8");
  const projects = await readFile(new URL("../components/ProductDashboard.tsx", import.meta.url), "utf8");
  assert.match(shell, /aria-label="选择工作区"/);
  assert.match(shell, /className="workspace-add-option"[\s\S]*<PlusIcon \/>[\s\S]*添加工作区/);
  assert.match(shell, /未选择工作区[\s\S]*选择或新建工作区/);
  assert.doesNotMatch(shell, /displayName|WorkspaceAdmin|SANDBOX LOCKED|PRODUCTION SLOT/);
  assert.doesNotMatch(home, /选择一个项目继续修改|从需求和细节开始沟通/);
  assert.doesNotMatch(projects, /这里只展示当前账号|PostgreSQL 工作区|CORE 工作流已绑定|隔离命名空间/);
});
