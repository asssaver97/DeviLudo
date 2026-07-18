import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { inferenceGatewayRegistries, PostgresInferenceGatewayStore } from "../src/postgres-store";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";
const providerRevisionId = "provider-codex-r3";
const credentialVersionId = "credential-codex-v4";
const model = "gpt-5.3-codex-2026-06-12";

test("PostgreSQL Gateway registries use tenant RLS and preserve exact immutable bindings", async () => {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  let releases = 0;
  let requestClaimCreated = false;
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      calls.push({ text, values });
      if (text.includes("FROM deviludo.inference_run_authorizations")) return result<Row>([{
        tenant_id: tenantId, project_id: projectId, run_id: runId,
        profile_revision_id: "profile-codex-r7", provider_revision_id: providerRevisionId,
        credential_version_id: credentialVersionId, models: [model],
        budget: { maxCostUsd: 12, maxInputTokens: 10_000, maxOutputTokens: 4_000 },
        nonce: "run-nonce-1", state: "ACTIVE",
      }]);
      if (text.includes("FROM deviludo.inference_provider_revisions")) return result<Row>([{
        provider_revision_id: providerRevisionId, agent: "codex-cli", protocol: "openai-responses",
        base_url: "https://provider.example.com/v1", approved_ports: [443], authentication: "bearer",
        models: { primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model },
        credential_version_id: credentialVersionId, input_usd_per_million_tokens: "2.00000000",
        output_usd_per_million_tokens: "8.00000000", state: "ACTIVE",
      }]);
      if (text.includes("FROM deviludo.inference_request_claims")) return result<Row>(requestClaimCreated ? [{
        request_id: requestId, tenant_id: tenantId, project_id: projectId, run_id: runId,
        provider_revision_id: providerRevisionId, credential_version_id: credentialVersionId,
        model, claim_token: claimToken, state: "ACTIVE", expired: false,
      }] : []);
      if (text.includes("sum(input_tokens)")) return result<Row>([{ input_tokens: "100", output_tokens: "50", cost_usd: "0.0006000000" }]);
      if (text.includes("INSERT INTO deviludo.inference_request_claims")) { requestClaimCreated = true; return result<Row>([], 1); }
      if (text.includes("UPDATE deviludo.inference_request_claims")) return result<Row>([], 1);
      if (text.includes("INSERT INTO deviludo.inference_usage_events")) return result<Row>([], 1);
      if (text.includes("FROM deviludo.inference_usage_events")) return result<Row>([{
        tenant_id: tenantId, project_id: projectId, run_id: runId,
        provider_revision_id: providerRevisionId, credential_version_id: credentialVersionId,
        model, input_tokens: "100", output_tokens: "50", cost_usd: "0.0006000000",
      }]);
      return result<Row>([]);
    },
    release() { releases += 1; },
  };
  const pool: PostgresWorkflowPool = { async connect() { return client; } };
  const store = new PostgresInferenceGatewayStore(pool);
  const registries = inferenceGatewayRegistries(store);

  const run = await registries.runs.get(tenantId, runId);
  const provider = await registries.providers.get(tenantId, providerRevisionId);
  const usage = await registries.usage.get(tenantId, runId);
  const claim = { requestId, claimToken, tenantId, projectId, runId, providerRevisionId, credentialVersionId, model, leaseSeconds: 660 };
  assert.equal(await registries.usage.claim(claim), "ACQUIRED");
  await registries.usage.complete({
    ...claim,
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0006 },
  });

  assert.equal(run?.runId, runId);
  assert.deepEqual(run?.models, [model]);
  assert.equal(provider?.protocol, "openai-responses");
  assert.equal(provider?.pricing.outputUsdPerMillionTokens, 8);
  assert.deepEqual(usage, { inputTokens: 100, outputTokens: 50, costUsd: 0.0006 });
  assert.equal(releases, 5);
  const tenantScopes = calls.filter((call) => call.text.includes("set_config('app.tenant_id'"));
  assert.equal(tenantScopes.length, 5);
  assert.ok(tenantScopes.every((call) => call.values?.[0] === tenantId));
  const usageInsert = calls.find((call) => call.text.includes("INSERT INTO deviludo.inference_usage_events"));
  assert.deepEqual(usageInsert?.values, [
    requestId, tenantId, projectId, runId, providerRevisionId, credentialVersionId, model, 100, 50, 0.0006,
  ]);
});

