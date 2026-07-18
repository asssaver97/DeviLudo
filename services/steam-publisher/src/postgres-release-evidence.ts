import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { SteamReleaseEvidenceGate, SteamTargetPlatform } from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type EvidenceInput = Parameters<SteamReleaseEvidenceGate["assertPassed"]>[0];
type EvidenceRow = {
  evidence_id: string;
  evidence_commit_sha: string;
  evidence_source_digest: string;
  evidence_bundle_digest: string;
  evidence_binding: unknown;
  evidence_manifest: unknown;
  evidence_status: string;
  evidence_invalidated_at: string | null;
  attempt_id: string;
  attempt_commit_sha: string;
  attempt_source_digest: string;
  attempt_binding: unknown;
  attempt_target_matrix: string[];
  attempt_mode: string;
  attempt_state: string;
};

/** Defense-in-depth evidence gate used again immediately before SteamPipe. */
export class PostgresSteamReleaseEvidenceGate implements SteamReleaseEvidenceGate {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async assertPassed(input: EvidenceInput): Promise<void> {
    validateInput(input);
    await this.#transaction(input.tenantId, async (client) => {
      const selected = await client.query<EvidenceRow>(
        `SELECT evidence.id::text AS evidence_id,
                evidence.commit_sha AS evidence_commit_sha,
                evidence.source_digest AS evidence_source_digest,
                evidence.bundle_digest AS evidence_bundle_digest,
                evidence.binding AS evidence_binding,
                evidence.manifest AS evidence_manifest,
                evidence.status AS evidence_status,
                evidence.invalidated_at::text AS evidence_invalidated_at,
                attempt.id::text AS attempt_id,
                attempt.commit_sha AS attempt_commit_sha,
                attempt.source_digest AS attempt_source_digest,
                attempt.binding AS attempt_binding,
                attempt.target_matrix AS attempt_target_matrix,
                attempt.mode AS attempt_mode,
                attempt.state AS attempt_state
           FROM deviludo.evidence_bundles evidence
           JOIN deviludo.e2e_attempts attempt
             ON attempt.tenant_id = evidence.tenant_id
            AND attempt.project_id = evidence.project_id
            AND attempt.id = evidence.attempt_id
          WHERE evidence.tenant_id = $1::uuid AND evidence.project_id = $2::uuid
            AND evidence.bundle_digest = $3
            AND evidence.commit_sha = $4 AND evidence.source_digest = $5
            AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
            AND attempt.mode = 'MAIN_RELEASE_GATE' AND attempt.state = 'PASSED'
          FOR SHARE OF evidence, attempt`,
        [input.tenantId, input.projectId, input.evidenceBundleDigest, input.mainCommitSha, input.sourceDigest],
      );
      if (selected.rows.length !== 1) invalid();
      validateRow(selected.rows[0]!, input);
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
      try { await client.query("ROLLBACK"); } catch { /* preserve evidence error */ }
      throw error;
    } finally { client.release(); }
  }
}

function validateRow(row: EvidenceRow, input: EvidenceInput): void {
  const attemptBinding = record(row.attempt_binding);
  const evidenceBinding = record(row.evidence_binding);
  const manifest = record(row.evidence_manifest);
  if (!UUID.test(row.evidence_id) || !UUID.test(row.attempt_id)
    || row.evidence_commit_sha !== input.mainCommitSha || row.attempt_commit_sha !== input.mainCommitSha
    || row.evidence_source_digest !== input.sourceDigest || row.attempt_source_digest !== input.sourceDigest
    || row.evidence_bundle_digest !== input.evidenceBundleDigest
    || row.evidence_status !== "PASSED" || row.evidence_invalidated_at !== null
    || row.attempt_mode !== "MAIN_RELEASE_GATE" || row.attempt_state !== "PASSED"
    || attemptBinding.specDigest !== input.specDigest || attemptBinding.testPlanDigest !== input.testPlanDigest
    || evidenceBinding.specDigest !== input.specDigest || evidenceBinding.testPlanDigest !== input.testPlanDigest
    || manifest.specDigest !== input.specDigest || manifest.testPlanDigest !== input.testPlanDigest
    || manifest.bundleDigest !== input.evidenceBundleDigest || manifest.status !== "PASSED" || manifest.valid !== true
    || JSON.stringify(matrix(row.attempt_target_matrix)) !== JSON.stringify(input.targetMatrix)
    || JSON.stringify(matrixValue(attemptBinding.targetMatrix)) !== JSON.stringify(input.targetMatrix)
    || JSON.stringify(matrixValue(evidenceBinding.targetMatrix)) !== JSON.stringify(input.targetMatrix)
    || JSON.stringify(matrixValue(manifest.targetMatrix)) !== JSON.stringify(input.targetMatrix)) invalid();
}

function validateInput(input: EvidenceInput): void {
  if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !SHA1.test(input.mainCommitSha)
    || ![input.sourceDigest, input.specDigest, input.testPlanDigest, input.evidenceBundleDigest]
      .every((item) => SHA256.test(item))) invalid();
  matrix(input.targetMatrix);
}

function matrixValue(value: unknown): readonly SteamTargetPlatform[] {
  if (!Array.isArray(value)) invalid();
  return matrix(value as SteamTargetPlatform[]);
}

function matrix(value: readonly SteamTargetPlatform[] | readonly string[]): readonly SteamTargetPlatform[] {
  if (!value.length || value.length > 3 || new Set(value).size !== value.length
    || value.some((item) => item !== "windows" && item !== "linux" && item !== "macos")
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
  return Object.freeze([...value]) as readonly SteamTargetPlatform[];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return record(JSON.parse(value) as unknown); }
    catch { invalid(); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function invalid(): never {
  throw new Error("PostgreSQL Steam release evidence gate is invalid");
}
