import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { parseSpecModelResult, type SpecApprovalCommand } from "../src/contracts";
import { PostgresSpecDialogueStore } from "../src/postgres-store";
import { specDigest, SpecDialogueToolchainUnavailable } from "../src/store";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const specAggregateId = "44444444-4444-4444-8444-444444444444";
const planAggregateId = "55555555-5555-4555-8555-555555555555";
const draftSpecId = "66666666-6666-4666-8666-666666666666";
const draftPlanId = "77777777-7777-4777-8777-777777777777";
const toolchainId = "88888888-8888-4888-8888-888888888888";

const result = parseSpecModelResult({
  assistantMessage: "规格已完整，可以批准。",
  completeness: 100,
  openQuestions: [],
  spec: {
    title: "批准链路样例",
    elevatorPitch: "一局十分钟的桌面单机游戏",
    genre: "2D 策略",
    godotVersion: "4.6.2",
    targetPlatforms: ["linux", "windows"],
    features: ["核心循环"],
    acceptanceCriteria: [{ id: "core-loop", description: "完成一次核心循环", required: true }],
  },
  testPlan: {
    version: "godot-testkit-1.0.0",
    scenarios: ["核心循环"],
    minimumFps: 60,
    maxCrashCount: 0,
  },
});

const draftSpecPayload = {
  schemaVersion: "deviludo.game-spec.v1",
  conversationId,
  revision: 1,
  spec: result.spec,
};
const draftPlanPayload = {
  schemaVersion: "deviludo.test-plan.v1",
  conversationId,
  revision: 1,
  testPlan: result.testPlan,
};
const toolchainPayload = {
  schemaVersion: "deviludo.runner-toolchain.v1",
  requiredGodotVersion: "4.6.2",
  godotTestKitDigest: "1".repeat(64),
  exportTemplates: { linux: "2".repeat(64), windows: "3".repeat(64) },
  buildManifestDigest: "4".repeat(64),
  sbomDigest: "5".repeat(64),
  vulnerabilityScanDigest: "6".repeat(64),
  assetLicenseLedgerDigest: "7".repeat(64),
};

const command: SpecApprovalCommand = Object.freeze({
  operationKey: "a".repeat(64),
  tenantId,
  projectId,
  conversationId,
  actorId: "user-1",
  expectedRevision: 1,
  specRevisionId: draftSpecId,
  testPlanRevisionId: draftPlanId,
});

class ApprovalClient implements PostgresWorkflowClient {
  readonly statements: string[] = [];
  readonly immutableInserts: unknown[][] = [];
  bindingValues: readonly unknown[] | null = null;
  claimToken = "";
  released = false;
  authorized = true;

  constructor(private readonly hasToolchain = true) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.statements.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config('app.tenant_id'")) {
      return response<Row>([], text === "ROLLBACK" ? 0 : 1);
    }
    if (text.includes("FROM deviludo.projects project")) {
      assert.deepEqual(values, [tenantId, projectId, command.actorId]);
      assert.match(text, /actor\.id::text = \$3 AND actor\.status = 'ACTIVE'/);
      assert.match(text, /membership\.role IN \('TenantAdmin', 'ProjectOwner'\)/);
      return response<Row>(this.authorized ? [{ id: projectId }] : []);
    }
    if (text.includes("INSERT INTO deviludo.spec_dialogue_operations")) {
      this.claimToken = String(values[7]);
      return response<Row>([], 1);
    }
    if (text.includes("SELECT request_digest, state, claim_token::text")) {
      return response<Row>([{
        request_digest: specDigest(command),
        state: "CLAIMED",
        claim_token: this.claimToken,
        claim_active: true,
        response: null,
      }]);
    }
    if (text.includes("FROM deviludo.spec_conversations") && text.includes("FOR UPDATE")) {
      return response<Row>([{
        id: conversationId,
        tenant_id: tenantId,
        project_id: projectId,
        spec_aggregate_id: specAggregateId,
        test_plan_aggregate_id: planAggregateId,
        current_spec_revision_id: draftSpecId,
        current_test_plan_revision_id: draftPlanId,
        current_metadata: {
          assistantMessage: result.assistantMessage,
          completeness: result.completeness,
          openQuestions: result.openQuestions,
        },
        version: 1,
        state: "DRAFT",
      }]);
    }
    if (text.includes("FROM deviludo.immutable_revisions")) {
      return response<Row>([
        {
          id: draftSpecId,
          project_id: projectId,
          aggregate_type: "GAME_SPEC",
          aggregate_id: specAggregateId,
          revision: 1,
          state: "DRAFT",
          payload: draftSpecPayload,
          payload_digest: specDigest(draftSpecPayload),
        },
        {
          id: draftPlanId,
          project_id: projectId,
          aggregate_type: "TEST_PLAN",
          aggregate_id: planAggregateId,
          revision: 1,
          state: "DRAFT",
          payload: draftPlanPayload,
          payload_digest: specDigest(draftPlanPayload),
        },
      ]);
    }
    if (text.includes("FROM deviludo.runner_toolchain_revisions")) {
      return response<Row>(this.hasToolchain ? [{
        id: toolchainId,
        revision: 3,
        payload: toolchainPayload,
        payload_digest: specDigest(toolchainPayload),
      }] : []);
    }
    if (text.includes("INSERT INTO deviludo.immutable_revisions")) {
      this.immutableInserts.push([...values]);
      return response<Row>([], 1);
    }
    if (text.includes("INSERT INTO deviludo.approved_test_plan_bindings")) {
      this.bindingValues = [...values];
      return response<Row>([], 1);
    }
    if (text.includes("UPDATE deviludo.spec_conversations")) {
      return response<Row>([{ updated_at: "2026-07-21T12:00:00.000Z" }]);
    }
    if (text.includes("UPDATE deviludo.spec_dialogue_operations")) return response<Row>([], 1);
    throw new Error(`Unexpected SQL in specification approval test: ${text}`);
  }

  release(): void { this.released = true; }
}

