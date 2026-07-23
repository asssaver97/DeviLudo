import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("durable state preserves the current feedback branch and exact replays across process recreation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deviludo-local-spec-"));
  try {
    const stateFile = path.join(directory, "state.json");
    const key = new Uint8Array(Buffer.alloc(32, 7));
    const projectId = "durable-feedback";
    const conversationPath = `/v1/projects/${projectId}/conversation`;
    const approvalPath = `/v1/projects/${projectId}/spec-approval`;
    const feedbackPath = `/v1/projects/${projectId}/feedback`;
    const firstServer = createLocalSpecRuntimeServer({ authenticationKey: key, stateFile });

    const draft = await authenticatedPost<SpecDialogueSnapshot>(firstServer, key, conversationPath, "durable-message", {
      expectedRevision: 0,
      message: "制作一款可以反复迭代的桌面单机游戏\n每局十分钟",
    });
    assert.equal(draft.response.statusCode, 201);
    const approval = await authenticatedPost<SpecApprovalReceipt>(firstServer, key, approvalPath, "durable-approval", {
      expectedRevision: draft.data!.revision,
      specRevisionId: draft.data!.specRevisionId,
      testPlanRevisionId: draft.data!.testPlanRevisionId,
    });
    assert.equal(approval.response.statusCode, 201);
    const feedbackBody = { feedback: "把核心循环限制为十分钟" };
    const feedback = await authenticatedPost<SpecDialogueSnapshot>(firstServer, key, feedbackPath, "durable-feedback", feedbackBody);
    assert.equal(feedback.response.statusCode, 201);

    const metadata = await stat(stateFile);
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
    const rawState = await readFile(stateFile, "utf8");
    assert.equal(rawState.includes(Buffer.from(key).toString("base64url")), false);
    assert.equal(rawState.includes("authenticationKey"), false);

    const recreatedServer = createLocalSpecRuntimeServer({ authenticationKey: key, stateFile });
    const recovered = await authenticatedGet<SpecDialogueSnapshot>(recreatedServer, key, conversationPath);
    assert.equal(recovered.response.statusCode, 200);
    assert.deepEqual(recovered.data, feedback.data);
    const replay = await authenticatedPost<SpecDialogueSnapshot>(recreatedServer, key, feedbackPath, "durable-feedback", feedbackBody);
    assert.equal(replay.response.statusCode, 201);
    assert.deepEqual(replay.data, feedback.data);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a persistence outage returns 503 and the exact operation can durably replay", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deviludo-local-spec-retry-"));
  try {
    const stateDirectory = path.join(directory, "state-directory");
    const movedDirectory = path.join(directory, "state-directory-away");
    const stateFile = path.join(stateDirectory, "state.json");
    const key = new Uint8Array(Buffer.alloc(32, 9));
    const server = createLocalSpecRuntimeServer({ authenticationKey: key, stateFile });
    await rename(stateDirectory, movedDirectory);
    await writeFile(stateDirectory, "not-a-directory");
    const requestPath = "/v1/projects/persistence-retry/conversation";
    const body = { expectedRevision: 0, message: "同一个操作必须可以安全重试" };

    const failed = await authenticatedPost<SpecDialogueSnapshot>(server, key, requestPath, "persistence-retry", body);
    assert.equal(failed.response.statusCode, 503);
    assert.equal((JSON.parse(failed.response.body) as { error: { code: string } }).error.code, "LOCAL_SPEC_PERSISTENCE_UNAVAILABLE");

    await unlink(stateDirectory);
    await rename(movedDirectory, stateDirectory);
    const replay = await authenticatedPost<SpecDialogueSnapshot>(server, key, requestPath, "persistence-retry", body);
    assert.equal(replay.response.statusCode, 201);
    assert.equal(replay.data?.revision, 1);
    assert.equal((await stat(stateFile)).isFile(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable state rejects corruption, widened permissions, and symlink substitution", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deviludo-local-spec-invalid-"));
  try {
    const key = new Uint8Array(Buffer.alloc(32, 8));
    const corruptFile = path.join(directory, "corrupt.json");
    await writeFile(corruptFile, "{}\n", { mode: 0o600 });
    assert.throws(() => createLocalSpecRuntimeServer({ authenticationKey: key, stateFile: corruptFile }), /could not be loaded safely/);

    const widenedFile = path.join(directory, "widened.json");
    await writeFile(widenedFile, "{}\n", { mode: 0o600 });
    await chmod(widenedFile, 0o644);
    assert.throws(() => createLocalSpecRuntimeServer({ authenticationKey: key, stateFile: widenedFile }), /could not be loaded safely/);

    const targetFile = path.join(directory, "target.json");
    const symlinkFile = path.join(directory, "state-link.json");
    await writeFile(targetFile, "{}\n", { mode: 0o600 });
    await symlink(targetFile, symlinkFile);
    assert.throws(() => createLocalSpecRuntimeServer({ authenticationKey: key, stateFile: symlinkFile }), /could not be loaded safely/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function authenticatedPost<T>(
  server: ReturnType<typeof createLocalSpecRuntimeServer>,
  key: Uint8Array,
  requestPath: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
): Promise<{ response: Awaited<ReturnType<typeof invoke>>; data?: T }> {
  const rawBody = JSON.stringify(body);
  const response = await invoke(server, {
    method: "POST",
    path: requestPath,
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...createLocalSpecRuntimeHeaders({ method: "POST", path: requestPath, body: rawBody }, { key }),
    },
    body: rawBody,
  });
  return { response, data: (JSON.parse(response.body) as { data?: T }).data };
}

async function authenticatedGet<T>(
  server: ReturnType<typeof createLocalSpecRuntimeServer>,
  key: Uint8Array,
  requestPath: string,
): Promise<{ response: Awaited<ReturnType<typeof invoke>>; data?: T }> {
  const response = await invoke(server, {
    method: "GET",
    path: requestPath,
    headers: createLocalSpecRuntimeHeaders({ method: "GET", path: requestPath, body: "" }, { key }),
    body: "",
  });
  return { response, data: (JSON.parse(response.body) as { data?: T }).data };
}

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
