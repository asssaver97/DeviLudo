import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowActionCompletionPort } from "../../control-plane/src/workflow-action-completion-postgres";
import type { PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { specDigest } from "../../spec-dialogue/src/store";
import { createUserAcceptanceHandler } from "../src/ingress-http";
import {
  CandidateAcceptanceConflict,
  CandidateAcceptanceRequestError,
  CandidateAcceptanceService,
  PostgresCandidateAcceptanceStore,
  type CandidateAcceptanceDecision,
  type CandidateAcceptanceReceipt,
  type CandidateAcceptanceStore,
} from "../src/candidate-acceptance";

const decision: CandidateAcceptanceDecision = Object.freeze({
  operationKey: "a".repeat(64),
  tenantId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  actorId: "user-1",
  workflowId: "delivery-001",
  actionId: "33333333-3333-4333-8333-333333333333",
  specRevisionId: "44444444-4444-4444-8444-444444444444",
  candidateReceiptId: "55555555-5555-4555-8555-555555555555",
  candidateCommitSha: "b".repeat(40),
  draftPullRequest: 18,
  evidenceBundleId: "66666666-6666-4666-8666-666666666666",
  signalId: "accepted-signal-001",
  acceptedAt: "2026-07-18T12:00:00.000Z",
});

test("candidate acceptance mTLS ingress dispatches the empty authority-free command", async () => {
  const service = new CandidateAcceptanceService(new MemoryAcceptanceStore(), completionPort());
  const identity = {
    spiffeId: "spiffe://deviludo.internal/web",
    certificateFingerprint: "d".repeat(64),
    certificateSerial: "01",
    certificateNotAfter: "2030-01-01T00:00:00.000Z",
  };
  const handler = createUserAcceptanceHandler({
    service: { async submit() { throw new Error("unused"); }, async probe() {} },
    acceptance: service,
    cancellation: { async cancel() { throw new Error("unused"); }, async probe() {} },
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  const response = await handler({
    method: "POST",
    path: "/v1/candidate-acceptance",
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: JSON.stringify(command),
  });
  assert.equal(response.status, 201);
  assert.equal((response.body.data as CandidateAcceptanceReceipt).state, "MERGE_QUEUED");
});

test("PostgreSQL candidate acceptance derives candidate, PR and evidence under tenant RLS", async () => {
  let inserted: readonly unknown[] | undefined;
  let authorityValues: readonly unknown[] | undefined;
  const statements: string[] = [];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes("FROM deviludo.user_candidate_acceptances")) {
        if (!inserted) return rows<Row>([]);
        return rows<Row>([{
          operation_key: command.operationKey,
          tenant_id: command.tenantId,
          project_id: command.projectId,
          actor_id: command.actorId,
          request_digest: specDigest(command),
          workflow_id: decision.workflowId,
          action_id: decision.actionId,
          spec_revision_id: decision.specRevisionId,
          candidate_receipt_id: decision.candidateReceiptId,
          candidate_commit_sha: decision.candidateCommitSha,
          draft_pull_request: decision.draftPullRequest,
          evidence_bundle_id: decision.evidenceBundleId,
          signal_id: inserted[12],
          state: "PENDING_DELIVERY",
          accepted_at: inserted[13],
          completion_receipt: null,
        }]);
      }
      if (sql.includes("FROM deviludo.workflow_control_actions action")) {
        authorityValues = values;
        return rows<Row>([{
          workflow_id: decision.workflowId,
          action_id: decision.actionId,
          spec_revision_id: decision.specRevisionId,
          candidate_receipt_id: decision.candidateReceiptId,
          candidate_commit_sha: decision.candidateCommitSha,
          pull_request_number: decision.draftPullRequest,
          evidence_bundle_id: decision.evidenceBundleId,
        }]);
      }
      if (sql.includes("INSERT INTO deviludo.user_candidate_acceptances")) {
        inserted = values;
        return result<Row>(1);
      }
      return result<Row>(0);
    },
    release() { statements.push("RELEASE"); },
  };
  const outcome = await new PostgresCandidateAcceptanceStore({ async connect() { return client; } }).begin(command);
  assert.equal(outcome.kind, "PENDING_DELIVERY");
  if (outcome.kind !== "PENDING_DELIVERY") throw new Error("decision missing");
  assert.equal(outcome.decision.candidateCommitSha, decision.candidateCommitSha);
  assert.equal(outcome.decision.evidenceBundleId, decision.evidenceBundleId);
  assert.equal(inserted?.[6], decision.actionId);
  assert.match(statements[1] ?? "", /set_config\('app\.tenant_id'/);
  const authority = statements.find((statement) => statement.includes("FROM deviludo.workflow_control_actions action")) ?? "";
  assert.match(authority, /actor\.id::text = \$3 AND actor\.status = 'ACTIVE'/);
  assert.match(authority, /membership\.role IN \('TenantAdmin', 'ProjectOwner'\)/);
  assert.deepEqual(authorityValues, [command.tenantId, command.projectId, command.actorId]);
});

test("PostgreSQL candidate readiness requires exact actor, candidate and E2E evidence tables", async () => {
  const tables = [
    "workflow_control_actions", "users", "tenant_memberships", "immutable_revisions",
    "github_candidate_receipts", "e2e_attempts", "evidence_bundles", "user_candidate_acceptances",
  ] as const;
  let missing: string | null = null;
  let released = 0;
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string) {
      assert.match(sql, /to_regclass\('deviludo\.evidence_bundles'\)/);
      const row = Object.fromEntries(tables.map((table) => [table, `deviludo.${table}`])) as Record<string, unknown>;
      if (missing) row[missing] = null;
      return rows<Row>([row]);
    },
    release() { released += 1; },
  };
  const store = new PostgresCandidateAcceptanceStore({ async connect() { return client; } });
  await store.probe();
  missing = "github_candidate_receipts";
  await assert.rejects(store.probe(), /authority is invalid/);
  assert.equal(released, 2);
});

