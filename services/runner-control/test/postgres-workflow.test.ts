import assert from "node:assert/strict";
import test from "node:test";
import type {
  PostgresQueryResult,
  PostgresWorkflowClient,
  PostgresWorkflowPool,
} from "../../temporal/src/postgres-inbox";
import { sha256Canonical } from "../src/canonical";
import { runnerExecutionLockDigest, type RunnerExecutionLock } from "../src/execution-lock";
import { PostgresRunnerWorkflowPort } from "../src/postgres-workflow";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const evidenceId = "66666666-6666-4666-8666-666666666666";
const specRevisionId = "77777777-7777-4777-8777-777777777777";
const executionLockId = "99999999-9999-4999-8999-999999999999";
const runnerToolchainRevisionId = "10101010-1010-4010-8010-101010101010";
const sha = (value: string) => value.repeat(64);
const commitSha = "a".repeat(40);
const sourceDigest = sha("b");
const specDigest = sha("c");
const testPlanDigest = sha("d");
const buildReceiptId = "12121212-1212-4212-8212-121212121212";
const releaseId = "13131313-1313-4313-8313-131313131313";
const revocationId = "14141414-1414-4414-8414-141414141414";

const executionLock: RunnerExecutionLock = Object.freeze({
  schemaVersion: "deviludo.runner-execution-lock.v1",
  tenantId,
  projectId,
  runId,
  mode: "CANDIDATE",
  commitSha,
  sourceDigest,
  steamBuildId: null,
  specRevisionId,
  specDigest,
  testPlanDigest,
  runnerToolchainRevisionId,
  runnerToolchainDigest: sha("0"),
  targetMatrix: Object.freeze(["linux"] as const),
  requiredGodotVersion: "4.6.2-stable",
  godotTestKitDigest: sha("8"),
  exportTemplates: Object.freeze({ linux: sha("0") }),
  buildManifestDigest: sha("9"),
  sbomDigest: sha("a"),
  vulnerabilityScanDigest: sha("b"),
  assetLicenseLedgerDigest: sha("c"),
  execution: Object.freeze({
    kind: "SOURCE_ARTIFACT",
    objectKey: `tenants/${tenantId}/projects/${projectId}/source/${sourceDigest}.tar.zst`,
    artifactDigest: sha("f"),
  }),
  preparedAt: "2026-07-18T00:00:00.000Z",
});
const executionLockDigest = runnerExecutionLockDigest(executionLock);

const input = Object.freeze({
  operationKey: `workflow-job:${jobId}`,
  requestDigest: sha("e"),
  tenantId,
  projectId,
  workflowId: "delivery-001",
  runId,
  mode: "CANDIDATE" as const,
  commitSha,
  draftPullRequest: 91,
  steamBuildId: null,
  targetMatrix: Object.freeze(["linux"] as const),
  async heartbeat() { return "renewed"; },
});

function binding() {
  return {
    schemaVersion: "deviludo.e2e-attempt.v1",
    workflowId: input.workflowId,
    operationKey: input.operationKey,
    requestDigest: input.requestDigest,
    iterationId: "88888888-8888-4888-8888-888888888888",
    mode: input.mode,
    executionLockId,
    executionLockDigest,
    specRevisionId,
    specDigest,
    testPlanDigest,
    runnerToolchainRevisionId,
    runnerToolchainDigest: sha("0"),
    targetMatrix: ["linux"],
  };
}

function attempt(state: "QUEUED" | "RUNNING" | "PASSED" | "FAILED" = "QUEUED") {
  return {
    id: attemptId,
    run_id: runId,
    workflow_id: input.workflowId,
    workflow_operation_key: input.operationKey,
    workflow_request_digest: input.requestDigest,
    execution_lock_id: executionLockId,
    mode: input.mode,
    commit_sha: commitSha,
    source_digest: sourceDigest,
    binding: binding(),
    target_matrix: ["linux"],
    draft_pull_request: "91",
    steam_build_id: null,
    state,
    repair_prompt_id: state === "FAILED" ? "repair-prompt-001" : null,
    completed_at: state === "PASSED" || state === "FAILED" ? "2026-07-18T00:01:00.000Z" : null,
  };
}