test("PostgreSQL Gateway state parser rejects a floating model and rolls back", async () => {
  const calls: string[] = [];
  const pool: PostgresWorkflowPool = {
    async connect() {
      return {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string) {
          calls.push(text);
          if (text.includes("FROM deviludo.inference_provider_revisions")) return result<Row>([{
            provider_revision_id: providerRevisionId, agent: "codex-cli", protocol: "openai-responses",
            base_url: "https://provider.example.com/v1", approved_ports: [443], authentication: "bearer",
            models: { primaryModel: "latest", planningModel: model, smallFastModel: model, subagentModel: model },
            credential_version_id: credentialVersionId, input_usd_per_million_tokens: "2",
            output_usd_per_million_tokens: "8", state: "ACTIVE",
          }]);
          return result<Row>([]);
        },
        release() {},
      };
    },
  };
  const store = new PostgresInferenceGatewayStore(pool);
  await assert.rejects(store.getProvider(tenantId, providerRevisionId), /PostgreSQL state is invalid/);
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("PostgreSQL request claim serializes a run and turns an expired dispatch into reconciliation", async () => {
  for (const scenario of [
    { state: "ACTIVE", expired: false, expected: "BUSY" },
    { state: "ACTIVE", expired: true, expected: "INDETERMINATE" },
    { state: "INDETERMINATE", expired: true, expected: "INDETERMINATE" },
  ] as const) {
    const calls: string[] = [];
    const pool = poolWithQuery(async <Row extends Record<string, unknown>>(text: string) => {
      calls.push(text);
      if (text.includes("FROM deviludo.inference_run_authorizations")) return result<Row>([runRow()]);
      if (text.includes("FROM deviludo.inference_request_claims")) return result<Row>([claimRow(scenario.state, scenario.expired)]);
      if (text.includes("UPDATE deviludo.inference_request_claims")) return result<Row>([], 1);
      return result<Row>([]);
    });
    const outcome = await inferenceGatewayRegistries(new PostgresInferenceGatewayStore(pool)).usage.claim(claimBinding());
    assert.equal(outcome, scenario.expected);
    assert.ok(calls.findIndex((text) => text.includes("FOR UPDATE") && text.includes("inference_run_authorizations"))
      < calls.findIndex((text) => text.includes("inference_request_claims")));
    assert.equal(calls.some((text) => text.includes("SET state = 'INDETERMINATE'")), scenario.state === "ACTIVE" && scenario.expired);
  }
});

test("PostgreSQL request claim rechecks the durable budget after taking the run lock", async () => {
  const pool = poolWithQuery(async <Row extends Record<string, unknown>>(text: string) => {
    if (text.includes("FROM deviludo.inference_run_authorizations")) return result<Row>([runRow()]);
    if (text.includes("FROM deviludo.inference_request_claims")) return result<Row>([]);
    if (text.includes("sum(input_tokens)")) return result<Row>([{ input_tokens: "10000", output_tokens: "50", cost_usd: "12" }]);
    if (text.includes("INSERT INTO deviludo.inference_request_claims")) throw new Error("budget-exhausted claim must not insert");
    return result<Row>([]);
  });
  const outcome = await inferenceGatewayRegistries(new PostgresInferenceGatewayStore(pool)).usage.claim(claimBinding());
  assert.equal(outcome, "BUDGET_EXHAUSTED");
});

test("PostgreSQL reconciliation records priced usage once and rejects changed replay evidence", async () => {
  const operationKey = "a".repeat(64);
  const evidenceDigest = "b".repeat(64);
  const reconciledAt = "2026-07-18T03:00:00.000Z";
  let terminal = false;
  const payloadDigest = sha256Canonical({
    tenantId, runId, requestId, action: "RECORD_USAGE", evidenceDigest,
    reconciledBy: "security-admin", inputTokens: 120, outputTokens: 30,
  });
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const pool = poolWithQuery(async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
    calls.push({ text, values });
    if (text.includes("FROM deviludo.inference_run_authorizations")) return result<Row>([{ run_id: runId }]);
    if (text.includes("JOIN deviludo.inference_provider_revisions")) return result<Row>([{
      ...claimRow(terminal ? "COMPLETED" : "INDETERMINATE", true),
      input_usd_per_million_tokens: "2", output_usd_per_million_tokens: "8",
      reconciliation_operation_key: terminal ? operationKey : null,
      reconciliation_payload_digest: terminal ? payloadDigest : null,
      reconciliation_action: terminal ? "RECORD_USAGE" : null,
      reconciliation_evidence_digest: terminal ? evidenceDigest : null,
      reconciled_by: terminal ? "security-admin" : null,
      reconciled_at: terminal ? reconciledAt : null,
    }]);
    if (text.includes("INSERT INTO deviludo.inference_usage_events")) return result<Row>([], 1);
    if (text.includes("SET state = $4")) { terminal = true; return result<Row>([{ reconciled_at: reconciledAt }], 1); }
    if (text.includes("FROM deviludo.inference_usage_events")) {
      return result<Row>([{ input_tokens: "120", output_tokens: "30", cost_usd: "0.00048" }]);
    }
    return result<Row>([]);
  });
  const store = new PostgresInferenceGatewayStore(pool);
  const input = {
    operationKey, tenantId, runId, requestId, action: "RECORD_USAGE" as const,
    evidenceDigest, reconciledBy: "security-admin", inputTokens: 120, outputTokens: 30,
  };
  const first = await store.reconcile(input);
  assert.deepEqual(first.usage, { inputTokens: 120, outputTokens: 30, costUsd: 0.00048 });
  assert.equal(first.state, "COMPLETED");
  const usageInsert = calls.find((call) => call.text.includes("INSERT INTO deviludo.inference_usage_events"));
  assert.deepEqual(usageInsert?.values?.slice(-3), [120, 30, 0.00048]);
  const replay = await store.reconcile(input);
  assert.deepEqual(replay, first);
  assert.equal(calls.filter((call) => call.text.includes("INSERT INTO deviludo.inference_usage_events")).length, 1);
  await assert.rejects(
    store.reconcile({ ...input, evidenceDigest: "c".repeat(64) }),
    /reconciliation was rejected/,
  );
});

