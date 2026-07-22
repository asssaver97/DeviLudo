import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderRevisionRecord } from "../src/contracts";
import { InferenceGatewayProviderProbeClient, type ProviderProbeHttpRequest } from "../src/provider-probe";

const requiredChecks = [
  "authentication", "modelExistence", "streaming", "toolCalling", "cancellation",
  "usage", "timeout", "minimalReasoning", "dnsPinning", "redirectRevalidation",
] as const;

test("control-plane Provider probe uses mounted mTLS material and sends SecretRef identity only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-provider-probe-"));
  try {
    const key = join(directory, "client.key");
    const certificate = join(directory, "client.crt");
    const ca = join(directory, "ca.crt");
    await Promise.all([writeFile(key, Buffer.alloc(64, 1)), writeFile(certificate, Buffer.alloc(64, 2)), writeFile(ca, Buffer.alloc(64, 3))]);
    const calls: Array<{ url: string; request: ProviderProbeHttpRequest }> = [];
    const probe = new InferenceGatewayProviderProbeClient({
      NODE_ENV: "production",
      DEVILUDO_INFERENCE_PROBE_URL: "https://inference-gateway.internal/v1/provider-probes",
      DEVILUDO_INFERENCE_PROBE_TLS_KEY_FILE: key,
      DEVILUDO_INFERENCE_PROBE_TLS_CERT_FILE: certificate,
      DEVILUDO_INFERENCE_PROBE_CA_FILE: ca,
    }, async (url, request) => {
      calls.push({ url: url.href, request });
      if (request.method === "GET") {
        return {
          statusCode: 200,
          payload: {
            schemaVersion: "deviludo.inference-gateway-health.v1",
            status: "ok",
            service: "deviludo-inference-gateway",
            connector: "CONFIGURED",
            providerProbe: "CONFIGURED",
            reconciliation: "CONFIGURED",
          },
        };
      }
      return {
        statusCode: 200,
        payload: { providerRevisionId: provider.id, checks: Object.fromEntries(requiredChecks.map((name) => [name, "PASS"])) },
      };
    });
    await probe.probe();
    const checks = await probe.run(provider);
    assert.deepEqual(Object.keys(checks), [...requiredChecks]);
    assert.deepEqual(calls.map(({ url, request }) => [request.method, url]), [
      ["GET", "https://inference-gateway.internal/healthz"],
      ["POST", "https://inference-gateway.internal/v1/provider-probes"],
    ]);
    assert.equal(calls[1]?.request.key.byteLength, 64);
    const submitted = JSON.parse(calls[1]?.request.body ?? "null") as Record<string, unknown>;
    assert.equal(submitted.credentialVersionId, provider.credentialVersionId);
    assert.deepEqual(submitted.approvedPorts, [443]);
    assert.equal(submitted.authentication, "bearer");
    assert.equal("apiKey" in submitted, false);
    assert.equal("secretRef" in submitted, false);
    assert.equal("token" in submitted, false);
    assert.equal(calls.every(({ request }) => [request.key, request.certificate, request.ca]
      .every((value) => value.every((byte) => byte === 0))), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("control-plane Provider probe rejects non-fixed routes before reading credentials", async () => {
  const probe = new InferenceGatewayProviderProbeClient({
    NODE_ENV: "production",
    DEVILUDO_INFERENCE_PROBE_URL: "https://inference-gateway.internal/other-route",
  }, async () => { throw new Error("must not connect"); });
  await assert.rejects(probe.run(provider), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "INVALID_PROBE_GATEWAY");
    return true;
  });
});

test("control-plane Provider probe rejects a passing receipt bound to another Provider revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-provider-probe-drift-"));
  try {
    const key = join(directory, "client.key");
    const certificate = join(directory, "client.crt");
    const ca = join(directory, "ca.crt");
    await Promise.all([writeFile(key, Buffer.alloc(64, 1)), writeFile(certificate, Buffer.alloc(64, 2)), writeFile(ca, Buffer.alloc(64, 3))]);
    const probe = new InferenceGatewayProviderProbeClient({
      NODE_ENV: "production",
      DEVILUDO_INFERENCE_PROBE_URL: "https://inference-gateway.internal/v1/provider-probes",
      DEVILUDO_INFERENCE_PROBE_TLS_KEY_FILE: key,
      DEVILUDO_INFERENCE_PROBE_TLS_CERT_FILE: certificate,
      DEVILUDO_INFERENCE_PROBE_CA_FILE: ca,
    }, async () => ({
      statusCode: 200,
      payload: { providerRevisionId: "provider-other-r1", checks: Object.fromEntries(requiredChecks.map((name) => [name, "PASS"])) },
    }));
    await assert.rejects(probe.run(provider), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_PROBE_RESPONSE");
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("control-plane Provider readiness rejects incomplete Gateway capabilities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-provider-readiness-"));
  try {
    const key = join(directory, "client.key");
    const certificate = join(directory, "client.crt");
    const ca = join(directory, "ca.crt");
    await Promise.all([writeFile(key, Buffer.alloc(64, 1)), writeFile(certificate, Buffer.alloc(64, 2)), writeFile(ca, Buffer.alloc(64, 3))]);
    const probe = new InferenceGatewayProviderProbeClient({
      NODE_ENV: "production",
      DEVILUDO_INFERENCE_PROBE_URL: "https://inference-gateway.internal/v1/provider-probes",
      DEVILUDO_INFERENCE_PROBE_TLS_KEY_FILE: key,
      DEVILUDO_INFERENCE_PROBE_TLS_CERT_FILE: certificate,
      DEVILUDO_INFERENCE_PROBE_CA_FILE: ca,
    }, async () => ({
      statusCode: 200,
      payload: {
        schemaVersion: "deviludo.inference-gateway-health.v1",
        status: "ok",
        service: "deviludo-inference-gateway",
        connector: "CONFIGURED",
        providerProbe: "NOT_CONFIGURED",
        reconciliation: "CONFIGURED",
      },
    }));
    await assert.rejects(probe.probe(), (error: unknown) =>
      (error as { code?: string }).code === "PROBE_GATEWAY_UNAVAILABLE");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const provider: ProviderRevisionRecord = {
  id: "provider-codex-r1",
  revision: 1,
  agent: "codex-cli",
  protocol: "openai-responses",
  baseUrl: "https://provider.example.com/v1",
  approvedPorts: Object.freeze([443]),
  authentication: "bearer",
  models: {
    primaryModel: "gpt-5.3-codex-2026-06-12",
    planningModel: "gpt-5.3-codex-2026-06-12",
    smallFastModel: "gpt-5.3-codex-2026-06-12",
    subagentModel: "gpt-5.3-codex-2026-06-12",
  },
  pricing: Object.freeze({ inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 10 }),
  credentialVersionId: "credential-v1",
  state: "VALIDATING",
  probe: {},
  governance: {
    dataRegion: "US",
    retentionPolicy: "zero-retention",
    trainingPolicy: "disabled",
    confirmedBy: "security-admin",
    confirmedAt: "2030-01-01T00:00:00.000Z",
  },
};
