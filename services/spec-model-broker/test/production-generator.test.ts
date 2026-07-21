import assert from "node:assert/strict";
import test from "node:test";
import type { DnsResolver } from "../../../lib/security/network";
import { DeterministicLocalSpecModel } from "../../spec-dialogue/src/model";
import { parseSpecGenerationRequest } from "../src/contract";
import type { SpecModelCredentialLease, SpecModelCredentialResolver, SpecModelProviderBinding } from "../src/contracts";
import { SpecModelUpstreamError } from "../src/contracts";
import { ProductionSpecModelGenerator, type SpecModelUpstreamTransport } from "../src/production-generator";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const operationKey = "a".repeat(64);
const result = await new DeterministicLocalSpecModel().generate({
  operationKey, tenantId, projectId, conversationId, history: [], current: null, userMessage: "A tactics game",
});

test("OpenAI Responses generation pins DNS, disables tools, requests strict JSON and wipes the lease", async () => {
  const credential = new CredentialFixture();
  let captured!: Parameters<SpecModelUpstreamTransport["request"]>[0];
  const generator = new ProductionSpecModelGenerator({
    credentials: credential,
    dns: publicDns,
    transport: { async request(input) {
      captured = { ...input, body: Buffer.from(input.body) };
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          id: "resp_1", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(result) }] }],
          usage: { input_tokens: 91, output_tokens: 203 },
        })),
      };
    } },
  });
  const receipt = await generator.generate({ operationKey, request: request(), provider: provider("openai-responses") });
  assert.deepEqual(receipt, { result, usage: { inputTokens: 91, outputTokens: 203 } });
  assert.equal(captured.url.toString(), "https://api.example.com/v1/responses");
  assert.equal(captured.endpoint.connectAddresses[0]?.address, "93.184.216.34");
  assert.equal(captured.headers.authorization, "Bearer provider-key-value");
  assert.equal(captured.headers["idempotency-key"], operationKey);
  const body = JSON.parse(captured.body.toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(body.tools, []);
  assert.equal((body.text as { format: { type: string; strict: boolean } }).format.type, "json_schema");
  assert.equal((body.text as { format: { type: string; strict: boolean } }).format.strict, true);
  assert.equal(JSON.stringify(body).includes("provider-key-value"), false);
  assert.ok(credential.destroyed);
  assert.ok([...credential.bytes].every((value) => value === 0));
});

test("Anthropic Messages generation uses output_config JSON schema and no tool definitions", async () => {
  const credential = new CredentialFixture();
  let captured!: Parameters<SpecModelUpstreamTransport["request"]>[0];
  const generator = new ProductionSpecModelGenerator({
    credentials: credential,
    dns: publicDns,
    transport: { async request(input) {
      captured = { ...input, body: Buffer.from(input.body) };
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          id: "msg_1", type: "message", role: "assistant", stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(result) }],
          usage: { input_tokens: 80, output_tokens: 180 },
        })),
      };
    } },
  });
  await generator.generate({ operationKey, request: request(), provider: provider("anthropic-messages") });
  assert.equal(captured.url.toString(), "https://api.example.com/v1/messages");
  assert.equal(captured.headers["x-api-key"], "provider-key-value");
  assert.equal(captured.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(captured.body.toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(body.tools, []);
  assert.equal((body.output_config as { format: { type: string } }).format.type, "json_schema");
  assert.equal("instructions" in body, false);
  assert.ok(credential.destroyed);
});

test("private DNS is rejected before credential access and malformed charged output is indeterminate", async () => {
  const credential = new CredentialFixture();
  const privateDns: DnsResolver = { async resolve() { return [{ address: "127.0.0.1", family: 4 }]; } };
  const blocked = new ProductionSpecModelGenerator({
    credentials: credential,
    dns: privateDns,
    transport: { async request() { throw new Error("must not dispatch"); } },
  });
  await assert.rejects(
    blocked.generate({ operationKey, request: request(), provider: provider("openai-responses") }),
    (error: unknown) => error instanceof SpecModelUpstreamError && !error.dispatched,
  );
  assert.equal(credential.resolveCalls, 0);

  const chargedCredential = new CredentialFixture();
  const malformed = new ProductionSpecModelGenerator({
    credentials: chargedCredential,
    dns: publicDns,
    transport: { async request() {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          id: "resp_2", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] }],
          usage: { input_tokens: 10, output_tokens: 10 },
        })),
      };
    } },
  });
  await assert.rejects(
    malformed.generate({ operationKey, request: request(), provider: provider("openai-responses") }),
    (error: unknown) => error instanceof SpecModelUpstreamError && error.dispatched,
  );
  assert.ok(chargedCredential.destroyed);
});

class CredentialFixture implements SpecModelCredentialResolver {
  readonly bytes = Buffer.from("provider-key-value");
  resolveCalls = 0;
  destroyed = false;
  async resolve(): Promise<SpecModelCredentialLease> {
    this.resolveCalls += 1;
    return {
      value: this.bytes,
      destroy: () => { this.bytes.fill(0); this.destroyed = true; },
    };
  }
  async probe() {}
}

const publicDns: DnsResolver = {
  async resolve() { return [{ address: "93.184.216.34", family: 4, cnameChain: ["edge.example.com"] }]; },
};

function request() {
  return parseSpecGenerationRequest({
    schemaVersion: "deviludo.spec-generation.v1",
    tenantId,
    projectId,
    conversationId,
    history: [],
    current: null,
    userMessage: "A tactics game",
    outputSchema: "deviludo.spec-model-result.v1",
    toolsAllowed: false,
  });
}

function provider(protocol: "anthropic-messages" | "openai-responses"): SpecModelProviderBinding {
  return Object.freeze({
    profileRevisionId: "profile-spec-r1",
    providerRevisionId: "provider-r1",
    credentialVersionId: "credential-v1",
    agent: protocol === "anthropic-messages" ? "claude-code" : "codex-cli",
    protocol,
    baseUrl: "https://api.example.com/v1",
    approvedPorts: Object.freeze([443]),
    authentication: protocol === "anthropic-messages" ? "x-api-key" : "authorization-bearer",
    model: protocol === "anthropic-messages" ? "claude-haiku-4-5-20251001" : "gpt-5-mini-2025-08-07",
    policyDigest: "b".repeat(64),
  });
}
