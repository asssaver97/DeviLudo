import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workflow iterations migrate existing projects into one linear immutable history", async () => {
  const [baseline, migration] = await Promise.all([
    readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8"),
    readFile(new URL("../infra/postgres/migrations/011_project_workflow_iterations.sql", import.meta.url), "utf8"),
  ]);
  assert.match(baseline, /iteration_number integer NOT NULL DEFAULT 1 CHECK \(iteration_number > 0\)/);
  assert.match(baseline, /parent_workflow_id uuid/);
  assert.match(baseline, /UNIQUE \(workspace_id, project_id, iteration_number\)/);
  assert.match(baseline, /UNIQUE \(workspace_id, parent_workflow_id\)/);
  assert.match(baseline, /FOREIGN KEY \(workspace_id, parent_workflow_id\)[\s\S]*workflow_instances\(workspace_id, id\)/);
  assert.match(migration, /row_number\(\) OVER \([\s\S]*PARTITION BY workspace_id, project_id[\s\S]*ORDER BY created_at, id/);
  assert.match(migration, /lag\(id\) OVER \([\s\S]*PARTITION BY workspace_id, project_id[\s\S]*ORDER BY created_at, id/);
  assert.match(migration, /ALTER COLUMN iteration_number SET NOT NULL/);
  assert.match(migration, /workflow_iteration_parent_unique UNIQUE \(workspace_id, parent_workflow_id\)/);
});

test("the iteration API is terminal-only, latest-only, and idempotent under duplicate creation", async () => {
  const [api, repository, contracts, openapi] = await Promise.all([
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/product/contracts.ts", import.meta.url), "utf8"),
    readFile(new URL("../openapi/deviludo.yaml", import.meta.url), "utf8"),
  ]);
  for (const route of [
    '"/v1/projects/:projectId/iterations"',
    '"/v1/projects/:projectId/iterations/:workflowId"',
  ]) assert.match(api, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(repository, /SELECT id::text FROM deviludo\.projects[\s\S]*FOR UPDATE/);
  assert.match(repository, /parent_workflow_id = \$2::uuid/);
  assert.match(repository, /current\.workflow_id !== existing\.rows\[0\]\.id[\s\S]*created: false/);
  assert.match(repository, /current\.workflow_id !== input\.baseWorkflowId/);
  assert.match(repository, /\["SUCCEEDED", "FAILED", "CANCELLED"\]\.includes\(current\.state\)/);
  assert.match(repository, /iterationNumber = current\.iteration_number \+ 1/);
  assert.doesNotMatch(
    repository,
    /FROM deviludo\.workflow_instances\s+WHERE project_id = \$1::uuid\s+ORDER BY created_at DESC/,
  );
  assert.match(repository, /analysis\.status === "READY"/);
  assert.match(repository, /baseSourceRevision: latestSource/);
  assert.match(repository, /ORDER BY source\.revision DESC/);
  assert.match(repository, /baseDocumentRevision: Number\(document/);
  assert.match(repository, /approvedDocumentRevision: null/);
  assert.match(repository, /signal\.kind === "SPEC_APPROVED"[\s\S]*approvedDocumentRevision/);
  assert.match(contracts, /iterationNumber: number/);
  assert.match(contracts, /ProductWorkflowIterationDetail/);
  assert.match(openapi, /\/v1\/projects\/\{projectId\}\/iterations:/);
  assert.match(openapi, /\/v1\/projects\/\{projectId\}\/iterations\/\{workflowId\}:/);
});

test("iteration base revisions are repaired using numeric source order at creation time", async () => {
  const migration = await readFile(
    new URL("../infra/postgres/migrations/022_correct_iteration_base_source_revision.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /max\(source\.revision\)/);
  assert.match(migration, /source\.created_at <= child\.created_at/);
  assert.match(migration, /\{iteration,baseSourceRevision\}/);
  assert.match(migration, /event\.event_kind = 'ITERATION_STARTED'/);
});

test("the project page separates continuing requirements from rerunning a completed stage", async () => {
  const [studio, dashboard] = await Promise.all([
    readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ProductDashboard.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(studio, /body: JSON\.stringify\(\{ baseWorkflowId: project\.workflowId \}\)/);
  assert.match(studio, /text\("继续修改", "CONTINUE EDITING"\)/);
  assert.match(studio, /text\("调整需求并重新开发", "REVISE & DEVELOP AGAIN"\)/);
  assert.match(studio, /mutate\("rerun-stage", \{ stage: kind \}\)/);
  assert.match(studio, /viewingHistoricalIteration[\s\S]*text\("历史只读", "READ ONLY"\)/);
  assert.match(studio, /disabled=\{viewingHistoricalIteration\}/);
  assert.match(studio, /assetPanelExpanded && !viewingHistoricalIteration/);
  assert.match(studio, /historicalIteration\.events/);
  assert.match(dashboard, /project\.iterationNumber/);
});

test("current artifact queries no longer mix evidence from older iterations", async () => {
  const [api, repository] = await Promise.all([
    readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/core/src/repository.ts", import.meta.url), "utf8"),
  ]);
  assert.match(api, /listProjectArtifacts\(workspace\.id, project\.id, project\.workflowId\)/);
  assert.match(repository, /AND \(\$2::uuid IS NULL OR artifact\.workflow_id = \$2::uuid\)/);
  assert.equal((repository.match(/DISTINCT ON \(artifact\.kind, artifact\.target_platform\)/g) ?? []).length, 2);
  assert.match(repository, /WHERE artifact\.project_id = \$1::uuid AND artifact\.workflow_id = \$2::uuid[\s\S]*artifact\.created_at DESC/);
});

test("the artifact panel keeps only the newest item for each kind and platform", async () => {
  const studio = await readFile(new URL("../components/ProjectStudio.tsx", import.meta.url), "utf8");
  assert.match(studio, /latestArtifactsByKindAndPlatform\([\s\S]*historicalIteration\.artifacts : artifacts/);
  assert.match(studio, /const key = `\$\{artifact\.kind\}:\$\{artifact\.targetPlatform \?\? "common"\}`/);
  assert.match(studio, /artifact\.createdAt > current\.createdAt/);
  assert.match(studio, /groupArtifactsByPipelineStage\(viewedArtifacts\)/);
  assert.match(studio, /artifactPipelineStage\(artifact\.kind\)/);
  assert.doesNotMatch(studio, /className="product-artifacts-panel"/);
});
