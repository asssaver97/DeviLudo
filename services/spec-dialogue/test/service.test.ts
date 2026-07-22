import assert from "node:assert/strict";
import test from "node:test";
import { parseSpecModelResult, SpecDialogueRequestError } from "../src/contracts";
import { createSpecDialogueHandler } from "../src/ingress-http";
import { DeterministicLocalSpecModel } from "../src/model";
import { MtlsSpecDialogueModel } from "../src/model-broker";
import { SpecDialogueConflict, SpecDialogueService } from "../src/service";
import { InMemorySpecDialogueStore, SpecDialogueToolchainUnavailable } from "../src/store";

const command = {
  operationKey: "a".repeat(64),
  tenantId: "tenant-1",
  projectId: "project-1",
  conversationId: "conversation-1",
  actorId: "user-1",
  expectedRevision: 0,
  message: "制作一款十分钟一局的 2D 桌面单机游戏",
};

test("each local dialogue turn persists one immutable-shaped snapshot and replays exactly", async () => {
  const service = new SpecDialogueService(new InMemorySpecDialogueStore(), new DeterministicLocalSpecModel());
  const first = await service.send(command);
  assert.equal(first.revision, 1);
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[0]?.role, "user");
  assert.equal(first.messages[1]?.role, "assistant");
  assert.match(first.specDigest ?? "", /^[a-f0-9]{64}$/);
  assert.match(first.testPlanDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(first.result?.testPlan.version, "godot-testkit-1.0.0");
  assert.deepEqual(await service.send(command), first);
  await assert.rejects(
    service.send({ ...command, message: "reuse the key with another body" }),
    (error) => error instanceof SpecDialogueConflict && error.code === "SPEC_DIALOGUE_REVISION_CONFLICT",
  );
});

test("explicit approval creates an immutable approved spec and frozen plan successor", async () => {
  const service = new SpecDialogueService(new InMemorySpecDialogueStore(), new DeterministicLocalSpecModel());
  const draft = await service.send(command);
  const approval = {
    operationKey: "d".repeat(64), tenantId: command.tenantId, projectId: command.projectId,
    conversationId: command.conversationId, actorId: command.actorId,
    expectedRevision: draft.revision, specRevisionId: draft.specRevisionId!, testPlanRevisionId: draft.testPlanRevisionId!,
  };
  const receipt = await service.approve(approval);
  assert.equal(receipt.state, "APPROVED");
  assert.equal(receipt.revision, 2);
  assert.notEqual(receipt.specRevisionId, draft.specRevisionId);
  assert.notEqual(receipt.testPlanRevisionId, draft.testPlanRevisionId);
  assert.deepEqual(await service.approve(approval), receipt);
  assert.equal((await service.snapshot({ tenantId: command.tenantId, projectId: command.projectId, conversationId: command.conversationId }))?.state, "APPROVED");
  await assert.rejects(service.send({ ...command, operationKey: "e".repeat(64), expectedRevision: 2 }), SpecDialogueConflict);
});

test("local feedback forks an approved conversation without reopening or mutating its authority", async () => {
  const store = new InMemorySpecDialogueStore();
  const service = new SpecDialogueService(store, new DeterministicLocalSpecModel());
  const draft = await service.send(command);
  await assert.rejects(
    store.forkApproved({
      tenantId: command.tenantId, projectId: command.projectId,
      conversationId: command.conversationId, nextConversationId: "conversation-feedback-too-early",
    }),
    /not an approved revision/,
  );
  await service.approve({
    operationKey: "d".repeat(64), tenantId: command.tenantId, projectId: command.projectId,
    conversationId: command.conversationId, actorId: command.actorId,
    expectedRevision: draft.revision, specRevisionId: draft.specRevisionId!, testPlanRevisionId: draft.testPlanRevisionId!,
  });
  const ancestor = await service.snapshot({
    tenantId: command.tenantId, projectId: command.projectId, conversationId: command.conversationId,
  });
  assert.equal(ancestor?.state, "APPROVED");
  const fork = {
    tenantId: command.tenantId, projectId: command.projectId,
    conversationId: command.conversationId, nextConversationId: "conversation-feedback-1",
  };
  const successorBase = await store.forkApproved(fork);
  assert.equal(successorBase.state, "DRAFT");
  assert.equal(successorBase.revision, 2);
  assert.equal(successorBase.messages.length, ancestor?.messages.length);
  assert.equal(successorBase.specRevisionId, null);
  assert.deepEqual(await store.forkApproved(fork), successorBase);

  const successor = await service.send({
    ...command,
    operationKey: "f".repeat(64),
    conversationId: fork.nextConversationId,
    expectedRevision: successorBase.revision,
    message: "降低前五分钟的风暴频率，并保持其余已批准规则",
  });
  assert.equal(successor.state, "DRAFT");
  assert.equal(successor.revision, 3);
  assert.equal(successor.messages.length, (ancestor?.messages.length ?? 0) + 2);
  assert.notEqual(successor.specRevisionId, ancestor?.specRevisionId);
  assert.deepEqual(await service.snapshot({
    tenantId: command.tenantId, projectId: command.projectId, conversationId: command.conversationId,
  }), ancestor);

  const approvedSuccessor = await service.approve({
    operationKey: "9".repeat(64), tenantId: command.tenantId, projectId: command.projectId,
    conversationId: successor.conversationId, actorId: command.actorId,
    expectedRevision: successor.revision, specRevisionId: successor.specRevisionId!, testPlanRevisionId: successor.testPlanRevisionId!,
  });
  assert.equal(approvedSuccessor.revision, 4);
  assert.deepEqual(await service.snapshot({
    tenantId: command.tenantId, projectId: command.projectId, conversationId: command.conversationId,
  }), ancestor);
});

