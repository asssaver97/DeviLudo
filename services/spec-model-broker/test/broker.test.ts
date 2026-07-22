import assert from "node:assert/strict";
import test from "node:test";
import { MtlsSpecDialogueModel } from "../../spec-dialogue/src/model-broker";
import { DeterministicLocalSpecModel } from "../../spec-dialogue/src/model";
import { createSpecModelBrokerHandler } from "../src/ingress-http";
import { MemorySpecModelOperationStore } from "../src/operation-memory";
import { MemorySpecModelProviderAuthority } from "../src/provider-authority";
import { SpecModelBrokerService } from "../src/service";
import type { SpecGenerationReceipt, SpecModelGenerator, SpecModelProviderBinding } from "../src/contracts";
import { SpecModelUpstreamError } from "../src/contracts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const identity = "spiffe://deviludo.internal/control/spec-dialogue";
const operationKey = "a".repeat(64);
const tls = Object.freeze({ key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) });
const provider: SpecModelProviderBinding = Object.freeze({
  profileRevisionId: "profile-spec-r1",
  providerRevisionId: "provider-claude-r1",
  credentialVersionId: "credential-v1",
  agent: "claude-code",
  protocol: "anthropic-messages",
  baseUrl: "https://api.example.com/v1",
  approvedPorts: Object.freeze([443]),
  authentication: "x-api-key",
  model: "claude-haiku-4-5-20251001",
  policyDigest: "b".repeat(64),
});

test("production dialogue client and model Broker share one exact replayable wire contract", async () => {
  const result = await generatedResult("Build a tiny tactics game for Linux");
  const generator = new FixedGenerator(result);
  const service = broker(generator);
  const handler = createSpecModelBrokerHandler({
    service,
    allowedSpiffeIds: new Set([identity]),
    extractIdentity: (socket) => ({ spiffeId: String(socket) }),
  });
  const model = new MtlsSpecDialogueModel({
    endpoint: "https://spec-model.internal/v1/spec-generations",
    tls,
    http: async (url, input) => {
      assert.ok(input.operationKey);
      const response = await handler({
        method: "POST",
        path: url.pathname,
        headers: { "content-type": "application/json", "idempotency-key": input.operationKey },
        socket: identity,
        rawBody: input.body,
      });
      return { statusCode: response.status, payload: response.body };
    },
  });
  const request = {
    operationKey,
    tenantId,
    projectId,
    conversationId,
    history: [],
    current: null,
    userMessage: "Build a tiny tactics game for Linux",
  };
  assert.deepEqual(await model.generate(request), result.result);
  assert.deepEqual(await model.generate(request), result.result);
  assert.equal(generator.calls, 1);
});

test("ingress rejects identity, credentials, tools and immutable request drift", async () => {
  const result = await generatedResult("A platformer");
  const generator = new FixedGenerator(result);
  const handler = createSpecModelBrokerHandler({
    service: broker(generator),
    allowedSpiffeIds: new Set([identity]),
    extractIdentity: (socket) => ({ spiffeId: String(socket) }),
  });
  const request = body("A platformer");
  const send = (rawBody: unknown, socket = identity, headers: Record<string, string> = {}) => handler({
    method: "POST", path: "/v1/spec-generations", socket,
    headers: { "content-type": "application/json", "idempotency-key": operationKey, ...headers },
    rawBody: JSON.stringify(rawBody),
  });
  assert.equal((await send(request, "spiffe://deviludo.internal/unknown")).status, 403);
  assert.equal((await send(request, identity, { authorization: "Bearer caller-secret" })).status, 400);
  assert.equal((await send({ ...request, toolsAllowed: true })).status, 400);
  assert.equal((await send({ ...request, model: "caller-model" })).status, 400);
  assert.equal((await send(request)).status, 200);
  assert.equal((await send(body("Changed under the same operation key"))).status, 400);
  assert.equal(generator.calls, 1);
});

test("post-dispatch ambiguity becomes durable reconciliation-required and never charges twice", async () => {
  const generator: SpecModelGenerator & { calls: number } = {
    calls: 0,
    async generate() { this.calls += 1; throw new SpecModelUpstreamError(true); },
    async probe() {},
  };
  const handler = createSpecModelBrokerHandler({
    service: broker(generator),
    allowedSpiffeIds: new Set([identity]),
    extractIdentity: (socket) => ({ spiffeId: String(socket) }),
  });
  const input = {
    method: "POST", path: "/v1/spec-generations", socket: identity,
    headers: { "content-type": "application/json", "idempotency-key": operationKey },
    rawBody: JSON.stringify(body("A puzzle game")),
  } as const;
  assert.deepEqual((await handler(input)).body, { error: { code: "SPEC_MODEL_UPSTREAM_INDETERMINATE" } });
  assert.deepEqual((await handler(input)).body, { error: { code: "SPEC_MODEL_RECONCILIATION_REQUIRED" } });
  assert.equal(generator.calls, 1);
});

test("pre-dispatch failures release the operation for an exact retry", async () => {
  const result = await generatedResult("A puzzle game");
  let fail = true;
  const generator: SpecModelGenerator & { calls: number } = {
    calls: 0,
    async generate() {
      this.calls += 1;
      if (fail) { fail = false; throw new SpecModelUpstreamError(false); }
      return result;
    },
    async probe() {},
  };
  const service = broker(generator);
  await assert.rejects(service.generate(body("A puzzle game"), operationKey), (error: unknown) => error instanceof SpecModelUpstreamError && !error.dispatched);
  assert.deepEqual(await service.generate(body("A puzzle game"), operationKey), result.result);
  assert.equal(generator.calls, 2);
});

class FixedGenerator implements SpecModelGenerator {
  calls = 0;
  constructor(private readonly receipt: SpecGenerationReceipt) {}
  async generate() { this.calls += 1; return this.receipt; }
  async probe() {}
}

function broker(generator: SpecModelGenerator) {
  return new SpecModelBrokerService({
    store: new MemorySpecModelOperationStore(),
    authority: new MemorySpecModelProviderAuthority(provider),
    generator,
    profileRevisionId: provider.profileRevisionId,
  });
}

function body(userMessage: string) {
  return {
    schemaVersion: "deviludo.spec-generation.v1",
    tenantId,
    projectId,
    conversationId,
    history: [],
    current: null,
    userMessage,
    outputSchema: "deviludo.spec-model-result.v1",
    toolsAllowed: false,
  };
}

async function generatedResult(userMessage: string): Promise<SpecGenerationReceipt> {
  const result = await new DeterministicLocalSpecModel().generate({
    operationKey,
    tenantId,
    projectId,
    conversationId,
    history: [],
    current: null,
    userMessage,
  });
  return Object.freeze({ result, usage: Object.freeze({ inputTokens: 64, outputTokens: 128 }) });
}