const command = Object.freeze({
  operationKey: decision.operationKey,
  tenantId: decision.tenantId,
  projectId: decision.projectId,
  actorId: decision.actorId,
});

test("candidate acceptance emits only a server-derived USER_ACCEPTED signal", async () => {
  const inputs: Parameters<WorkflowActionCompletionPort["complete"]>[0][] = [];
  const store = new MemoryAcceptanceStore();
  const service = new CandidateAcceptanceService(store, {
    async complete(input) {
      inputs.push(input);
      return {
        actionId: decision.actionId,
        outboxId: "77777777-7777-4777-8777-777777777777",
        workflowId: decision.workflowId,
        signalId: decision.signalId,
        signalDigest: "c".repeat(64),
        state: "PENDING_DELIVERY",
        replayed: false,
      };
    },
  });
  const receipt = await service.accept(command);
  assert.equal(receipt.state, "MERGE_QUEUED");
  assert.equal(store.completed, 1);
  assert.deepEqual(inputs[0]?.signal, { signalId: decision.signalId, type: "USER_ACCEPTED" });
  assert.equal(inputs[0]?.source, "USER_ACCEPTANCE_SERVICE");
  assert.equal(inputs[0]?.sourceReceiptId, decision.operationKey);
  assert.equal("candidateCommitSha" in command, false);
  assert.equal("evidenceBundleId" in command, false);
});

test("candidate acceptance rejects injected browser authority and explicit conflicts", async () => {
  const service = new CandidateAcceptanceService(new MemoryAcceptanceStore(), {
    async complete() { throw new Error("unused"); },
  });
  await assert.rejects(
    service.accept({ ...command, evidenceBundleId: decision.evidenceBundleId }),
    CandidateAcceptanceRequestError,
  );
  await assert.rejects(
    new CandidateAcceptanceService({
      async begin() { return { kind: "CONFLICT" }; },
      async complete() { throw new Error("unused"); },
      async probe() {},
    }, { async complete() { throw new Error("unused"); } }).accept(command),
    CandidateAcceptanceConflict,
  );
});

test("a completed acceptance replays without another workflow completion", async () => {
  const delivery = {
    actionId: decision.actionId,
    outboxId: "77777777-7777-4777-8777-777777777777",
    workflowId: decision.workflowId,
    signalId: decision.signalId,
    signalDigest: "c".repeat(64),
    state: "DELIVERED" as const,
    replayed: true,
  };
  const receipt: CandidateAcceptanceReceipt = Object.freeze({ ...decision, state: "MERGE_QUEUED", delivery });
  let completionCalls = 0;
  const service = new CandidateAcceptanceService({
    async begin() { return { kind: "COMPLETED", receipt }; },
    async complete() { throw new Error("unused"); },
    async probe() {},
  }, { async complete() { completionCalls += 1; throw new Error("unused"); } });
  assert.deepEqual(await service.accept(command), receipt);
  assert.equal(completionCalls, 0);
});

class MemoryAcceptanceStore implements CandidateAcceptanceStore {
  completed = 0;
  async begin() { return Object.freeze({ kind: "PENDING_DELIVERY" as const, decision }); }
  async complete(value: CandidateAcceptanceDecision, delivery: CandidateAcceptanceReceipt["delivery"]) {
    this.completed += 1;
    return Object.freeze({ ...value, state: "MERGE_QUEUED" as const, delivery });
  }
  async probe() {}
}

function completionPort(): WorkflowActionCompletionPort {
  return {
    async complete() {
      return {
        actionId: decision.actionId,
        outboxId: "77777777-7777-4777-8777-777777777777",
        workflowId: decision.workflowId,
        signalId: decision.signalId,
        signalDigest: "c".repeat(64),
        state: "PENDING_DELIVERY",
        replayed: false,
      };
    },
  };
}

function rows<Row extends Record<string, unknown>>(values: readonly Record<string, unknown>[]) {
  return { rowCount: values.length, rows: values as readonly Row[] };
}

function result<Row extends Record<string, unknown>>(rowCount: number) {
  return { rowCount, rows: [] as readonly Row[] };
}
