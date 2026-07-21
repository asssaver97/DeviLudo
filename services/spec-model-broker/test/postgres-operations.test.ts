import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { DeterministicLocalSpecModel } from "../../spec-dialogue/src/model";
import { PostgresSpecModelOperationStore } from "../src/postgres-operations";
import type { SpecModelProviderBinding } from "../src/contracts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const operationKey = "a".repeat(64);
const requestDigest = "b".repeat(64);
const claimToken = "44444444-4444-4444-8444-444444444444";
const generated = await new DeterministicLocalSpecModel().generate({
  operationKey, tenantId, projectId, conversationId, history: [], current: null, userMessage: "A tactics game",
});
const provider: SpecModelProviderBinding = Object.freeze({
  profileRevisionId: "profile-spec-r1", providerRevisionId: "provider-r1", credentialVersionId: "credential-v1",
  agent: "claude-code", protocol: "anthropic-messages", baseUrl: "https://api.example.com/v1",
  approvedPorts: Object.freeze([443]), authentication: "x-api-key", model: "claude-haiku-4-5-20251001",
  policyDigest: "c".repeat(64),
});

test("PostgreSQL generation store applies tenant RLS, completes and replays the strict result", async () => {
  const client = new FixtureClient();
  const store = new PostgresSpecModelOperationStore(pool(client));
  assert.deepEqual(await store.claim(claimInput()), { kind: "CLAIMED", claimToken });
  await store.complete({
    tenantId, operationKey, claimToken, result: generated,
    usage: { inputTokens: 100, outputTokens: 200 },
  });
  assert.deepEqual(await store.lookup({ tenantId, projectId, conversationId, operationKey, requestDigest }), {
    kind: "COMPLETED", result: generated,
  });
  assert.ok(client.statements.some((statement) => statement.includes("set_config('app.tenant_id'")));
  assert.ok(client.statements.some((statement) => statement.includes("ON CONFLICT (tenant_id, operation_key) DO NOTHING")));
  assert.equal(client.row?.state, "COMPLETED");
  assert.equal(JSON.stringify(client.row).includes("A tactics game"), true);
  assert.equal(JSON.stringify(client.row).includes("provider-key"), false);
});

test("PostgreSQL generation store rejects request drift and makes expired claims indeterminate", async () => {
  const client = new FixtureClient();
  const store = new PostgresSpecModelOperationStore(pool(client));
  await store.claim(claimInput());
  await assert.rejects(store.lookup({
    tenantId, projectId, conversationId, operationKey, requestDigest: "9".repeat(64),
  }), /operation is invalid/);
  client.row!.expired = true;
  assert.deepEqual(await store.lookup({ tenantId, projectId, conversationId, operationKey, requestDigest }), {
    kind: "INDETERMINATE",
  });
  assert.equal(client.row?.state, "INDETERMINATE");
});

test("PostgreSQL reconciliation records exact usage, releases one generation and replays idempotently", async () => {
  const client = new FixtureClient();
  const store = new PostgresSpecModelOperationStore(pool(client));
  await store.claim(claimInput());
  await store.abandon({ tenantId, operationKey, claimToken });
  const status = await store.lookupReconciliation(tenantId, operationKey);
  assert.equal(status?.dispatchGeneration, 1);
  const input = {
    operationKey: "d".repeat(64), tenantId, generationOperationKey: operationKey,
    action: "RECORD_USAGE" as const, evidenceDigest: "e".repeat(64),
    reconciledBy: "security-admin@example.com", inputTokens: 123, outputTokens: 45,
  };
  const receipt = await store.reconcile(input);
  assert.deepEqual(receipt.usage, { inputTokens: 123, outputTokens: 45 });
  assert.equal(receipt.state, "RELEASED");
  assert.deepEqual(await store.reconcile(input), receipt);
  assert.equal(client.row?.state, "RELEASED");
  assert.ok(client.statements.some((statement) => statement.includes("spec_model_generation_reconciliations")));
  await assert.rejects(store.reconcile({ ...input, evidenceDigest: "f".repeat(64) }), /conflicts with durable state/);
  assert.equal((await store.claim({ ...claimInput(), claimToken: "55555555-5555-4555-8555-555555555555" })).kind, "CLAIMED");
  assert.equal(client.row?.dispatch_generation, 2);
});