test("PostgreSQL approval resolves and atomically binds the newest compatible Runner toolchain", async () => {
  const client = new ApprovalClient();
  const pool: PostgresWorkflowPool = { async connect() { return client; } };
  const receipt = await new PostgresSpecDialogueStore(pool).approve(command);

  assert.equal(receipt.state, "APPROVED");
  assert.deepEqual(receipt.targetMatrix, ["linux", "windows"]);
  assert.ok(client.bindingValues);
  assert.deepEqual(client.bindingValues?.slice(0, 2), [tenantId, projectId]);
  assert.deepEqual(client.bindingValues?.slice(5, 10), [
    ["linux", "windows"],
    "4.6.2",
    toolchainId,
    specDigest(toolchainPayload),
    "user-1",
  ]);
  assert.equal(client.immutableInserts.length, 2);
  assert.match(client.statements[2] ?? "", /FROM deviludo\.projects project/);
  assert.equal(client.statements.at(-1), "COMMIT");
  assert.equal(client.released, true);
});

test("PostgreSQL approval rolls back before freezing revisions when no compatible toolchain exists", async () => {
  const client = new ApprovalClient(false);
  const pool: PostgresWorkflowPool = { async connect() { return client; } };
  await assert.rejects(
    new PostgresSpecDialogueStore(pool).approve(command),
    (error) => error instanceof SpecDialogueToolchainUnavailable
      && error.code === "RUNNER_TOOLCHAIN_UNAVAILABLE",
  );
  assert.equal(client.immutableInserts.length, 0);
  assert.equal(client.bindingValues, null);
  assert.equal(client.statements.at(-1), "ROLLBACK");
  assert.equal(client.released, true);
});

test("PostgreSQL approval rejects a read-only actor before creating an operation", async () => {
  const client = new ApprovalClient();
  client.authorized = false;
  const pool: PostgresWorkflowPool = { async connect() { return client; } };
  await assert.rejects(new PostgresSpecDialogueStore(pool).approve(command), /PostgreSQL binding is invalid/);
  assert.equal(client.statements.some((statement) => statement.includes("INSERT INTO deviludo.spec_dialogue_operations")), false);
  assert.equal(client.immutableInserts.length, 0);
  assert.equal(client.statements.at(-1), "ROLLBACK");
  assert.equal(client.released, true);
});

test("PostgreSQL dialogue readiness requires every authorization, revision and toolchain table", async () => {
  const tables = [
    "projects", "users", "tenant_memberships", "spec_conversations", "spec_dialogue_operations",
    "spec_conversation_messages", "immutable_revisions", "runner_toolchain_revisions",
    "approved_test_plan_bindings",
  ] as const;
  let missing: string | null = null;
  let released = 0;
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string) {
      assert.match(sql, /to_regclass\('deviludo\.approved_test_plan_bindings'\)/);
      const row = Object.fromEntries(tables.map((table) => [table, `deviludo.${table}`])) as Record<string, unknown>;
      if (missing) row[missing] = null;
      return response<Row>([row]);
    },
    release() { released += 1; },
  };
  const store = new PostgresSpecDialogueStore({ async connect() { return client; } });
  await store.probe();
  missing = "runner_toolchain_revisions";
  await assert.rejects(store.probe(), /PostgreSQL binding is invalid/);
  assert.equal(released, 2);
});

function response<Row extends Record<string, unknown>>(
  rows: readonly Record<string, unknown>[],
  rowCount = rows.length,
): PostgresQueryResult<Row> {
  return { rows: rows as readonly Row[], rowCount };
}