test("a pending model call fences concurrent duplicates", async () => {
  let release!: (value: ReturnType<typeof parseSpecModelResult>) => void;
  const pending = new Promise<ReturnType<typeof parseSpecModelResult>>((resolve) => { release = resolve; });
  const model = { async probe() {}, generate: async () => pending };
  const service = new SpecDialogueService(new InMemorySpecDialogueStore(), model);
  const first = service.send(command);
  await assert.rejects(
    service.send(command),
    (error) => error instanceof SpecDialogueConflict && error.code === "SPEC_DIALOGUE_BUSY",
  );
  release(await new DeterministicLocalSpecModel().generate({
    operationKey: command.operationKey, tenantId: command.tenantId, projectId: command.projectId,
    conversationId: command.conversationId, history: [], current: null, userMessage: command.message,
  }));
  assert.equal((await first).revision, 1);
});

test("strict model output rejects unknown fields, floating versions and invalid target matrices", () => {
  const valid = {
    assistantMessage: "继续确认胜负条件。", completeness: 60, openQuestions: ["怎样获胜？"],
    spec: {
      title: "游戏", elevatorPitch: "十分钟核心循环", genre: "2D 冒险", godotVersion: "4.5.0",
      targetPlatforms: ["windows"], features: ["核心循环"],
      acceptanceCriteria: [{ id: "loop", description: "可完成一次循环", required: true }],
    },
    testPlan: { version: "godot-testkit-1.0.0", scenarios: ["核心循环"], minimumFps: 60, maxCrashCount: 0 },
  };
  assert.equal(parseSpecModelResult(valid).spec.targetPlatforms[0], "windows");
  assert.throws(() => parseSpecModelResult({ ...valid, extra: true }), SpecDialogueRequestError);
  assert.throws(() => parseSpecModelResult({ ...valid, spec: { ...valid.spec, godotVersion: "latest" } }), SpecDialogueRequestError);
  assert.throws(() => parseSpecModelResult({ ...valid, spec: { ...valid.spec, targetPlatforms: ["android"] } }), SpecDialogueRequestError);
});