test("PostgreSQL reconciliation releases only an indeterminate request confirmed as unbilled", async () => {
  const calls: string[] = [];
  const pool = poolWithQuery(async <Row extends Record<string, unknown>>(text: string) => {
    calls.push(text);
    if (text.includes("FROM deviludo.inference_run_authorizations")) return result<Row>([{ run_id: runId }]);
    if (text.includes("JOIN deviludo.inference_provider_revisions")) return result<Row>([{
      ...claimRow("INDETERMINATE", true),
      input_usd_per_million_tokens: "2", output_usd_per_million_tokens: "8",
      reconciliation_operation_key: null, reconciliation_payload_digest: null,
      reconciliation_action: null, reconciliation_evidence_digest: null,
      reconciled_by: null, reconciled_at: null,
    }]);
    if (text.includes("FROM deviludo.inference_usage_events")) return result<Row>([]);
    if (text.includes("SET state = $4")) return result<Row>([{ reconciled_at: "2026-07-18T04:00:00.000Z" }], 1);
    return result<Row>([]);
  });
  const receipt = await new PostgresInferenceGatewayStore(pool).reconcile({
    operationKey: "d".repeat(64), tenantId, runId, requestId,
    action: "CONFIRM_NO_USAGE", evidenceDigest: "e".repeat(64), reconciledBy: "security-admin",
  });
  assert.equal(receipt.state, "RELEASED");
  assert.deepEqual(receipt.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
  assert.equal(calls.some((text) => text.includes("INSERT INTO deviludo.inference_usage_events")), false);
});

test("PostgreSQL reconciliation lookup presents an expired lease as indeterminate without writing", async () => {
  const calls: string[] = [];
  const pool = poolWithQuery(async <Row extends Record<string, unknown>>(text: string) => {
    calls.push(text);
    if (text.includes("FROM deviludo.inference_run_authorizations")) return result<Row>([{ run_id: runId }]);
    if (text.includes("FROM deviludo.inference_request_claims")) return result<Row>([{
      ...claimRow("ACTIVE", true),
      claim_expires_at: "2026-07-18T00:00:00.000Z",
      created_at: "2026-07-17T23:48:00.000Z",
    }]);
    return result<Row>([]);
  });
  const status = await new PostgresInferenceGatewayStore(pool).lookup(tenantId, runId);
  assert.deepEqual(status, {
    tenantId, runId, requestId, providerRevisionId, model, state: "INDETERMINATE",
    claimExpiresAt: "2026-07-18T00:00:00.000Z", createdAt: "2026-07-17T23:48:00.000Z",
  });
  assert.equal(JSON.stringify(status).includes(credentialVersionId), false);
  assert.equal(calls.some((text) => text.includes("UPDATE deviludo.inference_request_claims")), false);
  assert.ok(calls.findIndex((text) => text.includes("inference_run_authorizations"))
    < calls.findIndex((text) => text.includes("inference_request_claims")));
});

function claimBinding() {
  return { requestId, claimToken, tenantId, projectId, runId, providerRevisionId, credentialVersionId, model, leaseSeconds: 660 };
}
function runRow() {
  return {
    tenant_id: tenantId, project_id: projectId, run_id: runId,
    profile_revision_id: "profile-codex-r7", provider_revision_id: providerRevisionId,
    credential_version_id: credentialVersionId, models: [model],
    budget: { maxCostUsd: 12, maxInputTokens: 10_000, maxOutputTokens: 4_000 },
    nonce: "run-nonce-1", state: "ACTIVE",
  };
}
function claimRow(state: "ACTIVE" | "COMPLETED" | "RELEASED" | "INDETERMINATE", expired: boolean) {
  return {
    request_id: requestId, tenant_id: tenantId, project_id: projectId, run_id: runId,
    provider_revision_id: providerRevisionId, credential_version_id: credentialVersionId,
    model, claim_token: claimToken, state, expired,
  };
}
function poolWithQuery(
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) => Promise<PostgresQueryResult<Row>>,
): PostgresWorkflowPool {
  return { async connect() { return { query, release() {} }; } };
}

function result<Row extends Record<string, unknown>>(
  rows: readonly Record<string, unknown>[],
  rowCount = rows.length,
): PostgresQueryResult<Row> {
  return { rows: rows as readonly Row[], rowCount };
}
