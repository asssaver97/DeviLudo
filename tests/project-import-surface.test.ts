import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project linking is reachable from Home and separates local and GitHub sources", async () => {
  const [home, dashboard, studio, bridge, proxy, core, repository, projectImport, configuration, analysisMigration] = await Promise.all([
    readFile(new URL("../components/HomeChat.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ProductDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-git-import-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/[...segments]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/project-import.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/local-git-import/config/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../infra/postgres/migrations/010_async_project_import_analysis.sql", import.meta.url), "utf8"),
  ]);
  assert.match(home, /<option value=\{IMPORT_PROJECT_VALUE\}>\{text\("导入已有项目…"/);
  assert.match(home, /router\.push\("\/projects\/import"\)/);
  assert.doesNotMatch(dashboard, /className="creation-mode-switch"/);
  assert.match(dashboard, /className="import-source-switch"/);
  assert.match(dashboard, /text\("本地项目", "LOCAL PROJECT"\)/);
  assert.match(dashboard, /role="tab"[^>]*>GITHUB<\/button>/);
  assert.doesNotMatch(dashboard, /项目 ZIP|Choose ZIP|type="file"/);
  assert.match(dashboard, /fetch\(`\$\{bridgeUrl\}\/directory\/select`/);
  assert.match(dashboard, /preloadLocalProjectBridgeUrl\(\)/);
  assert.doesNotMatch(dashboard, /directory\/select`[\s\S]{0,160}content-type/);
  assert.match(dashboard, /fetch\(`\$\{bridgeUrl\}\/github\/clone`/);
  assert.doesNotMatch(dashboard, /application\/zip|arrayBuffer\(\)/);
  assert.doesNotMatch(dashboard, /新分支|New branch|branchName:/);
  assert.match(studio, /text\("新建 Git 分支", "New Git branch"\)/);
  assert.match(studio, /fetch\(`\$\{bridgeUrl\}\/directory\/git\/branch`/);
  assert.match(bridge, /"\/directory\/git\/status"/);
  assert.match(bridge, /"\/directory\/git\/branch"/);
  assert.match(bridge, /"switch", "-c", branchName/);
  assert.match(dashboard, /"\/api\/projects\/bind\/local-directory"/);
  assert.match(dashboard, /"\/api\/projects\/bind\/github"/);
  assert.doesNotMatch(proxy, /projects\/import\/local-directory|projects\/import\/github/);
  assert.match(core, /"\/v1\/projects\/bind\/github"/);
  assert.match(core, /"\/v1\/projects\/bind\/local-directory"/);
  assert.match(core, /readBoundProjectSource/);
  assert.match(core, /queueBoundProjectImport/);
  assert.match(core, /runProjectImportAnalysisWorker/);
  assert.match(core, /"\/v1\/projects\/:projectId\/analysis\/retry"/);
  assert.match(dashboard, /router\.push\("\/projects"\)/);
  assert.match(dashboard, /className="project-analysis-spinner"/);
  assert.match(dashboard, /project\.analysisStatus === "PENDING"/);
  assert.match(dashboard, /project\.analysisStatus === "NEEDS_INPUT"/);
  assert.match(studio, /text\("已有项目分析", "PROJECT ANALYSIS"\)/);
  assert.match(studio, /analysisStatus === "NEEDS_INPUT"/);
  assert.match(projectImport, /completedWork.*remainingWork.*startupFlow.*startupIssues.*recommendedPlan.*questions/s);
  assert.match(projectImport, /enters an in-progress match, late-game state, test\/debug state/);
  assert.match(repository, /status: input\.discovery\.questions\.length \? "NEEDS_INPUT" : "READY"/);
  assert.match(repository, /state_data #>> '\{importAnalysis,status\}' = 'NEEDS_INPUT'/);
  assert.match(core, /pending\?\.state === "WAITING_FOR_ANALYSIS"[\s\S]*applyConfirmedConversationChange/);
  assert.match(analysisMigration, /SECURITY DEFINER[\s\S]*SET row_security = off/);
  assert.match(analysisMigration, /FOR UPDATE OF workflow SKIP LOCKED/);
  assert.match(analysisMigration, /GRANT EXECUTE ON FUNCTION deviludo\.claim_project_import_analysis\(integer\) TO deviludo_api/);
  assert.match(projectImport, /PROJECT_ANALYSIS_TIMEOUT_MS = 10 \* 60 \* 1_000/);
  assert.match(proxy, /PROJECT_BIND_TIMEOUT_MS = 12 \* 60 \* 1_000/);
  assert.match(proxy, /CONVERSATION_STREAM_TIMEOUT_MS = 12 \* 60 \* 1_000/);
  assert.match(proxy, /routePath === "conversations\/messages\/stream"[\s\S]*CONVERSATION_STREAM_TIMEOUT_MS/);
  assert.match(proxy, /PROJECT_DELETE_TIMEOUT_MS = 10 \* 60 \* 1_000/);
  assert.match(configuration, /\["127\.0\.0\.1", "localhost"\]/);
});

test("project deletion only removes a local directory through its server-owned binding", async () => {
  const [studio, core, repository, bridge, bridgeProxy] = await Promise.all([
    readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-git-import-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-project-bridge-proxy.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(studio, /type="checkbox"[\s\S]*deleteLocalDirectory/);
  assert.match(studio, /disabled=\{deleting\}[\s\S]*project-delete-checkbox-indicator/);
  assert.doesNotMatch(studio, /disabled=\{deleting \|\| !project\.localDirectory\}/);
  assert.match(studio, /JSON\.stringify\(\{ deleteLocalDirectory \}\)/);
  assert.match(studio, /setDeleteError\([\s\S]*role="alert"/);
  assert.doesNotMatch(studio, /catch \(reason\) \{[\s\S]{0,240}setConfirmingDelete\(false\)/);
  assert.match(core, /project\.localDirectory\?\.bindingId/);
  assert.match(core, /\/internal\/directory\/delete/);
  assert.doesNotMatch(core, /deleteBoundProjectDirectory\(config,\s*body\./);
  assert.doesNotMatch(core, /LOCAL_DIRECTORY_NOT_BOUND/);
  const steamReleaseDelete = repository.indexOf("DELETE FROM deviludo.${table}");
  const workflowDelete = repository.indexOf("DELETE FROM deviludo.workflow_instances", steamReleaseDelete);
  assert.ok(steamReleaseDelete > 0 && workflowDelete > steamReleaseDelete);
  assert.match(repository, /\["steam_releases", "asset_manifests"\]/);
  assert.ok(repository.indexOf("await beforeDelete?.()") > repository.indexOf("DELETE FROM deviludo.projects"));
  assert.match(bridge, /const binding = await requireBinding\(value\)/);
  assert.match(bridge, /await rename\(binding\.path, quarantine\)/);
  assert.match(bridge, /await rm\(quarantine, \{ force: false, maxRetries: 3, recursive: true/);
  assert.match(bridge, /delete remaining\[binding\.id\]/);
  assert.match(bridgeProxy, /"\/internal\/directory\/delete"/);
});

test("project Git controls share one compact row and destructive actions stay in the upper-right header", async () => {
  const [studio, styles] = await Promise.all([
    readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/product.css", import.meta.url), "utf8"),
  ]);
  assert.match(studio, /className="local-git-branch-toolbar"[\s\S]*className="local-git-branch-status"[\s\S]*!editingLocalBranch[\s\S]*className="local-git-branch-form"/);
  assert.match(styles, /\.local-git-branch-toolbar \{[\s\S]*justify-content: space-between/);
  assert.match(studio, /className="product-studio-header-actions"[\s\S]*className="button project-delete-button"/);
  assert.match(styles, /\.product-studio-header-actions \{[\s\S]*position: absolute;[\s\S]*right: 0;[\s\S]*top: 0;/);
});

test("group-chat activity counts user prompts and labels automatic import analysis separately", async () => {
  const [studio, repository, contracts] = await Promise.all([
    readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/product/contracts.ts", import.meta.url), "utf8"),
  ]);
  assert.match(repository, /count\(message\.message_id\) FILTER \(WHERE message\.role = 'USER'\)::text AS user_message_count/);
  assert.match(repository, /message\.metadata ->> 'source' = 'PROJECT_IMPORT_AGENT'/);
  assert.match(studio, /conversationActivityLabel\(item\.userMessageCount, item\.systemGenerated, text\)/);
  assert.match(studio, /text\("系统分析", "SYSTEM ANALYSIS"\)/);
  assert.match(studio, /text\(`\$\{count\} 次用户发言`/);
  assert.doesNotMatch(studio, /Math\.ceil\(messageCount \/ 2\)/);
  assert.match(contracts, /userMessageCount: number;[\s\S]*systemGenerated: boolean;/);
});
