import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowActionCompletionPort } from "../../control-plane/src/workflow-action-completion-postgres";
import { parseSpecModelResult } from "../../spec-dialogue/src/contracts";
import type { SpecDialogueModel } from "../../spec-dialogue/src/model";
import { specDigest } from "../../spec-dialogue/src/store";
import type { PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { createUserAcceptanceHandler } from "../src/ingress-http";
import type {
  UserFeedbackClaim,
  UserFeedbackDraft,
  UserFeedbackReceipt,
  UserFeedbackStore,
} from "../src/contracts";
import { UserAcceptanceService, UserFeedbackConflict } from "../src/service";
import { PostgresUserFeedbackStore } from "../src/postgres-store";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const previousConversationId = "44444444-4444-4444-8444-444444444444";
const previousSpecRevisionId = "55555555-5555-4555-8555-555555555555";
const previousTestPlanRevisionId = "66666666-6666-4666-8666-666666666666";
const nextConversationId = "77777777-7777-4777-8777-777777777777";
const nextSpecRevisionId = "88888888-8888-4888-8888-888888888888";
const nextTestPlanRevisionId = "99999999-9999-4999-8999-999999999999";
const evidenceInvalidationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const outboxId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const command = Object.freeze({
  operationKey: "c".repeat(64),
  tenantId,
  projectId,
  actorId: "user-1",
  feedback: "降低前五分钟的风暴频率，并增加清晰的新手提示。",
});

const current = parseSpecModelResult({
  assistantMessage: "规格已冻结。",
  completeness: 100,
  openQuestions: [],
  spec: {
    title: "群岛风暴",
    elevatorPitch: "十分钟一局的 2D 航海生存游戏",
    genre: "2D 生存",
    godotVersion: "4.5.0",
    targetPlatforms: ["linux", "windows"],
    features: ["核心循环"],
    acceptanceCriteria: [{ id: "loop", description: "可完成一局", required: true }],
  },
  testPlan: {
    version: "godot-testkit-1.0.0",
    scenarios: ["核心循环"],
    minimumFps: 60,
    maxCrashCount: 0,
  },
});

test("feedback creates one next draft before completing the authoritative workflow action", async () => {
  const fixture = buildFixture();
  const receipt = await fixture.service.submit(command);
  assert.equal(fixture.modelCalls, 1);
  assert.equal(fixture.store.createdDrafts, 1);
  assert.equal(fixture.store.completedDrafts, 1);
  assert.equal(receipt.snapshot.revision, 6);
  assert.equal(receipt.snapshot.specRevisionId, nextSpecRevisionId);
  assert.equal(receipt.state, "AWAITING_SPEC_APPROVAL");
  assert.equal(fixture.completionInputs.length, 1);
  assert.deepEqual(fixture.completionInputs[0]!.signal, {
    signalId: "feedback-signal-001",
    type: "USER_FEEDBACK",
    nextSpecRevisionId,
    evidenceInvalidationId,
  });
  assert.equal(fixture.completionInputs[0]!.source, "USER_ACCEPTANCE_SERVICE");
  assert.equal(fixture.completionInputs[0]!.sourceReceiptId, command.operationKey);
});

test("model failure only releases generation and never invalidates evidence", async () => {
  const fixture = buildFixture({ modelFailure: true });
  await assert.rejects(fixture.service.submit(command), /model unavailable/);
  assert.equal(fixture.store.releases, 1);
  assert.equal(fixture.store.createdDrafts, 0);
  assert.equal(fixture.completionInputs.length, 0);
});

test("a committed draft retries completion without regenerating model output", async () => {
  const fixture = buildFixture({ beginWithDraft: true });
  const receipt = await fixture.service.submit(command);
  assert.equal(fixture.modelCalls, 0);
  assert.equal(fixture.store.createdDrafts, 0);
  assert.equal(fixture.completionInputs.length, 1);
  assert.equal(receipt.snapshot.conversationId, nextConversationId);
});

test("busy and conflicting feedback commands are explicit", async () => {
  for (const [kind, code] of [["BUSY", "USER_FEEDBACK_BUSY"], ["CONFLICT", "USER_FEEDBACK_CONFLICT"]] as const) {
    const fixture = buildFixture({ beginKind: kind });
    await assert.rejects(
      fixture.service.submit(command),
      (error) => error instanceof UserFeedbackConflict && error.code === code,
    );
  }
});

test("production feedback ingress requires an allow-listed mTLS workload", async () => {
  const fixture = buildFixture();
  const identity = {
    spiffeId: "spiffe://deviludo.internal/web",
    certificateFingerprint: "a".repeat(64),
    certificateSerial: "01",
    certificateNotAfter: "2030-01-01T00:00:00.000Z",
  };
  const allowed = createUserAcceptanceHandler({
    service: fixture.service,
    acceptance: unusedAcceptance(),
    cancellation: unusedCancellation(),
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  const response = await allowed({
    method: "POST",
    path: "/v1/user-feedback",
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: JSON.stringify(command),
  });
  assert.equal(response.status, 201);
  const injectedAuthority = await allowed({
    method: "POST",
    path: "/v1/user-feedback",
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: JSON.stringify({ ...command, actionId }),
  });
  assert.equal(injectedAuthority.status, 400);
  const missing = createUserAcceptanceHandler({
    service: fixture.service,
    acceptance: unusedAcceptance(),
    cancellation: unusedCancellation(),
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => { throw new Error("missing"); },
  });
  assert.equal((await missing({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" })).status, 401);
  const forbidden = createUserAcceptanceHandler({
    service: fixture.service,
    acceptance: unusedAcceptance(),
    cancellation: unusedCancellation(),
    allowedSpiffeIds: new Set(["spiffe://deviludo.internal/other"]),
    extractIdentity: () => identity,
  });
  assert.equal((await forbidden({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" })).status, 403);
});

test("user acceptance readiness includes the low-latency model Broker without leaking failures", async () => {
  const identity = {
    spiffeId: "spiffe://deviludo.internal/web",
    certificateFingerprint: "a".repeat(64),
    certificateSerial: "01",
    certificateNotAfter: "2030-01-01T00:00:00.000Z",
  };
  const request = { method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" };
  const readyFixture = buildFixture();
  const ready = createUserAcceptanceHandler({
    service: readyFixture.service,
    acceptance: unusedAcceptance(),
    cancellation: unusedCancellation(),
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  assert.equal((await ready(request)).status, 200);
  assert.equal(readyFixture.modelProbes, 1);

  const failedFixture = buildFixture({ modelProbeFailure: true });
  const failed = createUserAcceptanceHandler({
    service: failedFixture.service,
    acceptance: unusedAcceptance(),
    cancellation: unusedCancellation(),
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  const unavailable = await failed(request);
  assert.deepEqual(unavailable, { status: 503, body: { error: { code: "USER_ACCEPTANCE_NOT_READY" } } });
  assert.equal(JSON.stringify(unavailable).includes("private model diagnostic"), false);
});

test("PostgreSQL begin derives action and previous revisions under tenant RLS", async () => {
  let insertedValues: readonly unknown[] | undefined;
  const authority = authorityRow();
  const statements: string[] = [];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes("FROM deviludo.user_feedback_operations")) {
        if (!insertedValues) return rows<Row>([]);
        return rows<Row>([{
          operation_key: command.operationKey,
          tenant_id: tenantId,
          project_id: projectId,
          actor_id: command.actorId,
          request_digest: specDigest(command),
          feedback: command.feedback,
          feedback_digest: specDigest(command.feedback),
          workflow_id: "delivery-001",
          action_id: actionId,
          previous_conversation_id: previousConversationId,
          previous_spec_revision_id: previousSpecRevisionId,
          previous_test_plan_revision_id: previousTestPlanRevisionId,
          evidence_invalidation_id: insertedValues[12],
          signal_id: insertedValues[13],
          state: "GENERATING",
          claim_token: insertedValues[14],
          claim_active: true,
          draft_snapshot: null,
          completion_receipt: null,
        }]);
      }
      if (sql.includes("FROM deviludo.workflow_control_actions action")) {
        assert.equal(values?.[0], tenantId);
        assert.equal(values?.[1], projectId);
        assert.equal(values?.[2], command.actorId);
        assert.ok(values?.[3] === null || values?.[3] === actionId);
        assert.match(sql, /actor\.id::text = \$3 AND actor\.status = 'ACTIVE'/);
        assert.match(sql, /membership\.role IN \('TenantAdmin', 'ProjectOwner'\)/);
        return rows<Row>([authority]);
      }
      if (sql.includes("INSERT INTO deviludo.user_feedback_operations")) {
        insertedValues = values;
        return result<Row>(1);
      }
      if (sql.includes("FROM deviludo.spec_conversation_messages")) return rows<Row>([]);
      return result<Row>(0);
    },
    release() { statements.push("RELEASE"); },
  };
  const store = new PostgresUserFeedbackStore({ async connect() { return client; } });
  const outcome = await store.begin(command);
  assert.equal(outcome.kind, "ACQUIRED");
  if (outcome.kind !== "ACQUIRED") throw new Error("claim missing");
  assert.equal(outcome.claim.actionId, actionId);
  assert.equal(outcome.claim.previousSpecRevisionId, previousSpecRevisionId);
  assert.equal(outcome.claim.previousRevision, 5);
  assert.equal(insertedValues?.[8], actionId);
  assert.match(statements[0] ?? "", /^BEGIN$/);
  assert.match(statements[1] ?? "", /set_config\('app\.tenant_id'/);
  assert.equal(statements.at(-2), "COMMIT");
});

test("PostgreSQL begin permits exhausted and immediate post-merge human revision feedback", async () => {
  const repairContexts = [
    {
        attempt: 3,
        reason: "AGENT_FAILURE",
        fromRunConfigurationId: "run-configuration-failed-003",
        diagnosticId: "diagnostic-failed-003",
        evidenceBundleId: null,
        repairPromptId: null,
        candidateCommitSha: null,
        draftPullRequest: null,
    },
    {
      attempt: 1,
      reason: "STEAM_INSTALL_FAILURE",
      fromRunConfigurationId: "run-configuration-steam-install-001",
      diagnosticId: null,
      evidenceBundleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
      repairPromptId: `repair:${"f".repeat(64)}`,
      candidateCommitSha: "d".repeat(40),
      draftPullRequest: null,
    },
  ];
  for (const repairContext of repairContexts) {
    let insertedValues: readonly unknown[] | undefined;
    const authority = {
      ...authorityRow(),
      action_operation: "REQUEST_SPEC_APPROVAL",
      binding: {
        state: "WAITING_SPEC_APPROVAL",
        specRevisionId: previousSpecRevisionId,
        candidateCommitSha: null,
        draftPullRequest: null,
        evidenceBundleId: null,
        repairContext,
      },
    };
    const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      if (sql.includes("FROM deviludo.user_feedback_operations")) {
        if (!insertedValues) return rows<Row>([]);
        return rows<Row>([{
          operation_key: command.operationKey, tenant_id: tenantId, project_id: projectId,
          actor_id: command.actorId, request_digest: specDigest(command), feedback: command.feedback,
          feedback_digest: specDigest(command.feedback), workflow_id: "delivery-001", action_id: actionId,
          previous_conversation_id: previousConversationId, previous_spec_revision_id: previousSpecRevisionId,
          previous_test_plan_revision_id: previousTestPlanRevisionId,
          evidence_invalidation_id: insertedValues[12], signal_id: insertedValues[13],
          state: "GENERATING", claim_token: insertedValues[14], claim_active: true,
          draft_snapshot: null, completion_receipt: null,
        }]);
      }
      if (sql.includes("FROM deviludo.workflow_control_actions action")) return rows<Row>([authority]);
      if (sql.includes("INSERT INTO deviludo.user_feedback_operations")) {
        insertedValues = values;
        return result<Row>(1);
      }
      if (sql.includes("FROM deviludo.spec_conversation_messages")) return rows<Row>([]);
      return result<Row>(0);
    },
    release() {},
  };
    const outcome = await new PostgresUserFeedbackStore({ async connect() { return client; } }).begin(command);
    assert.equal(outcome.kind, "ACQUIRED");
    if (outcome.kind !== "ACQUIRED") throw new Error("claim missing");
    assert.equal(outcome.claim.actionId, actionId);
    assert.equal(outcome.claim.previousSpecRevisionId, previousSpecRevisionId);
  }
});

test("PostgreSQL feedback readiness requires every actor, workflow and immutable-draft table", async () => {
  const tables = [
    "users", "tenant_memberships", "workflow_control_actions", "user_feedback_operations",
    "immutable_revisions", "spec_conversations", "spec_dialogue_operations", "spec_conversation_messages",
    "workflow_feedback_invalidations", "workflow_signal_outbox",
  ] as const;
  let missing: string | null = null;
  let released = 0;
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string) {
      assert.match(sql, /to_regclass\('deviludo\.user_feedback_operations'\)/);
      const row = Object.fromEntries(tables.map((table) => [table, `deviludo.${table}`])) as Record<string, unknown>;
      if (missing) row[missing] = null;
      return rows<Row>([row]);
    },
    release() { released += 1; },
  };
  const store = new PostgresUserFeedbackStore({ async connect() { return client; } });
  await store.probe();
  missing = "spec_dialogue_operations";
  await assert.rejects(store.probe(), /authority is invalid/);
  missing = "workflow_feedback_invalidations";
  await assert.rejects(store.probe(), /authority is invalid/);
  missing = "workflow_signal_outbox";
  await assert.rejects(store.probe(), /authority is invalid/);
  assert.equal(released, 4);
});

function buildFixture(options: {
  readonly modelFailure?: boolean;
  readonly modelProbeFailure?: boolean;
  readonly beginWithDraft?: boolean;
  readonly beginKind?: "BUSY" | "CONFLICT";
} = {}) {
  const claim = feedbackClaim();
  const draft = feedbackDraft();
  const store = new TestStore(claim, draft, options);
  let modelCalls = 0;
  let modelProbes = 0;
  const model: SpecDialogueModel = {
    async probe() {
      modelProbes += 1;
      if (options.modelProbeFailure) throw new Error("private model diagnostic");
    },
    async generate(input) {
      modelCalls += 1;
      assert.equal(input.current, current);
      assert.equal(input.conversationId, previousConversationId);
      assert.equal(input.userMessage, command.feedback);
      if (options.modelFailure) throw new Error("model unavailable");
      return parseSpecModelResult({
        ...current,
        assistantMessage: "已降低前期风暴频率并加入新手提示。",
        spec: {
          ...current.spec,
          features: [...current.spec.features, "前五分钟风暴节流", "新手提示"],
        },
      });
    },
  };
  const completionInputs: Parameters<WorkflowActionCompletionPort["complete"]>[0][] = [];
  const completions: WorkflowActionCompletionPort = {
    async complete(input) {
      completionInputs.push(input);
      return Object.freeze({
        actionId,
        outboxId,
        workflowId: "delivery-001",
        signalId: "feedback-signal-001",
        signalDigest: "d".repeat(64),
        state: "PENDING_DELIVERY" as const,
        replayed: false,
      });
    },
  };
  const service = new UserAcceptanceService(store, model, completions);
  return {
    service,
    store,
    completionInputs,
    get modelCalls() { return modelCalls; },
    get modelProbes() { return modelProbes; },
  };
}

class TestStore implements UserFeedbackStore {
  releases = 0;
  createdDrafts = 0;
  completedDrafts = 0;

  constructor(
    private readonly claim: UserFeedbackClaim,
    private readonly draft: UserFeedbackDraft,
    private readonly options: {
      readonly beginWithDraft?: boolean;
      readonly beginKind?: "BUSY" | "CONFLICT";
    },
  ) {}

  async begin() {
    if (this.options.beginKind) return Object.freeze({ kind: this.options.beginKind });
    if (this.options.beginWithDraft) return Object.freeze({ kind: "DRAFT_READY" as const, draft: this.draft });
    return Object.freeze({ kind: "ACQUIRED" as const, claim: this.claim });
  }
  async createDraft() { this.createdDrafts += 1; return this.draft; }
  async release() { this.releases += 1; }
  async complete(_draft: UserFeedbackDraft, delivery: UserFeedbackReceipt["delivery"]) {
    this.completedDrafts += 1;
    return Object.freeze({ ...this.draft, state: "AWAITING_SPEC_APPROVAL" as const, delivery });
  }
  async probe() {}
}

function feedbackClaim(): UserFeedbackClaim {
  return Object.freeze({
    command,
    claimToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    workflowId: "delivery-001",
    actionId,
    previousConversationId,
    previousSpecRevisionId,
    previousTestPlanRevisionId,
    specAggregateId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    testPlanAggregateId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    previousRevision: 5,
    history: Object.freeze([]),
    current,
    evidenceInvalidationId,
    signalId: "feedback-signal-001",
  });
}

function feedbackDraft(): UserFeedbackDraft {
  const result = parseSpecModelResult({
    ...current,
    assistantMessage: "已生成下一版草案。",
  });
  return Object.freeze({
    operationKey: command.operationKey,
    tenantId,
    projectId,
    actorId: command.actorId,
    workflowId: "delivery-001",
    actionId,
    previousSpecRevisionId,
    evidenceInvalidationId,
    signalId: "feedback-signal-001",
    snapshot: Object.freeze({
      tenantId,
      projectId,
      conversationId: nextConversationId,
      revision: 6,
      state: "DRAFT" as const,
      specRevisionId: nextSpecRevisionId,
      specDigest: "e".repeat(64),
      testPlanRevisionId: nextTestPlanRevisionId,
      testPlanDigest: "f".repeat(64),
      messages: Object.freeze([]),
      result,
    }),
  });
}

function authorityRow() {
  const specPayload = {
    schemaVersion: "deviludo.game-spec.v1",
    conversationId: previousConversationId,
    revision: 5,
    spec: current.spec,
  };
  const planPayload = {
    schemaVersion: "deviludo.test-plan.v1",
    conversationId: previousConversationId,
    revision: 5,
    testPlan: current.testPlan,
  };
  return {
    workflow_id: "delivery-001",
    action_id: actionId,
    action_operation: "REQUEST_USER_ACCEPTANCE",
    binding: {
      specRevisionId: previousSpecRevisionId,
      candidateCommitSha: "a".repeat(40),
      draftPullRequest: 18,
      evidenceBundleId: "12121212-1212-4212-8212-121212121212",
    },
    conversation_id: previousConversationId,
    conversation_state: "APPROVED",
    spec_aggregate_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    test_plan_aggregate_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    spec_revision_id: previousSpecRevisionId,
    spec_revision: 5,
    spec_state: "APPROVED",
    spec_payload: specPayload,
    spec_payload_digest: specDigest(specPayload),
    test_plan_revision_id: previousTestPlanRevisionId,
    test_plan_revision: 5,
    test_plan_state: "FROZEN",
    test_plan_payload: planPayload,
    test_plan_payload_digest: specDigest(planPayload),
    current_metadata: {
      assistantMessage: current.assistantMessage,
      completeness: current.completeness,
      openQuestions: current.openQuestions,
    },
  };
}

function rows<Row extends Record<string, unknown>>(values: readonly Record<string, unknown>[]) {
  return { rowCount: values.length, rows: values as readonly Row[] };
}

function result<Row extends Record<string, unknown>>(rowCount: number) {
  return { rowCount, rows: [] as readonly Row[] };
}

function unusedAcceptance() {
  return {
    async accept() { throw new Error("unused"); },
    async probe() {},
  };
}

function unusedCancellation() {
  return {
    async cancel() { throw new Error("unused"); },
    async probe() {},
  };
}
