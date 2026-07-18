import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicLocalSpecModel } from "../src/model";
import { SpecDialogueService } from "../src/service";
import { InMemorySpecDialogueStore } from "../src/store";
import { MtlsSpecWorkflowApprovalSink, type SpecWorkflowApprovalSink } from "../src/workflow-bridge";

const dialogue = {
  operationKey: "a".repeat(64), tenantId: "tenant-1", projectId: "project-1",
  conversationId: "conversation-1", actorId: "user-1", expectedRevision: 0,
  message: "制作一款十分钟一局的 2D 桌面游戏",
};

test("workflow publisher emits only the committed immutable approval binding", async () => {
  let outbound: Record<string, unknown> | null = null;
  const sink = new MtlsSpecWorkflowApprovalSink({
    endpoint: "https://spec-workflow.internal/v1/spec-approvals",
    tls: { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    async http(_url, input) {
      outbound = JSON.parse(input.body) as Record<string, unknown>;
      return { statusCode: 202, payload: { data: {
        workflowId: "delivery-11111111-1111-4111-8111-111111111111",
        readyEventKey: "b".repeat(64), approvalEventKey: "c".repeat(64),
        state: "PENDING_DELIVERY", replayed: false,
      } } };
    },
  });
  await sink.publish({
    operationKey: "d".repeat(64), tenantId: "tenant-1", projectId: "project-1",
    conversationId: "conversation-1", actorId: "user-1", expectedRevision: 1,
    specRevisionId: "draft-spec-1", testPlanRevisionId: "draft-plan-1",
  }, {
    operationKey: "d".repeat(64), tenantId: "tenant-1", projectId: "project-1",
    conversationId: "conversation-1", revision: 2, state: "APPROVED",
    specRevisionId: "approved-spec-1", specDigest: "e".repeat(64),
    testPlanRevisionId: "approved-plan-1", testPlanDigest: "f".repeat(64),
    targetMatrix: ["linux"], godotVersion: "4.5.0", approvedAt: "2026-07-18T10:00:00.000Z",
  });
  assert.deepEqual(outbound, {
    schemaVersion: "deviludo.spec-workflow-approval.v1", operationKey: "d".repeat(64),
    tenantId: "tenant-1", projectId: "project-1", conversationId: "conversation-1",
    draftSpecRevisionId: "draft-spec-1", draftTestPlanRevisionId: "draft-plan-1",
    approvedSpecRevisionId: "approved-spec-1", approvedSpecDigest: "e".repeat(64),
    approvedTestPlanRevisionId: "approved-plan-1", approvedTestPlanDigest: "f".repeat(64),
    targetMatrix: ["linux"], godotVersion: "4.5.0", approvedAt: "2026-07-18T10:00:00.000Z",
  });
  assert.equal(JSON.stringify(outbound).includes("actorId"), false);
});

test("workflow publisher rejects response extension and approval drift", async () => {
  const tls = { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) };
  const command = { operationKey: "d".repeat(64), tenantId: "tenant-1", projectId: "project-1", conversationId: "conversation-1", actorId: "user-1", expectedRevision: 1, specRevisionId: "draft-spec-1", testPlanRevisionId: "draft-plan-1" };
  const receipt = { operationKey: "d".repeat(64), tenantId: "tenant-1", projectId: "project-1", conversationId: "conversation-1", revision: 2, state: "APPROVED" as const, specRevisionId: "approved-spec-1", specDigest: "e".repeat(64), testPlanRevisionId: "approved-plan-1", testPlanDigest: "f".repeat(64), targetMatrix: ["linux"] as const, godotVersion: "4.5.0", approvedAt: "2026-07-18T10:00:00.000Z" };
  const extended = new MtlsSpecWorkflowApprovalSink({ endpoint: "https://spec-workflow.internal/v1/spec-approvals", tls,
    async http() { return { statusCode: 202, payload: { data: { workflowId: "delivery-11111111-1111-4111-8111-111111111111", readyEventKey: "b".repeat(64), approvalEventKey: "c".repeat(64), state: "PENDING_DELIVERY", replayed: false, extra: true } } }; } });
  await assert.rejects(extended.publish(command, receipt), /response binding is invalid/);
  await assert.rejects(extended.publish(command, { ...receipt, operationKey: "0".repeat(64) }), /receipt drifted/);
});

test("a failed publish leaves the approval committed and an exact retry republishes it", async () => {
  const store = new InMemorySpecDialogueStore();
  let calls = 0;
  const published = [] as string[];
  const workflow: SpecWorkflowApprovalSink = {
    async publish(_command, receipt) {
      calls += 1;
      published.push(receipt.specRevisionId);
      if (calls === 1) throw new Error("bridge unavailable");
    },
  };
  const service = new SpecDialogueService(store, new DeterministicLocalSpecModel(), workflow);
  const draft = await service.send(dialogue);
  const approval = {
    operationKey: "d".repeat(64), tenantId: dialogue.tenantId, projectId: dialogue.projectId,
    conversationId: dialogue.conversationId, actorId: dialogue.actorId,
    expectedRevision: draft.revision, specRevisionId: draft.specRevisionId!,
    testPlanRevisionId: draft.testPlanRevisionId!,
  };
  await assert.rejects(service.approve(approval), /bridge unavailable/);
  assert.equal((await service.snapshot({ tenantId: dialogue.tenantId, projectId: dialogue.projectId, conversationId: dialogue.conversationId }))?.state, "APPROVED");
  const retried = await service.approve(approval);
  assert.equal(retried.state, "APPROVED");
  assert.equal(calls, 2);
  assert.deepEqual(published, [retried.specRevisionId, retried.specRevisionId]);
});