function terminalRow(status: "PASSED" | "FAILED", digestOverride?: string) {
  const platformEvidence = [{
    platform: "linux",
    runnerId: "linux-runner-001",
    runnerCapabilityDigest: sha("1"),
    exportDigest: sha("2"),
    logsDigest: sha("3"),
    junitDigest: sha("4"),
    inputTimelineDigest: sha("5"),
    screenshotManifestDigest: sha("6"),
    videoManifestDigest: sha("7"),
    status,
  }];
  const core = {
    id: evidenceId,
    attemptId,
    specRevisionId,
    specDigest,
    testPlanDigest,
    commitSha,
    sourceDigest,
    targetMatrix: ["linux"],
    godotTestKitDigest: sha("8"),
    buildManifestDigest: sha("9"),
    sbomDigest: sha("a"),
    vulnerabilityScanDigest: sha("b"),
    assetLicenseLedgerDigest: sha("c"),
    platformEvidence,
    status,
    valid: true,
    createdAt: "2026-07-18T00:01:00.000Z",
  };
  const bundleDigest = digestOverride ?? sha256Canonical(core);
  return {
    ...attempt(status),
    evidence_id: evidenceId,
    evidence_commit_sha: commitSha,
    evidence_source_digest: sourceDigest,
    evidence_binding: {
      schemaVersion: "deviludo.evidence-binding.v1",
      attemptId,
      executionLockId,
      executionLockDigest,
      specRevisionId,
      specDigest,
      testPlanDigest,
      runnerToolchainRevisionId,
      runnerToolchainDigest: sha("0"),
      commitSha,
      sourceDigest,
      targetMatrix: ["linux"],
    },
    evidence_manifest: { ...core, bundleDigest },
    evidence_bundle_digest: bundleDigest,
    evidence_object_key: `tenants/${tenantId}/evidence/${bundleDigest}.json`,
    evidence_status: status,
    evidence_invalidated_at: null,
  };
}

