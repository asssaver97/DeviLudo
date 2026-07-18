import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { sourceBaselineOperationKey, type SourceBaselineReceipt } from "../../scm-proxy/src/source-baseline-contracts";
import type { AgentConfigurationClaim } from "../src/contracts";
import { PostgresAgentConfigurationStore } from "../src/postgres-store";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const specRevisionId = "44444444-4444-4444-8444-444444444444";
const testPlanRevisionId = "55555555-5555-4555-8555-555555555555";
const baselineId = "66666666-6666-4666-8666-666666666666";
const repositoryBindingId = "77777777-7777-4777-8777-777777777777";
const runId = "88888888-8888-4888-8888-888888888888";
const claimToken = "99999999-9999-4999-8999-999999999999";
const toolchainId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const approvalId = "b".repeat(64);
const commitSha = "c".repeat(40);
const sourceDigest = "d".repeat(64);

const binding = Object.freeze({
  state: "RESOLVING_AGENT_CONFIGURATION",
  specRevisionId,
  testPlanRevisionId,
  specApprovalReceiptId: approvalId,
});

test("PostgreSQL Agent configuration claim is tenant-RLS scoped and lease fenced", async () => {
  const sql: string[] = [];
  const client = clientWith(async (statement) => {
    sql.push(statement);
    if (statement.includes("LEFT JOIN deviludo.agent_configuration_resolutions")) {
      return rows([candidate({ resolution_state: null })]);
    }
    if (statement.includes("FROM deviludo.agent_configuration_resolutions resolution")
      && statement.includes("FOR UPDATE OF resolution")) {
      return rows([candidate({ resolution_state: "PENDING" })]);
    }
    if (statement.includes("SET state = 'CLAIMED'")) return rows([{ action_id: actionId }]);
    return rows([]);
  });
  const store = new PostgresAgentConfigurationStore(pool(client));
  const claimed = await store.claimNext(tenantId);
  assert.equal(claimed?.kind, "CLAIMED");
  assert.equal(claimed?.actionId, actionId);
  assert.match(claimed?.claimToken ?? "", /^[a-f0-9-]{36}$/);
  assert.ok(sql.some((statement) => statement.includes("set_config('app.tenant_id'")));
  assert.ok(sql.some((statement) => statement.includes("FOR UPDATE OF action SKIP LOCKED")));
  assert.ok(sql.some((statement) => statement.includes("claim_expires_at = now() + interval '2 minutes'")));
});

test("PostgreSQL Agent configuration locks one coherent catalog/source/toolchain snapshot", async () => {
  const sql: string[] = [];
  let persistedLock: Record<string, unknown> | null = null;
  let persistedDigest = "";
  const client = clientWith(async (statement, values) => {
    sql.push(statement);
    if (statement.includes("CROSS JOIN deviludo.admin_catalog_state catalog")) {
      return rows([authority()]);
    }
    if (statement.includes("INSERT INTO deviludo.agent_runs")) {
      persistedLock = JSON.parse(String(values[13])) as Record<string, unknown>;
      persistedDigest = String(values[14]);
      return rows([]);
    }
    if (statement.includes("FROM deviludo.agent_runs")) {
      return rows([{ id: runId, state: "QUEUED", resolution_digest: persistedDigest, configuration_lock: persistedLock }]);
    }
    if (statement.includes("SET state = 'LOCKED'")) return rows([{ action_id: actionId }]);
    return rows([]);
  });
  const store = new PostgresAgentConfigurationStore(pool(client), () => new Date("2030-01-01T01:02:03.000Z"));
  const result = await store.lock(claim(), baseline());
  assert.equal(result.runId, runId);
  assert.equal(result.sourceBaselineReceiptId, baselineId);
  assert.match(result.resolutionDigest, /^[a-f0-9]{64}$/);
  const observedLock = persistedLock as unknown as Record<string, unknown>;
  assert.equal(observedLock.profileRevisionId, "profile-platform-r1");
  assert.equal(observedLock.profileSource, "platform");
  assert.equal(observedLock.commitSha, commitSha);
  assert.deepEqual(observedLock.targetMatrix, ["linux", "windows"]);
  assert.equal(observedLock.adminCatalogRevision, "12");
  assert.ok(sql.some((statement) => statement.includes("FOR SHARE OF spec, plan, binding, toolchain, baseline, catalog")));
  assert.ok(sql.some((statement) => statement.includes("ON CONFLICT (tenant_id, idempotency_key) DO NOTHING")));
});

