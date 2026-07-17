import assert from "node:assert/strict";
import test from "node:test";
import { issueRunToken, type RunTokenClaims } from "../../../lib/security/credentials";
import { InferenceGatewayAuthorizer } from "../src/authorization";
import { buildInferenceGateway } from "../src/http";
import type {
  ActiveRunAuthorization,
  GatewayProviderRevision,
  GatewayUsage,
  InferenceGatewayAuthorizerOptions,
} from "../src/contracts";

const signingKey = new Uint8Array(32).fill(19);
const now = 1_800_000_000;
const model = "gpt-5.3-codex-2026-06-12";
const claims: RunTokenClaims = Object.freeze({
  iss: "deviludo-control-plane",
  aud: "deviludo-inference-gateway",
  tenantId: "tenant-1",
  projectId: "project-1",
  runId: "run-1",
  profileRevisionId: "profile-codex-r7",
  credentialVersionId: "credential-codex-v4",
  providerRevisionId: "provider-codex-r3",
  models: Object.freeze([model]),
  budget: Object.freeze({ maxCostUsd: 12, maxInputTokens: 10_000, maxOutputTokens: 4_000 }),
  iat: now,
  exp: now + 600,
  nonce: "run-1-attempt-2-nonce",
});

const activeRun: ActiveRunAuthorization = Object.freeze({
  tenantId: claims.tenantId,
  projectId: claims.projectId,
  runId: claims.runId,
  profileRevisionId: claims.profileRevisionId,
  providerRevisionId: claims.providerRevisionId,
  credentialVersionId: claims.credentialVersionId,
  models: claims.models,
  budget: claims.budget,
  nonce: claims.nonce,
  state: "ACTIVE",
});

const provider: GatewayProviderRevision = Object.freeze({
  providerRevisionId: claims.providerRevisionId,
  agent: "codex-cli",
  protocol: "openai-responses",
  baseUrl: "https://provider.example.com/v1",
  approvedPorts: Object.freeze([443]),
  authentication: "bearer",
  models: Object.freeze({ primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model }),
  credentialVersionId: claims.credentialVersionId,
  state: "ACTIVE",
});

const zeroUsage: GatewayUsage = Object.freeze({ inputTokens: 100, outputTokens: 20, costUsd: 0.75 });

function options(overrides: Partial<{
  run: ActiveRunAuthorization | null;
  provider: GatewayProviderRevision | null;
  usage: GatewayUsage;
  address: string;
}> = {}): InferenceGatewayAuthorizerOptions {
  return {
    signingKey,
    runs: { async get() { return overrides.run === undefined ? activeRun : overrides.run; } },
    providers: { async get() { return overrides.provider === undefined ? provider : overrides.provider; } },
    usage: { async get() { return overrides.usage ?? zeroUsage; } },
    dns: { async resolve() { return [{ address: overrides.address ?? "93.184.216.34", family: 4 }]; } },
  };
}

test("authorizes only the fully registered immutable run and returns a DNS-pinned plan", async () => {
  const token = await issueRunToken(signingKey, claims);
  const result = await new InferenceGatewayAuthorizer(options()).authorize({
    token,
    protocol: "openai-responses",
    model,
    nowEpochSeconds: now + 1,
  });
  assert.equal(result.endpoint.hostname, "provider.example.com");
  assert.equal(result.endpoint.connectAddresses[0]?.address, "93.184.216.34");
  assert.equal(result.provider.credentialVersionId, claims.credentialVersionId);
  assert.equal(result.remainingBudget.maxCostUsd, 11.25);
  assert.equal(result.remainingBudget.maxInputTokens, 9_900);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("rejects registry drift, cross-protocol/model use, exhausted budget and rebinding", async () => {
  const token = await issueRunToken(signingKey, claims);
  const changedRun = { ...activeRun, credentialVersionId: "credential-codex-v5" } as ActiveRunAuthorization;
  await assert.rejects(
    new InferenceGatewayAuthorizer(options({ run: changedRun })).authorize({ token, protocol: "openai-responses", model, nowEpochSeconds: now + 1 }),
    /not active/,
  );
  await assert.rejects(
    new InferenceGatewayAuthorizer(options()).authorize({ token, protocol: "anthropic-messages", model, nowEpochSeconds: now + 1 }),
    /Provider revision is unavailable/,
  );
  await assert.rejects(
    new InferenceGatewayAuthorizer(options()).authorize({ token, protocol: "openai-responses", model: "gpt-5.4-codex-2026-07-01", nowEpochSeconds: now + 1 }),
    /outside the run allowlist/,
  );
  await assert.rejects(
    new InferenceGatewayAuthorizer(options({ usage: { inputTokens: 10_000, outputTokens: 20, costUsd: 12 } })).authorize({ token, protocol: "openai-responses", model, nowEpochSeconds: now + 1 }),
    /budget is exhausted/,
  );
  await assert.rejects(
    new InferenceGatewayAuthorizer(options({ address: "10.0.0.9" })).authorize({ token, protocol: "openai-responses", model, nowEpochSeconds: now + 1 }),
    /failed network policy/,
  );
});

test("HTTP boundary strips the run token, forwards only after authorization and filters headers", async () => {
  const token = await issueRunToken(signingKey, { ...claims, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 });
  const currentRun = { ...activeRun };
  let forwarded: { model?: unknown; maxOutputTokens?: unknown; credentialVersionId?: string; address?: string } | null = null;
  const server = buildInferenceGateway({
    ...options({ run: currentRun }),
    connector: {
      async forward(input) {
        forwarded = {
          model: input.body.model,
          maxOutputTokens: input.body.max_output_tokens,
          credentialVersionId: input.authorization.provider.credentialVersionId,
          address: input.authorization.endpoint.connectAddresses[0]?.address,
        };
        return {
          statusCode: 200,
          headers: { "content-type": "application/json", "set-cookie": "secret=must-not-leak", "x-internal-secret": "no" },
          body: { id: "response-safe", usage: { input_tokens: 4, output_tokens: 2 } },
        };
      },
    },
  });
  const response = await server.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: `Bearer ${token}` },
    payload: { model, input: "hello" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(forwarded, { model, maxOutputTokens: 3_980, credentialVersionId: claims.credentialVersionId, address: "93.184.216.34" });
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["x-internal-secret"], undefined);
  assert.doesNotMatch(response.body, new RegExp(token.replaceAll(".", "\\.")));

  const overBudget = await server.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: `Bearer ${token}` },
    payload: { model, input: "hello", max_output_tokens: 3_981 },
  });
  assert.equal(overBudget.statusCode, 429);
  assert.equal(overBudget.json().error.code, "RUN_BUDGET_EXCEEDED");
  await server.close();
});

test("HTTP boundary fails closed without a connector and never echoes invalid credentials", async () => {
  const server = buildInferenceGateway(options());
  const health = await server.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().connector, "NOT_CONFIGURED");

  const issuedAt = Math.floor(Date.now() / 1000);
  const validToken = await issueRunToken(signingKey, { ...claims, iat: issuedAt, exp: issuedAt + 600 });
  const unavailable = await server.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: `Bearer ${validToken}` },
    payload: { model, input: "hello" },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().error.code, "CONNECTOR_NOT_CONFIGURED");

  const invalid = "not-a-real-token-super-secret";
  const response = await server.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: `Bearer ${invalid}` },
    payload: { model, input: "hello" },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.includes(invalid), false);
  await server.close();
});
