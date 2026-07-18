import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InferenceGatewayReconciliationClient } from "../src/inference-reconciliation";
import type { ProviderProbeHttpRequest } from "../src/provider-probe";

const input = {
  operationKey: "a".repeat(64),
  tenantId: "11111111-1111-4111-8111-111111111111",
  runId: "33333333-3333-4333-8333-333333333333",
  requestId: "44444444-4444-4444-8444-444444444444",
  action: "RECORD_USAGE" as const,
  evidenceDigest: "b".repeat(64),
  reconciledBy: "security-admin@example.com",
  inputTokens: 120,
  outputTokens: 30,
};

test("control-plane reconciliation client uses fixed mTLS route and verifies the complete receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-inference-reconciliation-"));
  try {
    const key = join(directory, "client.key");
    const certificate = join(directory, "client.crt");
    const ca = join(directory, "ca.crt");
    await Promise.all([writeFile(key, Buffer.alloc(64, 1)), writeFile(certificate, Buffer.alloc(64, 2)), writeFile(ca, Buffer.alloc(64, 3))]);
    const calls: Array<{ url: string; request: ProviderProbeHttpRequest }> = [];
    const client = new InferenceGatewayReconciliationClient({
      NODE_ENV: "production",
      DEVILUDO_INFERENCE_RECONCILIATION_URL: "https://inference-gateway.internal/v1/inference-reconciliations",
      DEVILUDO_INFERENCE_RECONCILIATION_TLS_KEY_FILE: key,
      DEVILUDO_INFERENCE_RECONCILIATION_TLS_CERT_FILE: certificate,
      DEVILUDO_INFERENCE_RECONCILIATION_CA_FILE: ca,
    }, async (url, request) => {
      calls.push({ url: url.href, request });
      if (url.pathname.endsWith("/lookup")) {
        return {
          statusCode: 200,
          payload: {
            tenantId: input.tenantId,
            runId: input.runId,
            requestId: input.requestId,
            providerRevisionId: "provider-codex-r3",
            model: "gpt-5.3-codex-2026-06-12",
            state: "INDETERMINATE",
            claimExpiresAt: "2026-07-18T00:00:00.000Z",
            createdAt: "2026-07-17T23:48:00.000Z",
          },
        };
      }
      return {
        statusCode: 200,
        payload: {
          operationKey: input.operationKey,
          tenantId: input.tenantId,
          runId: input.runId,
          requestId: input.requestId,
          action: input.action,
          evidenceDigest: input.evidenceDigest,
          state: "COMPLETED",
          usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.00048 },
          reconciledAt: "2026-07-18T00:00:00.000Z",
        },
      };
    });
    const receipt = await client.reconcile(input);
    assert.equal(receipt.usage.costUsd, 0.00048);
    assert.equal(calls[0]?.url, "https://inference-gateway.internal/v1/inference-reconciliations");
    assert.deepEqual(JSON.parse(calls[0]?.request.body ?? "null"), input);
    assert.equal(calls[0]?.request.key.byteLength, 64);
    const status = await client.lookup(input.tenantId, input.runId);
    assert.equal(status?.requestId, input.requestId);
    assert.equal(calls[1]?.url, "https://inference-gateway.internal/v1/inference-reconciliations/lookup");
    assert.deepEqual(JSON.parse(calls[1]?.request.body ?? "null"), { tenantId: input.tenantId, runId: input.runId });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("control-plane reconciliation client rejects route and receipt drift", async () => {
  const unsafe = new InferenceGatewayReconciliationClient({
    NODE_ENV: "production",
    DEVILUDO_INFERENCE_RECONCILIATION_URL: "https://inference-gateway.internal/v1/provider-probes",
  }, async () => { throw new Error("must not connect"); });
  await assert.rejects(unsafe.reconcile(input), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "INVALID_RECONCILIATION_GATEWAY");
    return true;
  });

  const directory = await mkdtemp(join(tmpdir(), "deviludo-inference-reconciliation-drift-"));
  try {
    const key = join(directory, "client.key");
    const certificate = join(directory, "client.crt");
    const ca = join(directory, "ca.crt");
    await Promise.all([writeFile(key, Buffer.alloc(64, 1)), writeFile(certificate, Buffer.alloc(64, 2)), writeFile(ca, Buffer.alloc(64, 3))]);
    const client = new InferenceGatewayReconciliationClient({
      NODE_ENV: "production",
      DEVILUDO_INFERENCE_RECONCILIATION_URL: "https://inference-gateway.internal/v1/inference-reconciliations",
      DEVILUDO_INFERENCE_RECONCILIATION_TLS_KEY_FILE: key,
      DEVILUDO_INFERENCE_RECONCILIATION_TLS_CERT_FILE: certificate,
      DEVILUDO_INFERENCE_RECONCILIATION_CA_FILE: ca,
    }, async () => ({
      statusCode: 200,
      payload: {
        ...input, requestId: "55555555-5555-4555-8555-555555555555", state: "COMPLETED",
        usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.00048 },
        reconciledAt: "2026-07-18T00:00:00.000Z",
      },
    }));
    await assert.rejects(client.reconcile(input), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_RECONCILIATION_RESPONSE");
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
