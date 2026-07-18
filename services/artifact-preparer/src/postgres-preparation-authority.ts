import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import {
  parseRunnerToolchainRevision,
  parseSourceExecutionPreparationRequest,
  parseSourceExecutionPreparationTrigger,
  type SourceExecutionPreparationRequest,
  type SourceExecutionPreparationTrigger,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

type AuthorityRow = {
  run_id: string;
  configuration_lock: unknown;
  spec_revision_id: string;
  spec_payload: unknown;
  spec_digest: string;
  test_plan_digest: string;
  target_matrix: string[];
  required_godot_version: string;
  runner_toolchain_revision_id: string;
  runner_toolchain_digest: string;
  toolchain_payload: unknown;
  toolchain_payload_digest: string;
};

type SourceRow = { source_digest: string | null };

export interface SourceExecutionPreparationAuthority {
  resolve(trigger: unknown): Promise<SourceExecutionPreparationRequest>;
  probe(): Promise<void>;
}

/** Resolves every executable Runner input from immutable, tenant-RLS PostgreSQL authority. */
export class PostgresSourceExecutionPreparationAuthority implements SourceExecutionPreparationAuthority {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolve(value: unknown): Promise<SourceExecutionPreparationRequest> {
    const trigger = parseSourceExecutionPreparationTrigger(value);
    return this.#transaction(trigger.tenantId, async (client) => {
      const authority = await client.query<AuthorityRow>(
        `SELECT run.id::text AS run_id,
                run.configuration_lock,
                spec.id::text AS spec_revision_id,
                spec.payload AS spec_payload,
                spec.payload_digest AS spec_digest,
                binding.test_plan_digest::text,
                binding.target_matrix,
                binding.required_godot_version,
                binding.runner_toolchain_revision_id::text,
                binding.runner_toolchain_digest::text,
                toolchain.payload AS toolchain_payload,
                toolchain.payload_digest::text AS toolchain_payload_digest
           FROM deviludo.agent_runs run
           JOIN deviludo.immutable_revisions spec
             ON spec.id = (run.configuration_lock->>'specRevisionId')::uuid
            AND spec.tenant_id = run.tenant_id
            AND spec.project_id = run.project_id
            AND spec.aggregate_type = 'GAME_SPEC'
            AND spec.state = 'APPROVED'
           JOIN deviludo.approved_test_plan_bindings binding
             ON binding.tenant_id = run.tenant_id
            AND binding.project_id = run.project_id
            AND binding.spec_revision_id = spec.id
           JOIN deviludo.runner_toolchain_revisions toolchain
             ON toolchain.tenant_id = binding.tenant_id
            AND toolchain.project_id = binding.project_id
            AND toolchain.id = binding.runner_toolchain_revision_id
            AND toolchain.payload_digest = binding.runner_toolchain_digest
          WHERE run.tenant_id = $1::uuid
            AND run.project_id = $2::uuid
            AND run.id = $3::uuid
          FOR SHARE OF run, spec, binding, toolchain`,
        [trigger.tenantId, trigger.projectId, trigger.runId],
      );
      if (authority.rows.length !== 1) invalid();
      const row = authority.rows[0]!;
      const locked = parseConfigurationLock(row.configuration_lock);
      if (row.run_id !== trigger.runId || row.spec_revision_id !== locked.specRevisionId
        || row.spec_digest !== locked.specDigest || row.test_plan_digest !== locked.testPlanDigest
        || row.runner_toolchain_revision_id !== locked.runnerToolchainRevisionId
        || row.runner_toolchain_digest !== locked.runnerToolchainDigest
        || row.toolchain_payload_digest !== row.runner_toolchain_digest
        || sha256Canonical(row.spec_payload) !== row.spec_digest
        || sha256Canonical(row.toolchain_payload) !== row.runner_toolchain_digest
        || !sameMatrix(row.target_matrix, trigger.targetMatrix)
        || !sameMatrix(locked.targetMatrix, trigger.targetMatrix)) invalid();
      const toolchain = parseRunnerToolchainRevision(row.toolchain_payload, trigger.targetMatrix);
      if (row.required_godot_version !== toolchain.requiredGodotVersion) invalid();
      const source = await resolveSource(client, trigger);
      if (source.rows.length !== 1 || !source.rows[0]?.source_digest || !SHA256.test(source.rows[0].source_digest)) invalid();
      return parseSourceExecutionPreparationRequest({
        schemaVersion: "deviludo.source-execution-preparation.v1",
        tenantId: trigger.tenantId,
        projectId: trigger.projectId,
        runId: trigger.runId,
        lockKey: trigger.lockKey,
        mode: trigger.mode,
        commitSha: trigger.commitSha,
        sourceDigest: source.rows[0].source_digest,
        specRevisionId: row.spec_revision_id,
        specDigest: row.spec_digest,
        testPlanDigest: row.test_plan_digest,
        runnerToolchainRevisionId: row.runner_toolchain_revision_id,
        runnerToolchainDigest: row.runner_toolchain_digest,
        targetMatrix: trigger.targetMatrix,
        toolchain,
      });
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ready: number }>("SELECT 1 AS ready");
      if (result.rows.length !== 1 || result.rows[0]?.ready !== 1) invalid();
    } finally { client.release(); }
  }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the authority failure */ }
      throw error;
    } finally { client.release(); }
  }
}

function resolveSource(client: PostgresWorkflowClient, trigger: SourceExecutionPreparationTrigger) {
  if (trigger.mode === "CANDIDATE") {
    return client.query<SourceRow>(
      `SELECT source_digest
         FROM deviludo.github_candidate_receipts
        WHERE tenant_id = $1::uuid
          AND project_id = $2::uuid
          AND run_id = $3::uuid
          AND candidate_commit_sha = $4
        FOR SHARE`,
      [trigger.tenantId, trigger.projectId, trigger.runId, trigger.commitSha],
    );
  }
  return client.query<SourceRow>(
    `SELECT merge.main_source_digest AS source_digest
       FROM deviludo.github_merge_receipts merge
       JOIN deviludo.github_candidate_receipts candidate
         ON candidate.id = merge.candidate_receipt_id
        AND candidate.tenant_id = merge.tenant_id
        AND candidate.project_id = merge.project_id
      WHERE merge.tenant_id = $1::uuid
        AND merge.project_id = $2::uuid
        AND candidate.run_id = $3::uuid
        AND merge.default_branch_head_sha = $4
        AND merge.main_source_digest IS NOT NULL
      FOR SHARE OF merge, candidate`,
    [trigger.tenantId, trigger.projectId, trigger.runId, trigger.commitSha],
  );
}

function parseConfigurationLock(value: unknown): Readonly<{
  specRevisionId: string;
  specDigest: string;
  testPlanDigest: string;
  runnerToolchainRevisionId: string;
  runnerToolchainDigest: string;
  targetMatrix: readonly string[];
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  const targetMatrix = body.targetMatrix;
  if (!Array.isArray(targetMatrix) || targetMatrix.some((item) => typeof item !== "string")) invalid();
  const result = {
    specRevisionId: text(body.specRevisionId, UUID),
    specDigest: text(body.specDigest, SHA256),
    testPlanDigest: text(body.testPlanDigest, SHA256),
    runnerToolchainRevisionId: text(body.runnerToolchainRevisionId, UUID),
    runnerToolchainDigest: text(body.runnerToolchainDigest, SHA256),
    targetMatrix: Object.freeze([...targetMatrix]) as readonly string[],
  };
  return Object.freeze(result);
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function sameMatrix(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalid(): never {
  throw new Error("Artifact preparation authority receipt is invalid");
}
