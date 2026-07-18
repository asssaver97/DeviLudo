import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  AuthorizedGatewayRequest,
  GatewayProtocol,
  UsageLedger,
} from "../src/contracts";
import {
  ProductionGatewayConnector,
  type GatewayCredentialResolver,
  type GatewayUpstreamTransport,
} from "../src/production-connector";

test("production connector resolves one bound key, pins the Responses endpoint and atomically records priced usage", async () => {
  const fixture = connectorFixture("openai-responses");
  const result = await fixture.connector.forward({
    authorization: fixture.authorization,
    body: { model: fixture.authorization.model, input: "implement the game" },
    signal: new AbortController().signal,
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { id: "resp_01", usage: { input_tokens: 100, output_tokens: 50 } });
  assert.equal(fixture.destroyed(), true);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0]?.url.pathname, "/v1/responses");
  assert.equal(fixture.calls[0]?.headers.authorization, "Bearer upstream-key-fixed");
  assert.equal(JSON.stringify(fixture.calls).includes("DLRT"), false);
  assert.equal(fixture.records.length, 1);
  assert.deepEqual(fixture.records[0]?.usage, { inputTokens: 100, outputTokens: 50, costUsd: 0.0006 });
  assert.equal(fixture.records[0]?.model, fixture.authorization.model);
});

test("production connector preserves Messages SSE while metering its terminal usage", async () => {
  const fixture = connectorFixture("anthropic-messages", {
    response: [
      "event: message_start\r\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":0}}}\r\n\r\n",
      "event: content_block_delta\r\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"done\"}}\r\n\r\n",
      "event: message_delta\r\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\r\n\r\n",
    ],
    contentType: "text/event-stream",
  });
  const result = await fixture.connector.forward({
    authorization: fixture.authorization,
    body: { model: fixture.authorization.model, max_tokens: 100, stream: true, messages: [{ role: "user", content: "fix" }] },
    signal: new AbortController().signal,
  });
  assert.ok(result.body instanceof Readable);
  const streamed = await readAll(result.body);
  assert.match(streamed.toString("utf8"), /content_block_delta/);
  assert.equal(fixture.calls[0]?.headers["x-api-key"], "upstream-key-fixed");
  assert.equal(fixture.calls[0]?.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(fixture.records[0]?.usage, { inputTokens: 12, outputTokens: 7, costUsd: 0.00008 });
});

test("production connector revalidates a same-origin 307 and refuses to send a key across origins", async () => {
  let requests = 0;
  const fixture = connectorFixture("openai-responses", {
    transport: {
      async request() {
        requests += 1;
        if (requests === 1) return {
          statusCode: 307,
          headers: { location: "https://provider.example.com/v1/responses" },
          body: Readable.from([]),
        };
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: Readable.from([JSON.stringify({ id: "resp_redirect", usage: { input_tokens: 1, output_tokens: 1 } })]),
        };
      },
    },
  });
  await fixture.connector.forward({ authorization: fixture.authorization, body: { model: fixture.authorization.model, input: "x" }, signal: new AbortController().signal });
  assert.equal(requests, 2);
  assert.equal(fixture.dnsCalls(), 1);

  const blocked = connectorFixture("openai-responses", {
    transport: {
      async request() {
        return { statusCode: 307, headers: { location: "https://other.example.com/v1/responses" }, body: Readable.from([]) };
      },
    },
  });
  await assert.rejects(blocked.connector.forward({
    authorization: blocked.authorization,
    body: { model: blocked.authorization.model, input: "x" },
    signal: new AbortController().signal,
  }), /connector policy is invalid/);
  assert.equal(blocked.destroyed(), true);
});

test("production connector strips credential-like upstream error bodies", async () => {
  const fixture = connectorFixture("openai-responses", {
    statusCode: 401,
    response: [JSON.stringify({ error: { message: "Authorization Bearer upstream-key-fixed", code: "bad_key" } })],
  });
  const result = await fixture.connector.forward({ authorization: fixture.authorization, body: { model: fixture.authorization.model }, signal: new AbortController().signal });
  assert.equal(result.statusCode, 502);
  assert.deepEqual(result.body, { error: { code: "UPSTREAM_REQUEST_REJECTED" } });
  assert.equal(fixture.records.length, 0);
});

