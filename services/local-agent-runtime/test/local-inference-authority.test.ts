import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildInferenceGateway } from "../../inference-gateway/src/http";
import { PROVIDER_PROBE_CHECKS, type GatewayProviderProbeRequest } from "../../inference-gateway/src/provider-probe";
import type { GatewayUsageClaimBinding } from "../../inference-gateway/src/contracts";
import type { LocalAgentExecutionRequest } from "../src/contracts";
import { LocalInferenceAuthority } from "../src/local-inference-authority";
import { LocalProviderControl } from "../src/provider-control";

const provider: GatewayProviderProbeRequest = Object.freeze({
  providerRevisionId: "provider-claude-r9",
  agent: "claude-code",
  protocol: "anthropic-messages",
  baseUrl: "https://gateway.example.com/v1",
  approvedPorts: Object.freeze([443]),
  authentication: "x-api-key",
  models: Object.freeze({
    primaryModel: "claude-sonnet-4-6-20250514",
    planningModel: "claude-opus-4-6-20250514",
    smallFastModel: "claude-haiku-4-5-20251001",
    subagentModel: "claude-sonnet-4-6-20250514",
  }),
  credentialVersionId: "credential-claude-v9",
  requiredChecks: PROVIDER_PROBE_CHECKS,
});

const request: LocalAgentExecutionRequest = Object.freeze({
  tenantId: "tenant-local",
  projectId: "project-1",
  runId: "run-1",
  attemptId: "attempt-1",
  specRevisionId: "SPEC-001",
  testPlanRevisionId: "godot-testkit-1.0.0",
  profileRevisionId: "profile-claude-r9",
  installationId: "installation-claude-2201",
  agent: "claude-code",
  expectedVersion: "2.1.201",
  imageDigest: `sha256:${"a".repeat(64)}`,
  adapterVersion: "1.3.0",
  providerRevisionId: provider.providerRevisionId,
  providerProtocol: provider.protocol,
  credentialVersionId: provider.credentialVersionId,
  model: provider.models.primaryModel,
  modelRoles: provider.models,
  budget: Object.freeze({ maxTurns: 64, maxCostUsd: 2, maxInputTokens: 1_000, maxOutputTokens: 400 }),
  timeoutSeconds: 7200,
  promptDigest: createHash("sha256").update("Implement the approved game.").digest("hex"),
  prompt: "Implement the approved game.",
});

async function activeControl(scope: "platform" | "tenant" | "project" = "project", scopeId = request.projectId) {
  const control = new LocalProviderControl({
    async run(value) {
      return Object.freeze({
        providerRevisionId: (value as GatewayProviderProbeRequest).providerRevisionId,
        checks: Object.freeze(Object.fromEntries(PROVIDER_PROBE_CHECKS.map((check) => [check, "PASS"])) as Record<(typeof PROVIDER_PROBE_CHECKS)[number], "PASS">),
      });
    },
  });
  control.putCredential({ credentialVersionId: provider.credentialVersionId, secret: "sk-upstream-never-reaches-cli" });
  await control.probe({
    provider,
    binding: {
      profileRevisionId: request.profileRevisionId,
      scope,
      scopeId,
      pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    },
  });
  control.activate({
    providerRevisionId: provider.providerRevisionId,
    profileRevisionId: request.profileRevisionId,
    credentialVersionId: provider.credentialVersionId,
  });
  return control;
}