test("mTLS model Broker receives no tool permission or credential material and output stays strict", async () => {
  let body: Record<string, unknown> | null = null;
  const generated = await new DeterministicLocalSpecModel().generate({
    operationKey: command.operationKey, tenantId: command.tenantId, projectId: command.projectId,
    conversationId: command.conversationId, history: [], current: null, userMessage: command.message,
  });
  const model = new MtlsSpecDialogueModel({
    endpoint: "https://spec-model.internal/v1/spec-generations",
    tls: { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    async http(_url, input) { body = JSON.parse(input.body) as Record<string, unknown>; return { statusCode: 200, payload: generated }; },
  });
  assert.deepEqual(await model.generate({
    operationKey: command.operationKey, tenantId: command.tenantId, projectId: command.projectId,
    conversationId: command.conversationId, history: [], current: null, userMessage: command.message,
  }), generated);
  assert.ok(body);
  assert.equal((body as Record<string, unknown>).toolsAllowed, false);
  assert.equal(JSON.stringify(body).includes("apiKey"), false);
  assert.equal(JSON.stringify(body).includes("baseUrl"), false);
});

test("mTLS model Broker readiness pins the exact health schema and service identity", async () => {
  const calls: string[] = [];
  const model = new MtlsSpecDialogueModel({
    endpoint: "https://spec-model.internal/v1/spec-generations",
    tls: { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    async http(url, input) {
      calls.push(`${input.method ?? "POST"} ${url.pathname} ${String(input.operationKey)}`);
      return { statusCode: 200, payload: {
        schemaVersion: "deviludo.spec-model-health.v1",
        status: "ok",
        service: "deviludo-spec-model-broker",
      } };
    },
  });
  await model.probe();
  assert.deepEqual(calls, ["GET /healthz null"]);

  const drifted = new MtlsSpecDialogueModel({
    endpoint: "https://spec-model.internal/v1/spec-generations",
    tls: { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    async http() { return { statusCode: 200, payload: {
      schemaVersion: "deviludo.spec-model-health.v1", status: "ok", service: "another-service",
    } }; },
  });
  await assert.rejects(drifted.probe(), /health identity/);
});

test("production dialogue ingress requires an allow-listed mTLS workload", async () => {
  const identity = { spiffeId: "spiffe://deviludo.internal/web", certificateFingerprint: "b".repeat(64), certificateSerial: "01", certificateNotAfter: "2030-01-01T00:00:00.000Z" };
  const service = new SpecDialogueService(new InMemorySpecDialogueStore(), new DeterministicLocalSpecModel());
  const allowed = createSpecDialogueHandler({ service, allowedSpiffeIds: new Set([identity.spiffeId]), extractIdentity: () => identity });
  const response = await allowed({ method: "POST", path: "/v1/spec-dialogue/messages", headers: { "content-type": "application/json" }, socket: {}, rawBody: JSON.stringify(command) });
  assert.equal(response.status, 201);
  assert.equal((response.body.data as { revision: number }).revision, 1);
  const missing = createSpecDialogueHandler({ service, allowedSpiffeIds: new Set([identity.spiffeId]), extractIdentity: () => { throw new Error("missing"); } });
  assert.equal((await missing({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" })).status, 401);
  const forbidden = createSpecDialogueHandler({ service, allowedSpiffeIds: new Set(["spiffe://deviludo.internal/other"]), extractIdentity: () => identity });
  assert.equal((await forbidden({ method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" })).status, 403);
});

test("production dialogue readiness recursively checks storage, model and approval delivery", async () => {
  const probes: string[] = [];
  let modelFailed = false;
  const store = new InMemorySpecDialogueStore();
  store.probe = async () => { probes.push("store"); };
  const deterministic = new DeterministicLocalSpecModel();
  const model = {
    async probe() { probes.push("model"); if (modelFailed) throw new Error("private model diagnostic"); },
    generate: deterministic.generate.bind(deterministic),
  };
  const workflow = {
    async probe() { probes.push("workflow"); },
    async publish() { throw new Error("unused"); },
  };
  const identity = { spiffeId: "spiffe://deviludo.internal/web", certificateFingerprint: "b".repeat(64), certificateSerial: "01", certificateNotAfter: "2030-01-01T00:00:00.000Z" };
  const handler = createSpecDialogueHandler({
    service: new SpecDialogueService(store, model, workflow),
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  const request = { method: "GET", path: "/healthz", headers: {}, socket: {}, rawBody: "" };
  const ready = await handler(request);
  assert.deepEqual(ready, { status: 200, body: { status: "ok", service: "deviludo-spec-dialogue" } });
  assert.deepEqual(probes.sort(), ["model", "store", "workflow"]);
  modelFailed = true;
  const unavailable = await handler(request);
  assert.deepEqual(unavailable, { status: 503, body: { error: { code: "SPEC_DIALOGUE_NOT_READY" } } });
  assert.equal(JSON.stringify(unavailable).includes("private model diagnostic"), false);
});

test("production approval reports an explicit unavailable gate when no compatible Runner toolchain exists", async () => {
  const identity = { spiffeId: "spiffe://deviludo.internal/web", certificateFingerprint: "b".repeat(64), certificateSerial: "01", certificateNotAfter: "2030-01-01T00:00:00.000Z" };
  const handler = createSpecDialogueHandler({
    service: {
      async send() { throw new Error("not used"); },
      async snapshot() { throw new Error("not used"); },
      async approve() { throw new SpecDialogueToolchainUnavailable(); },
      async probe() {},
    },
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  const response = await handler({
    method: "POST",
    path: "/v1/spec-dialogue/approve",
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: JSON.stringify({}),
  });
  assert.equal(response.status, 503);
  assert.equal((response.body.error as { code: string }).code, "RUNNER_TOOLCHAIN_UNAVAILABLE");
});