test("production connector destroys a malformed credential lease before any network request", async () => {
  const authorization = authorizationFixture("openai-responses");
  const value = Buffer.from("short");
  let destroyed = false;
  let connected = false;
  const connector = new ProductionGatewayConnector({
    credentials: {
      async probe() {},
      async resolve() { return { value, destroy() { value.fill(0); destroyed = true; } }; },
    },
    usage: { async get() { return { inputTokens: 0, outputTokens: 0, costUsd: 0 }; }, async record() {} },
    dns: { async resolve() { return [{ address: "93.184.216.34", family: 4 as const }]; } },
    transport: { async request() { connected = true; throw new Error("must not connect"); } },
  });
  await assert.rejects(connector.forward({
    authorization,
    body: { model: authorization.model, input: "x" },
    signal: new AbortController().signal,
  }), /connector policy is invalid/);
  assert.equal(destroyed, true);
  assert.equal(connected, false);
  assert.ok([...value].every((byte) => byte === 0));
});

function connectorFixture(protocol: GatewayProtocol, overrides: Readonly<{
  response?: readonly string[];
  contentType?: string;
  statusCode?: number;
  transport?: GatewayUpstreamTransport;
}> = {}) {
  const authorization = authorizationFixture(protocol);
  let leaseDestroyed = false;
  let dnsCalls = 0;
  const records: Array<Parameters<UsageLedger["record"]>[0]> = [];
  const calls: Array<{ url: URL; headers: Readonly<Record<string, string>> }> = [];
  const credentials: GatewayCredentialResolver = {
    async probe() {},
    async resolve(input) {
      assert.equal(input.credentialVersionId, authorization.provider.credentialVersionId);
      const value = Buffer.from("upstream-key-fixed");
      return { value, destroy() { value.fill(0); leaseDestroyed = true; } };
    },
  };
  const usage: UsageLedger = {
    async get() { return { inputTokens: 0, outputTokens: 0, costUsd: 0 }; },
    async record(input) { records.push(input); },
  };
  const defaultBody = JSON.stringify({ id: "resp_01", usage: { input_tokens: 100, output_tokens: 50 } });
  const transport: GatewayUpstreamTransport = overrides.transport ?? {
    async request(input) {
      calls.push({ url: input.url, headers: input.headers });
      return {
        statusCode: overrides.statusCode ?? 200,
        headers: { "content-type": overrides.contentType ?? "application/json", "x-request-id": "upstream-request-1" },
        body: Readable.from(overrides.response ?? [defaultBody]),
      };
    },
  };
  const connector = new ProductionGatewayConnector({
    credentials,
    usage,
    dns: {
      async resolve() { dnsCalls += 1; return [{ address: "93.184.216.34", family: 4 as const }]; },
    },
    transport,
  });
  return { connector, authorization, calls, records, destroyed: () => leaseDestroyed, dnsCalls: () => dnsCalls };
}

function authorizationFixture(protocol: GatewayProtocol): AuthorizedGatewayRequest {
  const openai = protocol === "openai-responses";
  const model = openai ? "gpt-5.3-codex-2026-06-12" : "claude-sonnet-4-20250514";
  const providerRevisionId = openai ? "provider-codex-r3" : "provider-claude-r4";
  const credentialVersionId = openai ? "credential-codex-v4" : "credential-claude-v5";
  return Object.freeze({
    model,
    claims: {
      iss: "deviludo-control-plane", aud: "deviludo-inference-gateway", tenantId: "tenant-1", projectId: "project-1",
      runId: "run-1", profileRevisionId: "profile-r1", credentialVersionId, providerRevisionId, models: [model],
      budget: { maxCostUsd: 10, maxInputTokens: 1000, maxOutputTokens: 1000 }, iat: 1_800_000_000, exp: 1_800_000_600, nonce: "nonce-1",
    },
    run: {
      tenantId: "tenant-1", projectId: "project-1", runId: "run-1", profileRevisionId: "profile-r1",
      providerRevisionId, credentialVersionId, models: [model], budget: { maxCostUsd: 10, maxInputTokens: 1000, maxOutputTokens: 1000 },
      nonce: "nonce-1", state: "ACTIVE",
    },
    provider: {
      providerRevisionId,
      agent: openai ? "codex-cli" : "claude-code",
      protocol,
      baseUrl: "https://provider.example.com/v1",
      approvedPorts: [443],
      authentication: openai ? "bearer" : "x-api-key",
      models: { primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model },
      credentialVersionId,
      pricing: { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 8 },
      state: "ACTIVE",
    },
    endpoint: { url: "https://provider.example.com/v1", hostname: "provider.example.com", port: 443, connectAddresses: [{ address: "93.184.216.34", family: 4 }] },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    remainingBudget: { maxCostUsd: 10, maxInputTokens: 1000, maxOutputTokens: 1000 },
  } satisfies AuthorizedGatewayRequest);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of stream) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  return Buffer.concat(chunks);
}
