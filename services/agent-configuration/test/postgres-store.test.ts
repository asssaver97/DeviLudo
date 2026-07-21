import assert from "node:assert/strict";
import test from "node:test";
import { createAgentFailureDiagnostic } from "../../../lib/agent/failure-diagnostics";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { sha256Canonical } from "../../runner-control/src/canonical";
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
  repairContext: null,
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
  let authorizationValues: readonly unknown[] = [];
  const client = clientWith(async (statement, values) => {
    sql.push(statement);
    if (statement.includes("CROSS JOIN deviludo.admin_catalog_state catalog")) {
      return rows([authority(catalogWithFallback())]);
    }
    if (statement.includes("INSERT INTO deviludo.agent_runs")) {
      persistedLock = JSON.parse(String(values[13])) as Record<string, unknown>;
      persistedDigest = String(values[14]);
      return rows([]);
    }
    if (statement.includes("FROM deviludo.inference_provider_revisions")) {
      return rows([{ provider_revision_id: String(values[1]) }]);
    }
    if (statement.includes("FROM deviludo.agent_runs")) {
      return rows([{ id: runId, state: "QUEUED", resolution_digest: persistedDigest, configuration_lock: persistedLock }]);
    }
    if (statement.includes("INSERT INTO deviludo.inference_run_authorizations")) {
      authorizationValues = values;
      return rows([]);
    }
    if (statement.includes("FROM deviludo.inference_run_authorizations")) {
      return rows([{ run_id: runId }]);
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
  assert.equal(observedLock.profileSource, `project:${projectId}`);
  assert.equal(observedLock.commitSha, commitSha);
  assert.deepEqual(observedLock.targetMatrix, ["linux", "windows"]);
  assert.equal(observedLock.adminCatalogRevision, "12");
  assert.equal(observedLock.repairContext, null);
  assert.deepEqual(observedLock.agentVersionAttestation, {
    catalogReceiptDigest: "5".repeat(64),
    validationReceiptId: "validation-claude-code-2.1.14",
    validationReceiptDigest: "6".repeat(64),
    supplyChainEvidenceDigest: "7".repeat(64),
    validatedAdapterVersion: "1.3.0",
    adapterCompatibility: { min: "1.3.0", maxExclusive: "1.3.1" },
  });
  const observedFallback = observedLock.fallback as Record<string, unknown>;
  assert.equal(observedFallback.profileRevisionId, "profile-fallback-r1");
  assert.equal(observedFallback.providerRevisionId, "provider-claude-fallback-r1");
  assert.equal(observedFallback.inferenceAuthorizationExpiresAt, "2030-01-01T02:02:03.000Z");
  assert.deepEqual(observedFallback.agentVersionAttestation, observedLock.agentVersionAttestation);
  assert.ok(sql.some((statement) => statement.includes("FOR SHARE OF spec, plan, binding, toolchain, baseline, catalog")));
  assert.ok(sql.some((statement) => statement.includes("ON CONFLICT (tenant_id, idempotency_key) DO NOTHING")));
  assert.equal(sql.filter((statement) => statement.includes("INSERT INTO deviludo.inference_provider_revisions")).length, 2);
  assert.ok(sql.some((statement) => statement.includes("INSERT INTO deviludo.inference_run_authorizations")));
  assert.deepEqual(authorizationValues[6], ["claude-sonnet-4-6-20250514"]);
  assert.deepEqual(JSON.parse(String(authorizationValues[7])), { maxCostUsd: 25 });
  assert.equal(authorizationValues[9], "2030-01-01T03:02:03.000Z");
});

test("PostgreSQL Agent configuration creates a successor repair run from the failed candidate without resolving moving defaults", async () => {
  const repairActionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const repairClaimToken = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const agentRepairActionId = "12121212-1212-4212-8212-121212121212";
  const agentRepairClaimToken = "13131313-1313-4313-8313-131313131313";
  const evidenceId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const candidateCommitSha = "a".repeat(40);
  const candidateSourceDigest = "b".repeat(64);
  const createdAt = "2030-01-01T00:30:00.000Z";
  const evidenceCore = {
    id: evidenceId,
    attemptId: evidenceId,
    specRevisionId,
    specDigest: "1".repeat(64),
    testPlanDigest: "2".repeat(64),
    commitSha: candidateCommitSha,
    sourceDigest: candidateSourceDigest,
    targetMatrix: ["linux", "windows"],
    godotTestKitDigest: "c".repeat(64),
    buildManifestDigest: "d".repeat(64),
    sbomDigest: "e".repeat(64),
    vulnerabilityScanDigest: "f".repeat(64),
    assetLicenseLedgerDigest: "0".repeat(64),
    platformEvidence: [
      { platform: "linux", runnerId: "runner-linux-1", runnerCapabilityDigest: "1".repeat(64),
        exportDigest: "2".repeat(64), logsDigest: "3".repeat(64), junitDigest: "4".repeat(64),
        inputTimelineDigest: "5".repeat(64), screenshotManifestDigest: "6".repeat(64),
        videoManifestDigest: "7".repeat(64), status: "PASSED" },
      { platform: "windows", runnerId: "runner-windows-1", runnerCapabilityDigest: "8".repeat(64),
        exportDigest: "9".repeat(64), logsDigest: "a".repeat(64), junitDigest: "b".repeat(64),
        inputTimelineDigest: "c".repeat(64), screenshotManifestDigest: "d".repeat(64),
        videoManifestDigest: "e".repeat(64), status: "FAILED" },
    ],
    status: "FAILED",
    valid: true,
    createdAt,
  } as const;
  const evidence = Object.freeze({ ...evidenceCore, bundleDigest: sha256Canonical(evidenceCore) });
  let previousRunId = "";
  let previousLock: Record<string, unknown> | null = null;
  let previousDigest = "";
  let latestRunId = "";
  let latestLock: Record<string, unknown> | null = null;
  let latestDigest = "";
  let agentRepairRunId = "";
  let agentRepairLock: Record<string, unknown> | null = null;
  let agentRepairDigest = "";
  let failedDiagnostic: ReturnType<typeof createAgentFailureDiagnostic> | null = null;
  const locks = new Map<string, { lock: Record<string, unknown>; digest: string }>();
  const client = clientWith(async (statement, values) => {
    if (statement.includes("JOIN deviludo.agent_execution_operations execution")) {
      const agentFailure = values[2] === latestRunId;
      const selectedLock = agentFailure ? latestLock : previousLock;
      const selectedDigest = agentFailure ? latestDigest : previousDigest;
      const selectedRunId = agentFailure ? latestRunId : previousRunId;
      assert.ok(selectedLock);
      return rows([{
        id: selectedRunId, state: agentFailure ? "FAILED" : "SUCCEEDED", resolution_digest: selectedDigest,
        configuration_lock: selectedLock, execution_state: agentFailure ? "FAILED" : "SUCCEEDED",
        diagnostic_id: agentFailure ? failedDiagnostic?.diagnosticId : null,
        diagnostic: agentFailure ? failedDiagnostic : null,
        source_baseline_receipt_id: baselineId, baseline_operation_key: sourceBaselineOperationKey(actionId),
        baseline_repository_binding_id: repositoryBindingId, baseline_workflow_id: `delivery-${projectId}`,
        baseline_spec_revision_id: specRevisionId, baseline_test_plan_revision_id: testPlanRevisionId,
        baseline_spec_approval_receipt_id: approvalId, baseline_default_branch: "main",
        baseline_commit_sha: commitSha, baseline_source_digest: sourceDigest,
        baseline_observed_at: "2030-01-01T00:00:00.000Z",
      }]);
    }
    if (statement.includes("FROM deviludo.evidence_bundles evidence")) return rows([{
      attempt_id: evidenceId, attempt_run_id: previousRunId, attempt_mode: "CANDIDATE",
      attempt_commit_sha: candidateCommitSha, attempt_draft_pull_request: 73, attempt_state: "FAILED",
      attempt_repair_prompt_id: `repair:${evidence.bundleDigest}`, evidence_id: evidenceId,
      evidence_bundle_digest: evidence.bundleDigest, evidence_status: "FAILED",
      evidence_invalidated_at: null, evidence_manifest: evidence,
    }]);
    if (statement.includes("CROSS JOIN deviludo.admin_catalog_state catalog")) {
      const isE2eRepair = values[1] === repairActionId;
      const isAgentRepair = values[1] === agentRepairActionId;
      return rows([{ ...authority(isE2eRepair || isAgentRepair ? catalog() : catalogWithFallback()),
        ...(isE2eRepair ? {
          action_id: repairActionId,
          binding: { ...binding, repairContext: {
            attempt: 1, reason: "E2E_FAILURE", fromRunConfigurationId: previousRunId,
            diagnosticId: null, evidenceBundleId: evidenceId,
            repairPromptId: `repair:${evidence.bundleDigest}`, candidateCommitSha, draftPullRequest: 73,
          } },
          claim_token: repairClaimToken,
        } : isAgentRepair ? {
          action_id: agentRepairActionId,
          binding: { ...binding, repairContext: {
            attempt: 2, reason: "AGENT_FAILURE", fromRunConfigurationId: latestRunId,
            diagnosticId: failedDiagnostic?.diagnosticId, evidenceBundleId: null,
            repairPromptId: null, candidateCommitSha: null, draftPullRequest: null,
          } },
          claim_token: agentRepairClaimToken,
        } : {}),
      }]);
    }
    if (statement.includes("INSERT INTO deviludo.agent_runs")) {
      const id = String(values[0]);
      const lock = JSON.parse(String(values[13])) as Record<string, unknown>;
      const digest = String(values[14]);
      locks.set(id, { lock, digest });
      if (!previousRunId) {
        previousRunId = id; previousLock = lock; previousDigest = digest;
      } else if (!latestRunId) {
        latestRunId = id; latestLock = lock; latestDigest = digest;
      } else {
        agentRepairRunId = id; agentRepairLock = lock; agentRepairDigest = digest;
      }
      return rows([]);
    }
    if (statement.includes("FROM deviludo.inference_provider_revisions")) {
      return rows([{ provider_revision_id: String(values[1]) }]);
    }
    if (statement.includes("FROM deviludo.agent_runs") && statement.includes("idempotency_key")) {
      const id = values[1] === `agent-config:${agentRepairActionId}` ? agentRepairRunId
        : values[1] === `agent-config:${repairActionId}` ? latestRunId : previousRunId;
      const selected = locks.get(id)!;
      return rows([{ id, state: "QUEUED", resolution_digest: selected.digest, configuration_lock: selected.lock }]);
    }
    if (statement.includes("FROM deviludo.inference_run_authorizations")) {
      return rows([{ run_id: String(values[0]) }]);
    }
    if (statement.includes("SET state = 'LOCKED'")) return rows([{ action_id: String(values[1]) }]);
    return rows([]);
  });
  const store = new PostgresAgentConfigurationStore(pool(client), () => new Date("2030-01-01T01:02:03.000Z"));
  const original = await store.lock(claim(), baseline());
  assert.equal(original.runId, previousRunId);
  // Simulate a digest-valid lock created before Adapter attestations became a
  // required field. Repair replay must preserve its explicit legacy status
  // instead of consulting moving defaults or inventing evidence.
  const historical = structuredClone(previousLock!) as Record<string, unknown>;
  delete historical.agentVersionAttestation;
  const historicalFallback = historical.fallback as Record<string, unknown>;
  delete historicalFallback.agentVersionAttestation;
  delete historical.resolutionDigest;
  const historicalDigest = sha256Canonical(historical);
  previousLock = { ...historical, resolutionDigest: historicalDigest };
  previousDigest = historicalDigest;
  locks.set(previousRunId, { lock: previousLock, digest: previousDigest });
  const repairContext = Object.freeze({
    attempt: 1, reason: "E2E_FAILURE" as const, fromRunConfigurationId: previousRunId,
    diagnosticId: null, evidenceBundleId: evidenceId, repairPromptId: `repair:${evidence.bundleDigest}`,
    candidateCommitSha, draftPullRequest: 73,
  });
  const repaired = await store.lock(Object.freeze({
    ...claim(), actionId: repairActionId, claimToken: repairClaimToken, repairContext,
  }), null);
  assert.equal(repaired.runId, latestRunId);
  assert.notEqual(repaired.runId, original.runId);
  const observedLatestLock = latestLock as unknown as Record<string, unknown>;
  assert.equal(observedLatestLock.commitSha, candidateCommitSha);
  assert.equal(observedLatestLock.sourceDigest, candidateSourceDigest);
  assert.equal(observedLatestLock.sourceBaselineReceiptId, baselineId);
  assert.equal((observedLatestLock.fallback as Record<string, unknown>).profileRevisionId, "profile-fallback-r1");
  assert.equal(observedLatestLock.agentVersionAttestation, null);
  assert.equal((observedLatestLock.fallback as Record<string, unknown>).agentVersionAttestation, null);
  assert.equal((observedLatestLock.repairContext as Record<string, unknown>).evidenceBundleDigest, evidence.bundleDigest);
  const failed = (observedLatestLock.repairContext as { failedPlatforms: Array<Record<string, unknown>> }).failedPlatforms;
  assert.deepEqual(failed.map((item) => item.platform), ["windows"]);
  assert.equal(failed[0]?.logsDigest, "a".repeat(64));
  assert.match(latestDigest, /^[a-f0-9]{64}$/);

  failedDiagnostic = createAgentFailureDiagnostic({
    runId: latestRunId,
    attemptId: "14141414-1414-4414-8414-141414141414",
    stage: "RUNNING_AGENT",
    error: new Error("Agent failed while repairing the Windows export"),
    process: {
      exitCode: 1, signal: null, timedOut: false, cancelled: false, durationMs: 12_000,
      stderr: "must not be persisted", droppedJsonLines: 0,
      adapter: { eventCount: 9, warningCount: 1, lastEventType: "failed", messages: ["Windows export preset is invalid"] },
    },
  });
  const agentRepaired = await store.lock(Object.freeze({
    ...claim(), actionId: agentRepairActionId, claimToken: agentRepairClaimToken,
    repairContext: Object.freeze({
      attempt: 2, reason: "AGENT_FAILURE" as const, fromRunConfigurationId: latestRunId,
      diagnosticId: failedDiagnostic.diagnosticId, evidenceBundleId: null, repairPromptId: null,
      candidateCommitSha: null, draftPullRequest: null,
    }),
  }), null);
  assert.equal(agentRepaired.runId, agentRepairRunId);
  const observedAgentRepairLock = agentRepairLock as unknown as Record<string, unknown>;
  assert.equal(observedAgentRepairLock.commitSha, candidateCommitSha);
  assert.equal(observedAgentRepairLock.sourceDigest, candidateSourceDigest);
  const agentContext = observedAgentRepairLock.repairContext as Record<string, unknown>;
  assert.deepEqual(agentContext.agentDiagnostic, failedDiagnostic);
  assert.equal(agentContext.evidenceBundleDigest, null);
  assert.match(agentRepairDigest, /^[a-f0-9]{64}$/);
});

test("PostgreSQL Agent configuration refuses a drifted serving projection without creating a run", async () => {
  const sql: string[] = [];
  const client = clientWith(async (statement) => {
    sql.push(statement);
    if (statement.includes("CROSS JOIN deviludo.admin_catalog_state catalog")) return rows([authority()]);
    if (statement.includes("FROM deviludo.inference_provider_revisions")) return rows([]);
    return rows([]);
  });
  const store = new PostgresAgentConfigurationStore(pool(client), () => new Date("2030-01-01T01:02:03.000Z"));
  await assert.rejects(store.lock(claim(), baseline()), /authority conflicts/);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO deviludo.agent_runs")), false);
  assert.equal(sql.at(-1), "ROLLBACK");
});

test("PostgreSQL Agent configuration rejects an unattested catalog version before creating a Run", async () => {
  const sql: string[] = [];
  const unattested = catalog();
  delete (unattested.versions[0] as Record<string, unknown>).validatedAdapterVersion;
  delete (unattested.versions[0] as Record<string, unknown>).adapterCompatibility;
  const client = clientWith(async (statement) => {
    sql.push(statement);
    if (statement.includes("CROSS JOIN deviludo.admin_catalog_state catalog")) return rows([authority(unattested)]);
    return rows([]);
  });
  const store = new PostgresAgentConfigurationStore(pool(client), () => new Date("2030-01-01T01:02:03.000Z"));
  await assert.rejects(store.lock(claim(), baseline()), /Adapter compatibility|exact version/);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO deviludo.agent_runs")), false);
  assert.equal(sql.at(-1), "ROLLBACK");
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
    repairContext: null,
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
function authority(catalogPayload: unknown = catalog()) {
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
    catalog_payload: catalogPayload,
  };
}
function catalog() {
  return {
    versions: [{
      id: "claude-code@2.1.14", agent: "claude-code", version: "2.1.14", state: "APPROVED",
      signatureVerified: true, scan: "PASS", sourceDigest: "4".repeat(64),
      catalogReceiptDigest: "5".repeat(64), validationReceiptId: "validation-claude-code-2.1.14",
      validationReceiptDigest: "6".repeat(64),
      supplyChainEvidenceDigest: "7".repeat(64),
      validatedAdapterVersion: "1.3.0",
      adapterCompatibility: { min: "1.3.0", maxExclusive: "1.3.1" },
    }],
    installations: [{
      id: "installation-claude-r1", agent: "claude-code", agentVersionId: "claude-code@2.1.14",
      workerPool: "development-linux-primary", imageDigest: `sha256:${"8".repeat(64)}`,
      workerImageId: "worker-image-claude-r1", adapterVersion: "1.3.0",
      buildReceiptId: "build-receipt-claude-r1", buildReceiptDigest: "9".repeat(64),
      state: "ACTIVE", health: "HEALTHY", rolloutPercent: 100, selfUpdateDisabled: true,
    }],
    providers: [{
      id: "provider-claude-r1", agent: "claude-code", state: "ACTIVE",
      protocol: "anthropic-messages", baseUrl: "https://gateway.anthropic.example/v1",
      approvedPorts: [443], authentication: "x-api-key",
      credentialVersionId: "credential-claude-v1",
      models: {
        primaryModel: "claude-sonnet-4-6-20250514", planningModel: "claude-sonnet-4-6-20250514",
        smallFastModel: "claude-sonnet-4-6-20250514", subagentModel: "claude-sonnet-4-6-20250514",
      },
      pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
      governance: {
        dataRegion: "vendor-managed", retentionPolicy: "zero-retention",
        trainingPolicy: "no-training", confirmedBy: "security-admin",
        confirmedAt: "2030-01-01T00:00:00.000Z",
      },
      probe: {
        authentication: "PASS", modelExistence: "PASS", streaming: "PASS", toolCalling: "PASS",
        cancellation: "PASS", usage: "PASS", timeout: "PASS", minimalReasoning: "PASS",
        dnsPinning: "PASS", redirectRevalidation: "PASS",
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

function catalogWithFallback() {
  const payload = catalog();
  payload.versions.push({ ...payload.versions[0]!, id: "claude-code@2.1.15", version: "2.1.15",
    sourceDigest: "a".repeat(64) });
  payload.installations.push({ ...payload.installations[0]!, id: "installation-claude-fallback-r1",
    agentVersionId: "claude-code@2.1.15", imageDigest: `sha256:${"b".repeat(64)}`,
    workerImageId: "worker-image-claude-fallback-r1", buildReceiptId: "build-receipt-claude-fallback-r1",
    buildReceiptDigest: "c".repeat(64) });
  payload.providers.push({ ...structuredClone(payload.providers[0]!), id: "provider-claude-fallback-r1",
    baseUrl: "https://fallback.anthropic.example/v1", credentialVersionId: "credential-claude-fallback-v1" });
  payload.credentials.push({ id: "credential-claude-fallback-v1", scope: "platform", scopeId: "global", state: "ACTIVE" });
  payload.profiles.push({ ...payload.profiles[0]!, id: "profile-fallback-r1",
    installationId: "installation-claude-fallback-r1", providerRevisionId: "provider-claude-fallback-r1",
    credentialVersionId: "credential-claude-fallback-v1", budget: { maxUsd: 10, maxTurns: 40, timeoutSeconds: 3600 } });
  Object.assign(payload.profiles[0]!, { fallbackProfileRevisionId: "profile-fallback-r1" });
  payload.defaults.push([`project:${projectId}`, "profile-platform-r1"]);
  return payload;
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
