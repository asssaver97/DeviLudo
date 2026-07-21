import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { SpecDialogueSnapshot, SpecApprovalReceipt } from "../../spec-dialogue/src/contracts";
import { createLocalSpecRuntimeHeaders } from "../src/request-auth";
import { createLocalSpecRuntimeServer } from "../src/server";

test("local specification runtime is an explicit non-listening loopback sidecar until started", () => {
  const server = createLocalSpecRuntimeServer({ authenticationKey: new Uint8Array(Buffer.alloc(32, 3)) });
  assert.equal(server.listening, false);
  assert.equal(server.requestTimeout, 300_000);
});

test("authenticated feedback creates a new approvable draft and replays without reopening its ancestor", async () => {
  const key = new Uint8Array(Buffer.alloc(32, 4));
  const server = createLocalSpecRuntimeServer({ authenticationKey: key });
  const projectId = "feedback-contract";
  const conversationPath = `/v1/projects/${projectId}/conversation`;
  const approvalPath = `/v1/projects/${projectId}/spec-approval`;
  const feedbackPath = `/v1/projects/${projectId}/feedback`;
  const idempotencyKey = "shared-route-operation-key";

  const send = async <T>(path: string, body: Record<string, unknown>, requestKey = idempotencyKey) => {
    const rawBody = JSON.stringify(body);
    const response = await invoke(server, {
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        "idempotency-key": requestKey,
        ...createLocalSpecRuntimeHeaders({ method: "POST", path, body: rawBody }, { key }),
      },
      body: rawBody,
    });
    return { response, payload: JSON.parse(response.body) as { data?: T; error?: { code?: string } } };
  };

  const first = await send<SpecDialogueSnapshot>(conversationPath, {
    expectedRevision: 0,
    message: "制作一款十分钟一局的桌面单机游戏",
  });
  assert.equal(first.response.statusCode, 201);
  assert.equal(first.payload.data?.revision, 1);
  const draft = first.payload.data!;

  const approval = await send<SpecApprovalReceipt>(approvalPath, {
    expectedRevision: draft.revision,
    specRevisionId: draft.specRevisionId,
    testPlanRevisionId: draft.testPlanRevisionId,
  });
  assert.equal(approval.response.statusCode, 201);
  assert.equal(approval.payload.data?.revision, 2);

  const feedbackBody = { feedback: "新手前五分钟最多出现一次风暴" };
  const feedback = await send<SpecDialogueSnapshot>(feedbackPath, feedbackBody);
  assert.equal(feedback.response.statusCode, 201);
  assert.equal(feedback.payload.data?.state, "DRAFT");
  assert.equal(feedback.payload.data?.revision, 3);
  assert.notEqual(feedback.payload.data?.conversationId, draft.conversationId);
  assert.equal(feedback.payload.data?.messages.length, draft.messages.length + 2);

  const replay = await send<SpecDialogueSnapshot>(feedbackPath, feedbackBody);
  assert.equal(replay.response.statusCode, 201);
  assert.deepEqual(replay.payload.data, feedback.payload.data);
  const successor = feedback.payload.data!;
  const successorApproval = await send<SpecApprovalReceipt>(approvalPath, {
    expectedRevision: successor.revision,
    specRevisionId: successor.specRevisionId,
    testPlanRevisionId: successor.testPlanRevisionId,
  }, "successor-approval-key");
  assert.equal(successorApproval.response.statusCode, 201);
  assert.equal(successorApproval.payload.data?.revision, 4);

  const forgedBody = JSON.stringify({ feedback: "绕过签名" });
  const forged = await invoke(server, {
    method: "POST",
    path: feedbackPath,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "forged-feedback",
      "x-deviludo-local-spec-runtime": "v1",
    },
    body: forgedBody,
  });
  assert.equal(forged.statusCode, 403);
  assert.equal((JSON.parse(forged.body) as { error: { code: string } }).error.code, "LOCAL_SPEC_RUNTIME_AUTH_REQUIRED");
});

async function invoke(
  server: ReturnType<typeof createLocalSpecRuntimeServer>,
  input: Readonly<{
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    body: string;
  }>,
): Promise<Readonly<{ statusCode: number; body: string }>> {
  const request = Readable.from(input.body ? [Buffer.from(input.body)] : []) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  request.method = input.method;
  request.url = input.path;
  request.headers = { ...input.headers };
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {},
      end(value: string | Buffer = "") {
        resolve({ statusCode: response.statusCode, body: Buffer.isBuffer(value) ? value.toString("utf8") : value });
      },
    };
    server.once("error", reject);
    server.emit("request", request, response);
  });
}