class ScriptedClient implements PostgresWorkflowClient {
  readonly sql: string[] = [];
  releases = 0;
  polls = 0;
  constructor(
    readonly terminal: "PASSED" | "FAILED" = "PASSED",
    readonly tamperedDigest = false,
    readonly missingSource = false,
    readonly missingExecutionLock = false,
    readonly tamperedExecutionLock = false,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.sql.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config('app.tenant_id'")) {
      return result([]);
    }
    if (text.includes("FROM deviludo.agent_runs") && text.includes("FOR UPDATE")) {
      assert.deepEqual(values, [tenantId, projectId, runId]);
      return result([{ iteration_id: binding().iterationId, configuration_lock: {
        specRevisionId, specDigest, testPlanDigest, runnerToolchainRevisionId,
        runnerToolchainDigest: sha("0"), targetMatrix: ["linux"],
      } }] as unknown as Row[]);
    }
    if (text.includes("FROM deviludo.github_candidate_receipts")) {
      return result((this.missingSource ? [] : [{ source_digest: sourceDigest, spec_revision_id: specRevisionId }]) as unknown as Row[]);
    }
    if (text.includes("FROM deviludo.runner_execution_locks")) {
      assert.deepEqual(values, [tenantId, projectId, runId, input.requestDigest]);
      if (this.missingExecutionLock) return result([]);
      const payload = this.tamperedExecutionLock ? { ...executionLock, commitSha: "f".repeat(40) } : executionLock;
      return result([{ id: executionLockId, payload, payload_digest: executionLockDigest }] as unknown as Row[]);
    }
    if (text.includes("INSERT INTO deviludo.e2e_attempts")) {
      assert.equal(values[8], input.operationKey);
      assert.equal(values[9], input.requestDigest);
      assert.equal(values[10], "CANDIDATE");
      assert.equal(values[13], executionLockId);
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("workflow_operation_key = $3") && !text.includes("LEFT JOIN")) {
      return result([attempt()] as unknown as Row[]);
    }
    if (text.includes("LEFT JOIN deviludo.evidence_bundles")) {
      this.polls += 1;
      if (this.polls === 1) return result([attempt("RUNNING")] as unknown as Row[]);
      return result([terminalRow(this.terminal, this.tamperedDigest ? sha("f") : undefined)] as unknown as Row[]);
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void { this.releases += 1; }
}

const steamInput = Object.freeze({
  ...input,
  mode: "STEAM_CLEAN_INSTALL" as const,
  draftPullRequest: null,
  steamBuildId: "91234567",
});
const steamExecutionLock: RunnerExecutionLock = Object.freeze({
  ...executionLock,
  mode: steamInput.mode,
  steamBuildId: steamInput.steamBuildId,
  execution: Object.freeze({
    kind: "STEAM_CLEAN_INSTALL" as const,
    steamAppId: "2841930",
    buildId: steamInput.steamBuildId,
    betaBranch: "private_beta",
    installGrantId: "steam-install-grant-001",
  }),
});
const steamExecutionLockDigest = runnerExecutionLockDigest(steamExecutionLock);

function steamBinding() {
  return { ...binding(), mode: steamInput.mode, executionLockDigest: steamExecutionLockDigest };
}

function steamTerminalRow(status: "PASSED" | "FAILED" = "PASSED") {
  const platformEvidence = [{
    platform: "linux", runnerId: "linux-runner-001", runnerCapabilityDigest: sha("1"),
    exportDigest: sha("2"), logsDigest: sha("3"), junitDigest: sha("4"), inputTimelineDigest: sha("5"),
    screenshotManifestDigest: sha("6"), videoManifestDigest: sha("7"), status,
  }];
  const core = {
    id: evidenceId, attemptId, specRevisionId, specDigest, testPlanDigest, commitSha, sourceDigest,
    targetMatrix: ["linux"], godotTestKitDigest: sha("8"), buildManifestDigest: sha("9"),
    sbomDigest: sha("a"), vulnerabilityScanDigest: sha("b"), assetLicenseLedgerDigest: sha("c"),
    platformEvidence, status, valid: true, createdAt: "2026-07-18T00:01:00.000Z",
  };
  const bundleDigest = sha256Canonical(core);
  return {
    id: attemptId, run_id: runId, workflow_id: steamInput.workflowId,
    workflow_operation_key: steamInput.operationKey, workflow_request_digest: steamInput.requestDigest,
    execution_lock_id: executionLockId, mode: steamInput.mode, commit_sha: commitSha, source_digest: sourceDigest,
    binding: steamBinding(), target_matrix: ["linux"], draft_pull_request: null,
    steam_build_id: steamInput.steamBuildId, state: status,
    repair_prompt_id: status === "FAILED" ? "steam-install-repair-001" : null,
    completed_at: "2026-07-18T00:01:00.000Z", evidence_id: evidenceId,
    evidence_commit_sha: commitSha, evidence_source_digest: sourceDigest,
    evidence_binding: {
      schemaVersion: "deviludo.evidence-binding.v1", attemptId, executionLockId,
      executionLockDigest: steamExecutionLockDigest,
      specRevisionId, specDigest, testPlanDigest, runnerToolchainRevisionId,
      runnerToolchainDigest: sha("0"), commitSha, sourceDigest, targetMatrix: ["linux"],
    },
    evidence_manifest: { ...core, bundleDigest }, evidence_bundle_digest: bundleDigest,
    evidence_object_key: `tenants/${tenantId}/evidence/${bundleDigest}.json`,
    evidence_status: status, evidence_invalidated_at: null,
  };
}

class SteamProjectionClient implements PostgresWorkflowClient {
  readonly sql: string[] = [];
  projected: boolean;
  readonly terminal: ReturnType<typeof steamTerminalRow>;

  constructor(
    projected = false,
    readonly outcome: "PASSED" | "FAILED" = "PASSED",
    readonly receiptConflict = false,
  ) {
    this.projected = projected;
    this.terminal = steamTerminalRow(outcome);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.sql.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config('app.tenant_id'")) return result([]);
    if (text.includes("FROM deviludo.agent_runs") && text.includes("FOR UPDATE")) {
      return result([{ iteration_id: binding().iterationId, configuration_lock: {
        specRevisionId, specDigest, testPlanDigest, runnerToolchainRevisionId,
        runnerToolchainDigest: sha("0"), targetMatrix: ["linux"],
      } }] as unknown as Row[]);
    }
    if (text.includes("FROM deviludo.steam_build_receipts build") && !text.includes("AS build_receipt_id")) {
      assert.match(text, /build\.state IN \('INSTALL_TESTING', 'EXTERNAL_APPROVAL_REQUIRED'\)/);
      assert.match(text, /build\.state = 'FAILED'[\s\S]*replay\.workflow_operation_key = \$6/);
      return result([{ source_digest: sourceDigest, spec_revision_id: specRevisionId }] as unknown as Row[]);
    }
    if (text.includes("FROM deviludo.runner_execution_locks")) {
      return result([{ id: executionLockId, payload: steamExecutionLock, payload_digest: steamExecutionLockDigest }] as unknown as Row[]);
    }
    if (text.includes("INSERT INTO deviludo.e2e_attempts")) return result([]);
    if (text.includes("workflow_operation_key = $3") && !text.includes("LEFT JOIN")) {
      return result([this.terminal] as unknown as Row[]);
    }
    if (text.includes("LEFT JOIN deviludo.evidence_bundles")) return result([this.terminal] as unknown as Row[]);
    if (text.includes("AS build_receipt_id")) {
      const terminalState = this.outcome === "PASSED" ? "EXTERNAL_APPROVAL_REQUIRED" : "FAILED";
      return result([{
        build_receipt_id: buildReceiptId,
        build_state: this.projected ? terminalState : "INSTALL_TESTING",
        steam_install_evidence_bundle_digest: this.projected ? this.terminal.evidence_bundle_digest : null,
        release_id: releaseId,
        release_state: this.projected ? terminalState : "INSTALL_TESTING",
        external_gate: this.projected && this.outcome === "PASSED" ? "VALVE_REVIEW" : "NONE",
        workflow_id: steamInput.workflowId, release_run_id: runId, main_commit_sha: commitSha,
        build_id: steamInput.steamBuildId, target_matrix: ["linux"], evidence_id: evidenceId,
        evidence_bundle_digest: this.terminal.evidence_bundle_digest,
      }] as unknown as Row[]);
    }
    if (text.includes("INSERT INTO deviludo.steam_release_revocations")) {
      assert.deepEqual(values, [tenantId, projectId, steamInput.workflowId, runId, releaseId,
        buildReceiptId, attemptId, evidenceId, this.terminal.evidence_bundle_digest,
        "steam-install-repair-001", commitSha, steamInput.steamBuildId,
        "2026-07-18T00:01:00.000Z"]);
      return result([]);
    }
    if (text.includes("FROM deviludo.steam_release_revocations")) {
      return result((this.receiptConflict ? [] : [{ id: revocationId }]) as unknown as Row[]);
    }
    if (text.includes("UPDATE deviludo.steam_build_receipts")) return result([{ id: buildReceiptId }] as unknown as Row[]);
    if (text.includes("UPDATE deviludo.steam_releases")) {
      this.projected = true;
      return result([{ id: releaseId }] as unknown as Row[]);
    }
    throw new Error(`Unexpected SQL: ${text}; values=${JSON.stringify(values)}`);
  }

  release(): void {}
}

function result<Row extends Record<string, unknown>>(rows: readonly Row[]): PostgresQueryResult<Row> {
  return { rowCount: rows.length, rows };
}

function pool(client: PostgresWorkflowClient): PostgresWorkflowPool {
  return { async connect() { return client; } };
}

test("PostgreSQL Runner workflow schedules once, heartbeats and accepts only terminal content-bound evidence", async () => {
  const client = new ScriptedClient();
  let heartbeats = 0;
  let now = 0;
  const port = new PostgresRunnerWorkflowPort({
    pool: pool(client), pollIntervalMs: 250, maxWaitMs: 30_000,
    now: () => now,
    async pause(delay) { now += delay; },
  });
  const receipt = await port.execute({ ...input, async heartbeat() { heartbeats += 1; return "renewed"; } });
  assert.equal(receipt.status, "PASSED");
  assert.equal(receipt.attemptId, attemptId);
  assert.equal(receipt.evidenceBundleId, evidenceId);
  assert.equal(receipt.repairPromptId, null);
  assert.equal(heartbeats, 1);
  assert.equal(client.polls, 2);
  assert.ok(client.sql.some((sql) => sql.includes("ON CONFLICT (tenant_id, workflow_operation_key) DO NOTHING")));
  assert.ok(client.sql.some((sql) => sql.includes("set_config('app.tenant_id'")));
  assert.equal(client.releases, 3);
});

test("PostgreSQL Runner workflow exposes failed evidence only with its immutable repair prompt", async () => {
  const client = new ScriptedClient("FAILED");
  let now = 0;
  const port = new PostgresRunnerWorkflowPort({
    pool: pool(client), pollIntervalMs: 250, maxWaitMs: 30_000,
    now: () => now,
    async pause(delay) { now += delay; },
  });
  const receipt = await port.execute(input);
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.repairPromptId, "repair-prompt-001");
});

test("PostgreSQL Runner workflow fails closed on a tampered bundle digest", async () => {
  const client = new ScriptedClient("PASSED", true);
  let now = 0;
  const port = new PostgresRunnerWorkflowPort({
    pool: pool(client), pollIntervalMs: 250, maxWaitMs: 30_000,
    now: () => now,
    async pause(delay) { now += delay; },
  });
  await assert.rejects(port.execute(input), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "E2E_EVIDENCE_DIGEST_INVALID");
    return true;
  });
});