function claim(): AgentConfigurationClaim {
  return Object.freeze({
    kind: "CLAIMED",
    tenantId,
    projectId,
    workflowId: `delivery-${projectId}`,
    actionId,
    specRevisionId,
    testPlanRevisionId,
    specApprovalReceiptId: approvalId,
    claimToken,
  });
}
function baseline(): SourceBaselineReceipt {
  return Object.freeze({
    schemaVersion: "deviludo.source-baseline-receipt.v1",
    operationKey: sourceBaselineOperationKey(actionId),
    tenantId,
    projectId,
    workflowId: `delivery-${projectId}`,
    specRevisionId,
    testPlanRevisionId,
    specApprovalReceiptId: approvalId,
    sourceBaselineReceiptId: baselineId,
    repositoryBindingId,
    defaultBranch: "main",
    commitSha,
    sourceDigest,
    observedAt: "2030-01-01T00:00:00.000Z",
    replayed: false,
  });
}
function candidate(override: Readonly<Record<string, unknown>>) {
  return {
    action_id: actionId,
    tenant_id: tenantId,
    project_id: projectId,
    workflow_id: `delivery-${projectId}`,
    action_status: "WAITING",
    binding,
    resolution_state: "PENDING",
    claim_token: null,
    source_baseline_receipt_id: null,
    run_id: null,
    resolution_digest: null,
    ...override,
  };
}
function authority() {
  return {
    ...candidate({ resolution_state: "CLAIMED", claim_token: claimToken }),
    spec_revision_id: specRevisionId,
    spec_state: "APPROVED",
    spec_digest: "1".repeat(64),
    test_plan_revision_id: testPlanRevisionId,
    test_plan_state: "FROZEN",
    test_plan_digest: "2".repeat(64),
    bound_test_plan_digest: "2".repeat(64),
    target_matrix: ["linux", "windows"],
    runner_toolchain_revision_id: toolchainId,
    runner_toolchain_digest: "3".repeat(64),
    actual_runner_toolchain_digest: "3".repeat(64),
    baseline_operation_key: sourceBaselineOperationKey(actionId),
    baseline_repository_binding_id: repositoryBindingId,
    baseline_default_branch: "main",
    baseline_commit_sha: commitSha,
    baseline_source_digest: sourceDigest,
    baseline_observed_at: "2030-01-01T00:00:00.000Z",
    baseline_spec_revision_id: specRevisionId,
    baseline_test_plan_revision_id: testPlanRevisionId,
    baseline_spec_approval_receipt_id: approvalId,
    catalog_revision: "12",
    catalog_payload: catalog(),
  };
}
function catalog() {
  return {
    versions: [{
      id: "claude-code@2.1.14", agent: "claude-code", version: "2.1.14", state: "APPROVED",
      signatureVerified: true, scan: "PASS", sourceDigest: "4".repeat(64),
      catalogReceiptDigest: "5".repeat(64), validationReceiptDigest: "6".repeat(64),
      supplyChainEvidenceDigest: "7".repeat(64),
    }],
    installations: [{
      id: "installation-claude-r1", agent: "claude-code", agentVersionId: "claude-code@2.1.14",
      workerPool: "development-linux-primary", imageDigest: `sha256:${"8".repeat(64)}`,
      workerImageId: "worker-image-claude-r1", adapterVersion: "1.0.0",
      buildReceiptId: "build-receipt-claude-r1", buildReceiptDigest: "9".repeat(64),
      state: "ACTIVE", health: "HEALTHY", rolloutPercent: 100, selfUpdateDisabled: true,
    }],
    providers: [{
      id: "provider-claude-r1", agent: "claude-code", state: "ACTIVE",
      protocol: "anthropic-messages", baseUrl: "https://gateway.anthropic.example/v1",
      credentialVersionId: "credential-claude-v1",
      models: {
        primaryModel: "claude-sonnet-4-6-20250514", planningModel: "claude-sonnet-4-6-20250514",
        smallFastModel: "claude-sonnet-4-6-20250514", subagentModel: "claude-sonnet-4-6-20250514",
      },
      probe: {
        authentication: "PASS", modelExistence: "PASS", streaming: "PASS", toolCalling: "PASS",
        cancellation: "PASS", usage: "PASS", timeout: "PASS",
      },
    }],
    profiles: [{
      id: "profile-platform-r1", scope: "platform", scopeId: "global", state: "ACTIVE",
      agent: "claude-code", installationId: "installation-claude-r1",
      providerRevisionId: "provider-claude-r1", credentialVersionId: "credential-claude-v1",
      budget: { maxUsd: 25, maxTurns: 100, timeoutSeconds: 7200 },
    }],
    credentials: [{ id: "credential-claude-v1", scope: "platform", scopeId: "global", state: "ACTIVE" }],
    defaults: [["platform", "profile-platform-r1"]],
  };
}

function clientWith(
  query: (statement: string, values: readonly unknown[]) => Promise<PostgresQueryResult<Record<string, unknown>>>,
): PostgresWorkflowClient {
  return {
    async query<Row extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []) {
      return await query(statement, values) as PostgresQueryResult<Row>;
    },
    release() {},
  };
}
function pool(client: PostgresWorkflowClient): PostgresWorkflowPool { return { async connect() { return client; } }; }
function rows<Row extends Record<string, unknown>>(value: readonly Row[]): PostgresQueryResult<Row> {
  return { rowCount: value.length, rows: value };
}
