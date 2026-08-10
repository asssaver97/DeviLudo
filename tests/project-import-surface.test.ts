import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project linking is reachable from Home and separates local and GitHub sources", async () => {
  const [home, dashboard, studio, bridge, proxy, core, projectImport, configuration, analysisMigration] = await Promise.all([
    readFile(new URL("../components/HomeChat.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ProductDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-git-import-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/[...segments]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/project-import.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/local-git-import/config/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../infra/postgres/migrations/010_async_project_import_analysis.sql", import.meta.url), "utf8"),
  ]);
  assert.match(home, /<option value=\{IMPORT_PROJECT_VALUE\}>\{text\("关联已有项目…"/);
  assert.match(home, /router\.push\("\/projects\/import"\)/);
  assert.doesNotMatch(dashboard, /className="creation-mode-switch"/);
  assert.match(dashboard, /className="import-source-switch"/);
  assert.match(dashboard, /text\("本地项目", "LOCAL PROJECT"\)/);
  assert.match(dashboard, /role="tab"[^>]*>GITHUB<\/button>/);
  assert.doesNotMatch(dashboard, /项目 ZIP|Choose ZIP|type="file"/);
  assert.match(dashboard, /fetch\(`\$\{bridgeUrl\}\/directory\/select`/);
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
  assert.match(analysisMigration, /SECURITY DEFINER[\s\S]*SET row_security = off/);
  assert.match(analysisMigration, /FOR UPDATE OF workflow SKIP LOCKED/);
  assert.match(analysisMigration, /GRANT EXECUTE ON FUNCTION deviludo\.claim_project_import_analysis\(integer\) TO deviludo_api/);
  assert.match(projectImport, /PROJECT_ANALYSIS_TIMEOUT_MS = 10 \* 60 \* 1_000/);
  assert.match(proxy, /PROJECT_BIND_TIMEOUT_MS = 12 \* 60 \* 1_000/);
  assert.match(configuration, /\["127\.0\.0\.1", "localhost"\]/);
});