test("PostgreSQL Runner workflow does not invent a source digest when the authoritative SCM receipt is absent", async () => {
  const client = new ScriptedClient("PASSED", false, true);
  const port = new PostgresRunnerWorkflowPort({ pool: pool(client) });
  await assert.rejects(port.execute(input), /GitHub candidate source receipt is not available/);
  assert.equal(client.polls, 0);
  assert.ok(client.sql.includes("ROLLBACK"));
});

test("PostgreSQL Runner workflow waits when artifact preparation has not created its execution lock", async () => {
  const client = new ScriptedClient("PASSED", false, false, true);
  const port = new PostgresRunnerWorkflowPort({ pool: pool(client) });
  await assert.rejects(port.execute(input), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "RUNNER_EXECUTION_LOCK_MISSING");
    assert.equal((error as { terminal?: boolean }).terminal, false);
    return true;
  });
  assert.equal(client.polls, 0);
  assert.ok(client.sql.includes("ROLLBACK"));
});

test("PostgreSQL Runner workflow rejects an execution lock whose content no longer matches its digest", async () => {
  const client = new ScriptedClient("PASSED", false, false, false, true);
  const port = new PostgresRunnerWorkflowPort({ pool: pool(client) });
  await assert.rejects(port.execute(input), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "RUNNER_EXECUTION_LOCK_BINDING_CONFLICT");
    assert.equal((error as { terminal?: boolean }).terminal, true);
    return true;
  });
  assert.equal(client.polls, 0);
});

