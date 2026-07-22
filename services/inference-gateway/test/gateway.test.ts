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
import { PROVIDER_PROBE_CHECKS } from "../src/provider-probe";
import { InferenceRequestClaimError } from "../src/production-connector";

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
  pricing: Object.freeze({ inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 8 }),
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
    usage: {
      async get() { return overrides.usage ?? zeroUsage; },
      async claim() { return "ACQUIRED"; },
      async complete() {}, async release() {}, async abandon() {},
    },
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
  assert.equal(health.statusCode, 503);
  assert.equal(health.json().schemaVersion, "deviludo.inference-gateway-health.v1");
  assert.equal(health.json().status, "unavailable");
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

test("Inference Gateway readiness recursively probes dependencies and returns a bounded identity", async () => {
  let probes = 0;
  const connector = { async forward() { throw new Error("not used"); } };
  const server = buildInferenceGateway({
    ...options(), connector,
    readiness: { async probe() { probes += 1; } },
  });
  for (const url of ["/health", "/healthz"]) {
    const response = await server.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), {
      schemaVersion: "deviludo.inference-gateway-health.v1",
      status: "ok",
      service: "deviludo-inference-gateway",
      connector: "CONFIGURED",
      providerProbe: "NOT_CONFIGURED",
      reconciliation: "NOT_CONFIGURED",
    });
  }
  assert.equal(probes, 2);
  await server.close();

  const secret = "postgres-password-must-not-leak";
  const unavailable = buildInferenceGateway({
    ...options(), connector,
    readiness: { async probe() { throw new Error(secret); } },
  });
  const response = await unavailable.inject({ method: "GET", url: "/healthz" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, "unavailable");
  assert.equal(response.body.includes(secret), false);
  assert.deepEqual(Object.keys(response.json()).sort(), [
    "connector", "providerProbe", "reconciliation", "schemaVersion", "service", "status",
  ]);
  await unavailable.close();
});

test("Provider probe HTTP boundary requires its workload authorizer and returns only fixed checks", async () => {
  let authorized = 0;
  let received: unknown;
  const server = buildInferenceGateway({
    ...options(),
    providerProbe: {
      async run(value) {
        received = value;
        return {
          providerRevisionId: "provider-r1",
          checks: Object.freeze(Object.fromEntries(PROVIDER_PROBE_CHECKS.map((name) => [name, "PASS"])) as Record<(typeof PROVIDER_PROBE_CHECKS)[number], "PASS">),
        };
      },
    },
    authorizeProviderProbe() { authorized += 1; },
  });
  const payload = { providerRevisionId: "provider-r1", noCredentialBytes: true };
  const response = await server.inject({ method: "POST", url: "/v1/provider-probes", payload });
  assert.equal(response.statusCode, 200);
  assert.equal(authorized, 1);
  assert.deepEqual(received, payload);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(response.json().checks), [...PROVIDER_PROBE_CHECKS]);
  await server.close();

  const forbidden = buildInferenceGateway({
    ...options(),
    providerProbe: { async run() { throw new Error("must not run"); } },
    authorizeProviderProbe() { throw new Error("untrusted workload"); },
  });
  const denied = await forbidden.inject({ method: "POST", url: "/v1/provider-probes", payload });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "PROVIDER_PROBE_WORKLOAD_FORBIDDEN");
  await forbidden.close();
});

test("HTTP boundary returns stable run-claim errors without exposing internal state", async () => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await issueRunToken(signingKey, { ...claims, iat: issuedAt, exp: issuedAt + 600 });
  for (const [code, status] of [
    ["RUN_INFERENCE_BUSY", 409],
    ["RUN_INFERENCE_RECONCILIATION_REQUIRED", 503],
    ["RUN_BUDGET_EXHAUSTED", 429],
  ] as const) {
    const server = buildInferenceGateway({
      ...options(),
      connector: { async forward() { throw new InferenceRequestClaimError(code, status); } },
    });
    const response = await server.inject({
      method: "POST", url: "/v1/responses", headers: { authorization: `Bearer ${token}` }, payload: { model, input: "x" },
    });
    assert.equal(response.statusCode, status);
    assert.equal(response.json().error.code, code);
    await server.close();
  }
});

test("inference reconciliation HTTP boundary requires its dedicated workload identity", async () => {
  const payload = {
    operationKey: "a".repeat(64),
    tenantId: "11111111-1111-4111-8111-111111111111",
    runId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    action: "CONFIRM_NO_USAGE" as const,
    evidenceDigest: "b".repeat(64),
    reconciledBy: "security-admin@example.com",
  };
  let received: unknown;
  const server = buildInferenceGateway({
    ...options(),
    reconciliation: {
      async lookup() { return null; },
      async run(value) {
        received = value;
        return {
          ...payload, state: "RELEASED", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          reconciledAt: "2026-07-18T00:00:00.000Z",
        };
      },
    },
    authorizeReconciliation() {},
  });
  const response = await server.inject({ method: "POST", url: "/v1/inference-reconciliations", payload });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, payload);
  assert.equal(response.headers["cache-control"], "no-store");
  await server.close();

  const forbidden = buildInferenceGateway({
    ...options(),
    reconciliation: { async lookup() { throw new Error("must not run"); }, async run() { throw new Error("must not run"); } },
    authorizeReconciliation() { throw new Error("wrong workload"); },
  });
  const denied = await forbidden.inject({ method: "POST", url: "/v1/inference-reconciliations", payload });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "INFERENCE_RECONCILIATION_WORKLOAD_FORBIDDEN");
  await forbidden.close();
});

test("inference reconciliation lookup returns only the unresolved request identity", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const runId = "33333333-3333-4333-8333-333333333333";
  const server = buildInferenceGateway({
    ...options(),
    reconciliation: {
      async lookup(value) {
        assert.deepEqual(value, { tenantId, runId });
        return {
          tenantId, runId, requestId: "44444444-4444-4444-8444-444444444444",
          providerRevisionId: "provider-codex-r3", model, state: "INDETERMINATE",
          claimExpiresAt: "2026-07-18T00:00:00.000Z", createdAt: "2026-07-17T23:48:00.000Z",
        };
      },
      async run() { throw new Error("must not run"); },
    },
    authorizeReconciliation() {},
  });
  const response = await server.inject({
    method: "POST", url: "/v1/inference-reconciliations/lookup", payload: { tenantId, runId },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().requestId, "44444444-4444-4444-8444-444444444444");
  assert.equal("credentialVersionId" in response.json(), false);
  assert.equal(response.headers["cache-control"], "no-store");
  await server.close();
});
