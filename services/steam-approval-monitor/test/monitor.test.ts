import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowActionCompletionPort, WorkflowActionCompletionReceipt } from "../../control-plane/src/workflow-action-completion-postgres";
import type { PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { PostgresReadinessFixture } from "../../temporal/test/postgres-readiness-fixture";
import {
  parseSteamExternalApprovalAttestation,
  steamExternalApprovalRequestDigest,
  type SteamExternalApprovalAttestation,
  type SteamExternalApprovalReceipt,
} from "../src/contracts";
import { createSteamApprovalMonitorHandler } from "../src/ingress-http";
import { PostgresSteamExternalApprovalStore } from "../src/postgres-store";
import {
  SteamExternalApprovalConflict,
  SteamExternalApprovalService,
  type SteamExternalApprovalClaim,
  type SteamExternalApprovalStore,
} from "../src/service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const workflowId = "delivery-22222222-2222-4222-8222-222222222222";
const outboxId = "44444444-4444-4444-8444-444444444444";
const verifier = "spiffe://deviludo.internal/connector/steam-approval-verifier";
const signalId = "steam-approval-55555555-5555-4555-8555-555555555555";
const claimToken = "66666666-6666-4666-8666-666666666666";
const observedAt = "2030-01-01T00:00:00.000Z";

function attestation(overrides: Partial<SteamExternalApprovalAttestation> = {}): SteamExternalApprovalAttestation {
  return parseSteamExternalApprovalAttestation({
    schemaVersion: "deviludo.steam-external-approval.v1",
    operationKey: "a".repeat(64), tenantId, projectId, actionId,
    gate: "VALVE_REVIEW", observationKind: "VALVE_REVIEW_APPROVED",
    steamAppId: "480", steamBuildId: "12345678",
    approvalId: "valve-review-receipt-001", observationDigest: "b".repeat(64),
    observedAt, ...overrides,
  });
}

function delivery(replayed = false): WorkflowActionCompletionReceipt {
  return Object.freeze({
    actionId, outboxId, workflowId, signalId, signalDigest: "c".repeat(64),
    state: "PENDING_DELIVERY", replayed,
  });
}

test("monitor emits one gate-bound server signal and persists the workflow receipt", async () => {
  const input = attestation();
  const claim = claimFor(input);
  const completionInputs: Parameters<WorkflowActionCompletionPort["complete"]>[0][] = [];
  const store = memoryStore({ claim });
  const completions: WorkflowActionCompletionPort = {
    async complete(value) { completionInputs.push(value); return delivery(); },
  };
  const receipt = await new SteamExternalApprovalService(store, completions).approve(input, verifier);
  assert.equal(receipt.replayed, false);
  assert.deepEqual(completionInputs, [{
    tenantId, projectId, workflowId, actionId,
    source: "STEAM_APPROVAL_MONITOR", sourceReceiptId: input.operationKey,
    signal: { signalId, type: "EXTERNAL_APPROVED", gate: "VALVE_REVIEW", approvalId: input.approvalId },
  }]);
  assert.equal(store.completed, 1);
  assert.equal(store.released, 0);
});

test("completed replay never sends another workflow signal", async () => {
  const input = attestation();
  const completed = receiptFor(input, delivery());
  let calls = 0;
  const service = new SteamExternalApprovalService(memoryStore({ completed }), {
    async complete() { calls += 1; return delivery(); },
  });
  const result = await service.approve(input, verifier);
  assert.equal(result.replayed, true);
  assert.equal(calls, 0);
});

test("request schema binds the observation kind to the current gate", () => {
  assert.throws(() => attestation({ observationKind: "FIRST_RELEASE_COMPLETED" }), /invalid/i);
  assert.throws(() => parseSteamExternalApprovalAttestation({ ...attestation(), workflowId }), /invalid/i);
});

test("PostgreSQL store derives current release authority under RLS and records no raw evidence", async () => {
  const client = new ApprovalSqlFixture();
  const store = new PostgresSteamExternalApprovalStore({ async connect() { return client; } }, {
    now: () => new Date(observedAt), claimId: () => claimToken, signalId: () => signalId,
  });
  const outcome = await store.begin({ attestation: attestation(), verifierSubject: verifier });
  assert.equal(outcome.kind, "CLAIMED");
  assert.ok(client.sql.some((value) => value.includes("SELECT set_config('app.tenant_id'")));
  const authority = client.sql.find((value) => value.includes("FROM deviludo.workflow_control_actions action")) ?? "";
  assert.match(authority, /JOIN deviludo\.steam_releases release/);
  assert.match(authority, /JOIN deviludo\.steam_build_receipts build/);
  assert.match(authority, /JOIN deviludo\.evidence_bundles evidence/);
  assert.match(authority, /FOR UPDATE OF action, release, build/);
  const insert = client.sql.find((value) => value.includes("INSERT INTO deviludo.steam_external_approval_observations")) ?? "";
  assert.match(insert, /observation_digest/);
  assert.doesNotMatch(insert, /raw_response|access_token|password|config_vdf/i);
  if (outcome.kind !== "CLAIMED") throw new Error("claim missing");
  const completed = await store.complete(outcome.claim, delivery());
  assert.equal(completed.delivery.signalId, signalId);
  assert.equal(client.row?.state, "COMPLETED");
  const replay = await store.begin({ attestation: attestation(), verifierSubject: verifier });
  assert.equal(replay.kind, "COMPLETED");
  if (replay.kind !== "COMPLETED") throw new Error("completed replay missing");
  assert.equal(replay.receipt.delivery.outboxId, outboxId);
});

test("new stale observations and out-of-order gates fail before workflow completion", async () => {
  const staleClient = new ApprovalSqlFixture();
  const staleStore = new PostgresSteamExternalApprovalStore({ async connect() { return staleClient; } }, {
    now: () => new Date("2030-01-01T01:00:00.000Z"), claimId: () => claimToken, signalId: () => signalId,
  });
  await assert.rejects(staleStore.begin({ attestation: attestation(), verifierSubject: verifier }), /invalid/i);
  assert.equal(staleClient.sql.some((value) => value.includes("FROM deviludo.workflow_control_actions action")), false);

  const wrongGate = new ApprovalSqlFixture({ releaseGate: "FIRST_RELEASE" });
  const store = new PostgresSteamExternalApprovalStore({ async connect() { return wrongGate; } }, {
    now: () => new Date(observedAt), claimId: () => claimToken, signalId: () => signalId,
  });
  await assert.rejects(store.begin({ attestation: attestation(), verifierSubject: verifier }), (error) =>
    error instanceof SteamExternalApprovalConflict && error.code === "STEAM_EXTERNAL_APPROVAL_CONFLICT");
});

test("mTLS ingress accepts only allow-listed Steam verifier identities", async () => {
  let approvals = 0;
  const handler = createSteamApprovalMonitorHandler({
    allowedVerifierSpiffeIds: new Set([verifier]),
    extractIdentity(socket) {
      return { spiffeId: String(socket), certificateFingerprint: "d".repeat(64),
        certificateSerial: "01", certificateNotAfter: "2031-01-01T00:00:00.000Z" };
    },
    service: {
      async approve(value, subject) {
        approvals += 1;
        assert.equal(subject, verifier);
        return receiptFor(parseSteamExternalApprovalAttestation(value), delivery());
      },
      async probe() {},
    },
  });
  const accepted = await handler({ method: "POST", path: "/v1/external-approvals",
    headers: { "content-type": "application/json" }, socket: verifier, rawBody: JSON.stringify(attestation()) });
  assert.equal(accepted.status, 201);
  const rejected = await handler({ method: "POST", path: "/v1/external-approvals",
    headers: { "content-type": "application/json" }, socket: "spiffe://evil.invalid/verifier", rawBody: JSON.stringify(attestation()) });
  assert.equal(rejected.status, 403);
  assert.equal(approvals, 1);
});

test("Steam approval readiness covers observation, release, evidence and signal delivery relations", async () => {
  const relations = [
    "e2e_attempts", "evidence_bundles", "steam_build_receipts", "steam_external_approval_observations",
    "steam_releases", "workflow_control_actions", "workflow_external_approval_receipts", "workflow_signal_outbox",
  ];
  const ready = new PostgresReadinessFixture();
  await new PostgresSteamExternalApprovalStore(ready).probe();
  assert.deepEqual(ready.observedRelations(), relations);
  assert.equal(ready.releases, 1);

  const missing = new PostgresReadinessFixture("workflow_signal_outbox");
  await assert.rejects(new PostgresSteamExternalApprovalStore(missing).probe());
  assert.equal(missing.releases, 1);
});

function claimFor(input: SteamExternalApprovalAttestation): SteamExternalApprovalClaim {
  return Object.freeze({ claimToken, requestDigest: steamExternalApprovalRequestDigest(input), verifierSubject: verifier,
    attestation: input, workflowId, signalId });
}
function receiptFor(input: SteamExternalApprovalAttestation, result: WorkflowActionCompletionReceipt): SteamExternalApprovalReceipt {
  return Object.freeze({ schemaVersion: "deviludo.steam-external-approval-receipt.v1", operationKey: input.operationKey,
    actionId, workflowId, gate: input.gate, approvalId: input.approvalId,
    observationDigest: input.observationDigest, observedAt: input.observedAt, verifierSubject: verifier,
    delivery: result, replayed: result.replayed });
}
function memoryStore(options: { claim?: SteamExternalApprovalClaim; completed?: SteamExternalApprovalReceipt }) {
  const result: SteamExternalApprovalStore & { completed: number; released: number } = {
    completed: 0, released: 0,
    async begin() { return options.completed ? { kind: "COMPLETED", receipt: options.completed }
      : { kind: "CLAIMED", claim: options.claim! }; },
    async complete(claim, result) { this.completed += 1; return receiptFor(claim.attestation, result); },
    async release() { this.released += 1; }, async probe() {},
  };
  return result;
}

class ApprovalSqlFixture implements PostgresWorkflowClient {
  readonly sql: string[] = [];
  row: Record<string, unknown> | null = null;
  constructor(private readonly options: { releaseGate?: string } = {}) {}
  async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.sql.push(text);
    if (text.includes("FROM deviludo.steam_external_approval_observations")) {
      return result(this.row ? [this.row as Row] : []);
    }
    if (text.includes("FROM deviludo.workflow_control_actions action")) {
      const gate = this.options.releaseGate ?? "VALVE_REVIEW";
      return result([{
        action_id: actionId, workflow_id: workflowId, action_operation: "WAIT_FOR_EXTERNAL_APPROVAL",
        action_status: "WAITING", action_binding: { state: "EXTERNAL_APPROVAL_REQUIRED",
          externalGate: gate, steamBuildId: "12345678", evidenceBundleId: "77777777-7777-4777-8777-777777777777" },
        release_id: "88888888-8888-4888-8888-888888888888", release_state: "EXTERNAL_APPROVAL_REQUIRED",
        release_gate: gate, release_app_id: "480", release_target_matrix: ["linux", "windows"],
        build_receipt_id: "99999999-9999-4999-8999-999999999999", build_state: "EXTERNAL_APPROVAL_REQUIRED",
        build_app_id: "480", build_id: "12345678", install_evidence_digest: "e".repeat(64),
        evidence_id: "77777777-7777-4777-8777-777777777777", evidence_digest: "e".repeat(64),
        evidence_status: "PASSED", evidence_invalidated_at: null, attempt_state: "PASSED",
        attempt_mode: "STEAM_CLEAN_INSTALL", attempt_workflow_id: workflowId,
        attempt_target_matrix: ["linux", "windows"],
      } as unknown as Row]);
    }
    if (text.includes("INSERT INTO deviludo.steam_external_approval_observations")) {
      this.row = { operation_key: values[0], request_digest: values[1], tenant_id: values[2], project_id: values[3],
        action_id: values[4], workflow_id: values[5], verifier_subject: values[6], gate: values[7],
        observation_kind: values[8], steam_app_id: values[9], steam_build_id: values[10], approval_id: values[11],
        observation_digest: values[12], observed_at: values[13], signal_id: values[14], state: "PENDING",
        claim_token: values[15], claim_active: true, receipt: null };
      return result([], 1);
    }
    if (text.includes("SET state = 'COMPLETED'")) {
      this.row = { ...this.row, state: "COMPLETED", claim_token: null, claim_active: false,
        receipt: JSON.parse(String(values[5])) as unknown };
      return result([], 1);
    }
    return result([]);
  }
  release() {}
}
function result<Row extends Record<string, unknown>>(rows: readonly Row[], rowCount = rows.length) {
  return { rows, rowCount };
}