test("local inference authority issues one exact short token and the Gateway enforces its model and budget", async () => {
  const control = await activeControl();
  const authority = new LocalInferenceAuthority(control, { signingKey: new Uint8Array(32).fill(29) });
  const prepared = await authority.issue({ request, baseCommitSha: "b".repeat(40) });
  assert.match(prepared.secretRef, /^secret:\/\/local-run-token\//);
  assert.equal(JSON.stringify(prepared).includes("sk-upstream"), false);
  const token = await authority.secrets.resolve(prepared.secretRef, {
    runId: request.runId,
    attemptId: request.attemptId,
    environmentVariable: "ANTHROPIC_API_KEY",
  });
  assert.equal(token.split(".").length, 3);
  assert.equal(token.includes("sk-upstream"), false);
  await assert.rejects(authority.secrets.resolve(prepared.secretRef, {
    runId: request.runId,
    attemptId: "attempt-other",
    environmentVariable: "ANTHROPIC_API_KEY",
  }), /unavailable/);

  const signingKey = authority.signingKey();
  let forwardedModel = "";
  let forwardedLimit = 0;
  const gateway = buildInferenceGateway({
    signingKey,
    runs: authority.runs,
    providers: authority.providers,
    usage: authority.usage,
    dns: { async resolve() { return [{ address: "93.184.216.34", family: 4 as const }]; } },
    connector: {
      async forward(input) {
        forwardedModel = input.authorization.model;
        forwardedLimit = Number(input.body.max_tokens);
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: {
          id: "message-local", usage: { input_tokens: 5, output_tokens: 3 },
        } };
      },
    },
  });
  signingKey.fill(0);
  const response = await gateway.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": token },
    payload: { model: request.model, messages: [{ role: "user", content: "build" }] },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(forwardedModel, request.model);
  assert.equal(forwardedLimit, request.budget.maxOutputTokens);

  const wrongModel = await gateway.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": token },
    payload: { model: "claude-sonnet-4-7-20260701", messages: [] },
  });
  assert.equal(wrongModel.statusCode, 403);
  assert.equal(wrongModel.json().error.code, "MODEL_NOT_ALLOWED");

  await prepared.revoke();
  await assert.rejects(authority.secrets.resolve(prepared.secretRef, {
    runId: request.runId,
    attemptId: request.attemptId,
    environmentVariable: "ANTHROPIC_API_KEY",
  }), /unavailable/);
  const revoked = await gateway.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": token },
    payload: { model: request.model, messages: [] },
  });
  assert.equal(revoked.statusCode, 403);
  assert.equal(revoked.json().error.code, "RUN_BINDING_MISMATCH");
  await gateway.close();
  authority.close();
  control.close();
});

test("local usage ledger serializes inference and records priced budget consumption", async () => {
  const control = await activeControl("tenant", request.tenantId);
  const authority = new LocalInferenceAuthority(control, { signingKey: new Uint8Array(32).fill(31) });
  const prepared = await authority.issue({ request, baseCommitSha: "c".repeat(40) });
  const claim: GatewayUsageClaimBinding = Object.freeze({
    requestId: "request-1",
    claimToken: "claim-1",
    tenantId: request.tenantId,
    projectId: request.projectId,
    runId: request.runId,
    providerRevisionId: request.providerRevisionId,
    credentialVersionId: request.credentialVersionId,
    model: request.model,
    leaseSeconds: 60,
  });
  assert.equal(await authority.usage.claim(claim), "ACQUIRED");
  assert.equal(await authority.usage.claim({ ...claim, requestId: "request-2", claimToken: "claim-2" }), "BUSY");
  await authority.usage.complete({ ...claim, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0006 } });
  assert.deepEqual(await authority.usage.get(request.tenantId, request.runId), {
    inputTokens: 100, outputTokens: 20, costUsd: 0.0006,
  });
  await prepared.revoke();
  authority.close();
  control.close();
});

test("local inference authority renews the stable SecretRef with independently capped DLRTs", async () => {
  const control = await activeControl();
  let now = new Date("2026-07-24T00:00:00.000Z");
  const authority = new LocalInferenceAuthority(control, {
    signingKey: new Uint8Array(32).fill(41),
    now: () => now,
  });
  const prepared = await authority.issue({ request, baseCommitSha: "e".repeat(40) });
  const context = {
    runId: request.runId,
    attemptId: request.attemptId,
    environmentVariable: "ANTHROPIC_API_KEY",
  } as const;
  const initial = await authority.secrets.resolve(prepared.secretRef, context);
  assert.equal((await prepared.renew()).renewed, false);

  now = new Date("2026-07-24T00:11:00.000Z");
  const renewed = await prepared.renew();
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.expiresAt, "2026-07-24T00:26:00.000Z");
  const replacement = await authority.secrets.resolve(prepared.secretRef, context);
  assert.notEqual(replacement, initial);
  assert.equal(replacement.includes("sk-upstream"), false);
  assert.equal((await prepared.renew()).renewed, false);

  now = new Date("2026-07-24T02:01:00.000Z");
  await assert.rejects(prepared.renew(), /cannot be renewed/);
  await prepared.revoke();
  await assert.rejects(prepared.renew(), /unavailable/);
  await assert.rejects(authority.secrets.resolve(prepared.secretRef, context), /unavailable/);
  authority.close();
  control.close();
});

test("local run issuance rejects a Provider activated for another project scope", async () => {
  const control = await activeControl("project", "project-other");
  const authority = new LocalInferenceAuthority(control, { signingKey: new Uint8Array(32).fill(37) });
  await assert.rejects(authority.issue({ request, baseCommitSha: "d".repeat(40) }), /not active/);
  authority.close();
  control.close();
});
