import assert from "node:assert/strict";
import test from "node:test";
import {
  UserAcceptanceBrokerClient,
  userFeedbackOperationKey,
} from "../lib/user-acceptance/broker.ts";

const command = {
  operationKey: "a".repeat(64),
  tenantId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  actorId: "user-1",
  feedback: "降低前五分钟的风暴频率。",
};

test("feedback operation identity is tenant, project, user and idempotency bound", async () => {
  const first = await userFeedbackOperationKey({
    tenantId: command.tenantId,
    projectId: command.projectId,
    userId: command.actorId,
    idempotencyKey: "feedback-1",
  });
  const replay = await userFeedbackOperationKey({
    tenantId: command.tenantId,
    projectId: command.projectId,
    userId: command.actorId,
    idempotencyKey: "feedback-1",
  });
  const otherUser = await userFeedbackOperationKey({
    tenantId: command.tenantId,
    projectId: command.projectId,
    userId: "user-2",
    idempotencyKey: "feedback-1",
  });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, replay);
  assert.notEqual(first, otherUser);
});

test("Web feedback Broker rejects drifted immutable authority", async () => {
  const response = receipt();
  response.data.snapshot.specRevisionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  response.data.delivery.actionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const client = new UserAcceptanceBrokerClient(
    "https://user-acceptance.internal/",
    async () => new Response(JSON.stringify(response), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  );
  await assert.rejects(client.submit(command), /response binding/);
});

function receipt() {
  const actionId = "33333333-3333-4333-8333-333333333333";
  const workflowId = "delivery-001";
  const signalId = "feedback-signal-001";
  return {
    data: {
      ...command,
      workflowId,
      actionId,
      previousSpecRevisionId: "44444444-4444-4444-8444-444444444444",
      evidenceInvalidationId: "55555555-5555-4555-8555-555555555555",
      signalId,
      snapshot: {
        tenantId: command.tenantId,
        projectId: command.projectId,
        conversationId: "66666666-6666-4666-8666-666666666666",
        revision: 6,
        state: "DRAFT",
        specRevisionId: "77777777-7777-4777-8777-777777777777",
        specDigest: "b".repeat(64),
        testPlanRevisionId: "88888888-8888-4888-8888-888888888888",
        testPlanDigest: "c".repeat(64),
        messages: [
          { id: "99999999-9999-4999-8999-999999999999", sequence: 1, role: "user", text: command.feedback, createdAt: "2026-07-18T12:00:00.000Z" },
          { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sequence: 2, role: "assistant", text: "已生成草案。", createdAt: "2026-07-18T12:00:00.000Z" },
        ],
        result: {
          assistantMessage: "已生成草案。",
          completeness: 100,
          openQuestions: [],
          spec: {
            title: "群岛风暴",
            elevatorPitch: "十分钟一局",
            genre: "2D 生存",
            godotVersion: "4.5.0",
            targetPlatforms: ["windows"],
            features: ["核心循环"],
            acceptanceCriteria: [{ id: "loop", description: "完成一局", required: true }],
          },
          testPlan: {
            version: "godot-testkit-1.0.0",
            scenarios: ["核心循环"],
            minimumFps: 60,
            maxCrashCount: 0,
          },
        },
      },
      state: "AWAITING_SPEC_APPROVAL",
      delivery: {
        actionId,
        outboxId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        workflowId,
        signalId,
        signalDigest: "d".repeat(64),
        state: "PENDING_DELIVERY",
        replayed: false,
      },
    },
  };
}