test("PostgreSQL Runner projects passed clean-Steam-install evidence before returning its workflow receipt", async () => {
  const client = new SteamProjectionClient();
  const port = new PostgresRunnerWorkflowPort({ pool: pool(client), pollIntervalMs: 250, maxWaitMs: 30_000 });
  const receipt = await port.execute(steamInput);
  assert.equal(receipt.status, "PASSED");
  assert.equal(receipt.steamBuildId, steamInput.steamBuildId);
  assert.equal(client.projected, true);
  assert.ok(client.sql.some((sql) => sql.includes("steam_install_evidence_bundle_digest = $4")));
  assert.ok(client.sql.some((sql) => sql.includes("external_gate = 'VALVE_REVIEW'")));

  const replayClient = new SteamProjectionClient(true);
  const replay = await new PostgresRunnerWorkflowPort({ pool: pool(replayClient) }).execute(steamInput);
  assert.equal(replay.evidenceBundleId, evidenceId);
  assert.equal(replayClient.sql.some((sql) => sql.includes("UPDATE deviludo.steam_releases")), false);
});

test("PostgreSQL Runner atomically revokes failed Steam install authority before returning", async () => {
  const client = new SteamProjectionClient(false, "FAILED");
  const receipt = await new PostgresRunnerWorkflowPort({ pool: pool(client) }).execute(steamInput);
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.repairPromptId, "steam-install-repair-001");
  assert.equal(client.projected, true);

  const insert = client.sql.findIndex((sql) => sql.includes("INSERT INTO deviludo.steam_release_revocations"));
  const validate = client.sql.findIndex((sql) => sql.includes("FROM deviludo.steam_release_revocations"));
  const build = client.sql.findIndex((sql) => sql.includes("UPDATE deviludo.steam_build_receipts"));
  const release = client.sql.findIndex((sql) => sql.includes("UPDATE deviludo.steam_releases"));
  assert.ok(insert >= 0 && insert < validate && validate < build && build < release);
  assert.match(client.sql[build] as string, /SET state = 'FAILED'/);
  assert.match(client.sql[release] as string, /version = version \+ 1/);
});

test("PostgreSQL Runner replays only the exact failed Steam revocation receipt", async () => {
  const replayClient = new SteamProjectionClient(true, "FAILED");
  const replay = await new PostgresRunnerWorkflowPort({ pool: pool(replayClient) }).execute(steamInput);
  assert.equal(replay.status, "FAILED");
  assert.equal(replay.evidenceBundleId, evidenceId);
  assert.equal(replayClient.sql.some((sql) => sql.includes("INSERT INTO deviludo.steam_release_revocations")), false);
  assert.equal(replayClient.sql.some((sql) => sql.includes("UPDATE deviludo.steam_build_receipts")), false);
  assert.equal(replayClient.sql.some((sql) => sql.includes("UPDATE deviludo.steam_releases")), false);

  const conflict = new SteamProjectionClient(true, "FAILED", true);
  await assert.rejects(new PostgresRunnerWorkflowPort({ pool: pool(conflict) }).execute(steamInput), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "STEAM_INSTALL_FAILURE_REVOCATION_RECEIPT_CONFLICT");
    assert.equal((error as { terminal?: boolean }).terminal, true);
    return true;
  });
  assert.ok(conflict.sql.includes("ROLLBACK"));
});