class FixtureClient implements PostgresWorkflowClient {
  statements: string[] = [];
  row: Record<string, unknown> | null = null;
  reconciliation: Record<string, unknown> | null = null;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.statements.push(text);
    if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config")) return result(1, []);
    if (text.includes("FROM deviludo.spec_conversations")) {
      return result(1, [{ id: conversationId, state: "DRAFT" }] as unknown as Row[]);
    }
    if (text.includes("INSERT INTO deviludo.spec_model_generation_operations")) {
      if (!this.row) {
        this.row = {
          tenant_id: values[0], project_id: values[1], conversation_id: values[2], operation_key: values[3],
          request_digest: values[4], profile_revision_id: values[5], provider_revision_id: values[6],
          credential_version_id: values[7], agent: values[8], protocol: values[9], base_url: values[10],
          approved_ports: values[11], authentication: values[12], model: values[13], policy_digest: values[14],
          state: "CLAIMED", claim_token: values[15], expired: false,
          result: null, result_digest: null, usage: null, dispatch_generation: 1,
          created_at: "2026-07-21T10:00:00.000Z",
        };
      }
      return result(1, []);
    }
    if (text.includes("FROM deviludo.spec_model_generation_operations") && text.includes("FOR UPDATE")) {
      return result(this.row ? 1 : 0, this.row ? [this.row as Row] : []);
    }
    if (text.includes("FROM deviludo.spec_model_generation_reconciliations")) {
      const matches = this.reconciliation?.reconciliation_operation_key === values[1];
      return result(matches ? 1 : 0, matches ? [this.reconciliation as Row] : []);
    }
    if (text.includes("INSERT INTO deviludo.spec_model_generation_reconciliations")) {
      if (this.reconciliation) return result(0, []);
      this.reconciliation = {
        tenant_id: values[0], reconciliation_operation_key: values[1], generation_operation_key: values[2],
        dispatch_generation: values[3], payload_digest: values[4], action: values[5], evidence_digest: values[6],
        reconciled_by: values[7], usage: JSON.parse(values[8] as string) as unknown,
        reconciled_at: "2026-07-21T10:01:00.000Z",
      };
      return result(1, []);
    }
    if (text.includes("SET state = 'COMPLETED'")) {
      if (!this.row || this.row.claim_token !== values[2]) return result(0, []);
      this.row.state = "COMPLETED";
      this.row.claim_token = null;
      this.row.expired = false;
      this.row.result = JSON.parse(values[3] as string) as unknown;
      this.row.result_digest = values[4];
      this.row.usage = JSON.parse(values[5] as string) as unknown;
      return result(1, []);
    }
    if (text.includes("SET state = 'INDETERMINATE'")) {
      if (!this.row) return result(0, []);
      this.row.state = "INDETERMINATE";
      this.row.claim_token = null;
      this.row.expired = false;
      return result(1, []);
    }
    if (text.includes("SET state = 'RELEASED'")) {
      if (!this.row || this.row.dispatch_generation !== values[2] || this.row.state !== "INDETERMINATE") return result(0, []);
      this.row.state = "RELEASED";
      return result(1, []);
    }
    if (text.includes("SET state = $4")) {
      if (!this.row || this.row.claim_token !== values[2]) return result(0, []);
      this.row.state = values[3];
      this.row.claim_token = null;
      return result(1, []);
    }
    if (text.includes("SET state = 'CLAIMED'")) {
      if (!this.row) return result(0, []);
      this.row.state = "CLAIMED";
      this.row.claim_token = values[2];
      this.row.expired = false;
      this.row.dispatch_generation = Number(this.row.dispatch_generation) + 1;
      return result(1, []);
    }
    if (text === "SELECT 1 AS ready") return result(1, [{ ready: 1 }] as unknown as Row[]);
    throw new Error(`Unexpected SQL: ${text}`);
  }
  release(): void {}
}

function claimInput() {
  return {
    tenantId, projectId, conversationId, operationKey, requestDigest, provider, claimToken, leaseSeconds: 180,
  };
}
function pool(client: PostgresWorkflowClient): PostgresWorkflowPool { return { async connect() { return client; } }; }
function result<Row extends Record<string, unknown>>(rowCount: number, rows: readonly Row[]): PostgresQueryResult<Row> {
  return { rowCount, rows };
}
