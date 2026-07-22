import { createHash } from "node:crypto";
import { canonicalJson } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { FrozenTestPlanPort } from "./preparer";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;

type TestPlanRow = {
  spec_revision_id: string;
  spec_state: string;
  plan_revision_id: string;
  plan_state: string;
  payload: unknown;
  payload_digest: string;
  bound_digest: string;
};

/** Reads only the frozen test plan attached to one approved specification. */
export class PostgresFrozenTestPlanPort implements FrozenTestPlanPort {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async read(input: Parameters<FrozenTestPlanPort["read"]>[0]): Promise<Buffer> {
    if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.specRevisionId)
      || !SHA256.test(input.testPlanDigest)) invalid();
    return this.#transaction(input.tenantId, async (client) => {
      const selected = await client.query<TestPlanRow>(
        `SELECT binding.spec_revision_id::text,
                spec.state AS spec_state,
                binding.test_plan_revision_id::text AS plan_revision_id,
                plan.state AS plan_state,
                plan.payload,
                plan.payload_digest,
                binding.test_plan_digest::text AS bound_digest
           FROM deviludo.approved_test_plan_bindings binding
           JOIN deviludo.immutable_revisions spec
             ON spec.id = binding.spec_revision_id
            AND spec.tenant_id = binding.tenant_id
            AND spec.project_id = binding.project_id
            AND spec.aggregate_type = 'GAME_SPEC'
            AND spec.state = 'APPROVED'
           JOIN deviludo.immutable_revisions plan
             ON plan.id = binding.test_plan_revision_id
            AND plan.tenant_id = binding.tenant_id
            AND plan.project_id = binding.project_id
            AND plan.aggregate_type = 'TEST_PLAN'
            AND plan.state = 'FROZEN'
            AND plan.payload_digest = binding.test_plan_digest
          WHERE binding.tenant_id = $1::uuid
            AND binding.project_id = $2::uuid
            AND binding.spec_revision_id = $3::uuid
            AND binding.test_plan_digest = $4
          FOR SHARE OF binding, spec, plan`,
        [input.tenantId, input.projectId, input.specRevisionId, input.testPlanDigest],
      );
      if (selected.rows.length !== 1) invalid();
      const row = selected.rows[0]!;
      if (row.spec_revision_id !== input.specRevisionId || row.spec_state !== "APPROVED"
        || !UUID.test(row.plan_revision_id) || row.plan_state !== "FROZEN"
        || row.payload_digest !== input.testPlanDigest || row.bound_digest !== input.testPlanDigest) invalid();
      let bytes: Buffer;
      try { bytes = Buffer.from(canonicalJson(row.payload), "utf8"); }
      catch { invalid(); }
      if (bytes.byteLength < 2 || bytes.byteLength > MAX_PLAN_BYTES
        || createHash("sha256").update(bytes).digest("hex") !== input.testPlanDigest) invalid();
      return bytes;
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.approved_test_plan_bindings')::text AS approved_test_plan_bindings,
                to_regclass('deviludo.immutable_revisions')::text AS immutable_revisions`,
      );
      const row = result.rows[0];
      if (row?.approved_test_plan_bindings !== "deviludo.approved_test_plan_bindings"
        || row.immutable_revisions !== "deviludo.immutable_revisions") invalid();
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
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

function invalid(): never {
  throw new Error("Artifact preparation frozen test plan is invalid");
}
