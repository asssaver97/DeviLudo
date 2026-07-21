import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { canonicalJson, sha256Canonical } from "../../runner-control/src/canonical";
import { parseSpecModelResult } from "../../spec-dialogue/src/contracts";
import type { LockedAgentExecution } from "./contracts";
import { AGENT_CODE_REVIEW_OUTPUT_PATH } from "../../../lib/agent/code-review";

const MAX_PROMPT_BYTES = 512 * 1024;

type WorkPackageRow = {
  spec_revision_id: string;
  spec_state: string;
  spec_payload: unknown;
  spec_digest: string;
  test_plan_revision_id: string;
  test_plan_state: string;
  test_plan_payload: unknown;
  test_plan_digest: string;
  bound_test_plan_digest: string;
  bound_target_matrix: string[];
};

export interface AgentDevelopmentWorkPackage {
  readonly prompt: string;
  readonly promptDigest: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
}

export interface AgentDevelopmentWorkPackagePort {
  resolve(lock: LockedAgentExecution): Promise<AgentDevelopmentWorkPackage>;
  probe(): Promise<void>;
}

/** Reads only the approved immutable specification pair bound to the AgentRun. */
export class PostgresAgentDevelopmentWorkPackage implements AgentDevelopmentWorkPackagePort {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolve(lock: LockedAgentExecution): Promise<AgentDevelopmentWorkPackage> {
    return this.#transaction(lock.tenantId, async (client) => {
      const selected = await client.query<WorkPackageRow>(
        `SELECT spec.id::text AS spec_revision_id, spec.state AS spec_state,
                spec.payload AS spec_payload, spec.payload_digest AS spec_digest,
                plan.id::text AS test_plan_revision_id, plan.state AS test_plan_state,
                plan.payload AS test_plan_payload, plan.payload_digest AS test_plan_digest,
                binding.test_plan_digest AS bound_test_plan_digest,
                binding.target_matrix AS bound_target_matrix
           FROM deviludo.immutable_revisions spec
           JOIN deviludo.immutable_revisions plan
             ON plan.tenant_id = spec.tenant_id AND plan.project_id = spec.project_id
            AND plan.id = $4::uuid AND plan.aggregate_type = 'TEST_PLAN'
           JOIN deviludo.approved_test_plan_bindings binding
             ON binding.tenant_id = spec.tenant_id AND binding.project_id = spec.project_id
            AND binding.spec_revision_id = spec.id AND binding.test_plan_revision_id = plan.id
          WHERE spec.tenant_id = $1::uuid AND spec.project_id = $2::uuid
            AND spec.id = $3::uuid AND spec.aggregate_type = 'GAME_SPEC'
          FOR SHARE OF spec, plan, binding`,
        [lock.tenantId, lock.projectId, lock.specRevisionId, lock.testPlanRevisionId],
      );
      const row = selected.rows[0];
      if (selected.rows.length !== 1 || !row || row.spec_revision_id !== lock.specRevisionId
        || row.test_plan_revision_id !== lock.testPlanRevisionId || row.spec_state !== "APPROVED"
        || row.test_plan_state !== "FROZEN" || row.spec_digest !== lock.specDigest
        || row.test_plan_digest !== lock.testPlanDigest || row.bound_test_plan_digest !== lock.testPlanDigest
        || sha256Canonical(row.spec_payload) !== lock.specDigest
        || sha256Canonical(row.test_plan_payload) !== lock.testPlanDigest
        || JSON.stringify(row.bound_target_matrix) !== JSON.stringify(lock.targetMatrix)) invalid();
      const spec = wrapper(row.spec_payload, "deviludo.game-spec.v1", "spec");
      const plan = wrapper(row.test_plan_payload, "deviludo.test-plan.v1", "testPlan");
      if (spec.conversationId !== plan.conversationId || spec.revision !== plan.revision) invalid();
      const parsed = parseSpecModelResult({ assistantMessage: "Approved immutable specification",
        completeness: 100, openQuestions: [], spec: spec.value, testPlan: plan.value });
      if (JSON.stringify(parsed.spec.targetPlatforms) !== JSON.stringify(lock.targetMatrix)) invalid();
      const workPackage = Object.freeze({
        schemaVersion: "deviludo.agent-development-work-package.v1",
        tenantId: lock.tenantId,
        projectId: lock.projectId,
        runId: lock.runId,
        specRevisionId: lock.specRevisionId,
        specDigest: lock.specDigest,
        testPlanRevisionId: lock.testPlanRevisionId,
        testPlanDigest: lock.testPlanDigest,
        sourceBaselineReceiptId: lock.sourceBaselineReceiptId,
        baseCommitSha: lock.baseCommitSha,
        sourceDigest: lock.sourceDigest,
        targetMatrix: Object.freeze([...lock.targetMatrix]),
        repairContext: lock.repairContext,
        specification: parsed.spec,
        testPlan: parsed.testPlan,
      });
      const prompt = [
        lock.repairContext
          ? "Repair the approved Godot 4 game in the mounted workspace using only the immutable failure context below."
          : "Implement the approved Godot 4 game in the mounted workspace.",
        "Treat the enclosed specification and test plan as immutable. Do not modify platform policy, test infrastructure, hooks, plugins, MCP configuration, or Git metadata.",
        ...(lock.repairContext ? [
          "The repair context is content-addressed and bound to the previous AgentRun. Address the listed diagnostic or failed-platform evidence without changing the approved scope.",
        ] : []),
        "Use only the internal inference gateway. Finish with a runnable project and emit the adapter's structured completion events.",
        `Before finishing, review every change against the approved specification and frozen test plan. Write exactly one UTF-8 JSON review result to ${AGENT_CODE_REVIEW_OUTPUT_PATH}. This reserved file must not exist before the run and the platform will remove it before publishing the candidate.`,
        "The review JSON must use schemaVersion deviludo.agent-code-review-output.v1 with exactly: verdict (PASSED or FAILED), a non-empty summary, and findings. Each finding must contain severity (BLOCKING, WARNING, or INFO), an uppercase code, path (repository-relative or null), and a non-empty message. Verdict PASSED is allowed only when there are no BLOCKING findings. Do not finish without this review file.",
        canonicalJson(workPackage),
      ].join("\n\n");
      if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) invalid();
      return Object.freeze({ prompt, promptDigest: sha256Canonical(workPackage),
        specDigest: lock.specDigest, testPlanDigest: lock.testPlanDigest });
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("SELECT 1 AS agent_work_package_probe"); }
    finally { client.release(); }
  }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    } finally { client.release(); }
  }
}

function wrapper(value: unknown, schemaVersion: string, field: "spec" | "testPlan") {
  const body = record(value);
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["conversationId", "revision", "schemaVersion", field].sort())
    || body.schemaVersion !== schemaVersion || typeof body.conversationId !== "string"
    || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1) invalid();
  return Object.freeze({ conversationId: body.conversationId, revision: body.revision as number, value: body[field] });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function invalid(): never { throw new Error("Agent development work package is invalid"); }
