import assert from "node:assert/strict";
import test from "node:test";
import {
  MtlsGatewayCredentialResolver,
  type CredentialBrokerHttpRequest,
} from "../src/credential-broker";

const now = Date.parse("2030-01-01T00:00:00.000Z");
const tls = Object.freeze({
  key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3),
});
const binding = Object.freeze({
  tenantId: "tenant-1",
  projectId: "project-1",
  runId: "run-1",
  providerRevisionId: "provider-r4",
  credentialVersionId: "credential-v7",
});

test("mTLS credential resolver sends identifiers only and yields a wipeable, exactly bound lease", async () => {
  const calls: Array<{ url: string; request: CredentialBrokerHttpRequest }> = [];
  const resolver = new MtlsGatewayCredentialResolver({
    endpoint: "https://credential-broker.internal/v1/inference-credentials/resolve",
    tls,
    now: () => now,
    http: async (url, request) => {
      calls.push({ url: url.href, request });
      const submitted = JSON.parse(request.body ?? "null") as Record<string, unknown>;
      return {
        statusCode: 200,
        payload: {
          schemaVersion: "deviludo.inference-credential-lease.v1",
          requestId: submitted.requestId,
          ...binding,
          encoding: "base64",
          value: Buffer.from("fixed-provider-key").toString("base64"),
          expiresAt: new Date(now + 60_000).toISOString(),
        },
      };
    },
  });
  const lease = await resolver.resolve(binding);
  assert.equal(Buffer.from(lease.value).toString("utf8"), "fixed-provider-key");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://credential-broker.internal/v1/inference-credentials/resolve");
  assert.equal(calls[0]?.request.method, "POST");
  const submitted = JSON.parse(calls[0]?.request.body ?? "null") as Record<string, unknown>;
  assert.deepEqual({
    tenantId: submitted.tenantId,
    projectId: submitted.projectId,
    runId: submitted.runId,
    providerRevisionId: submitted.providerRevisionId,
    credentialVersionId: submitted.credentialVersionId,
  }, binding);
  assert.equal("secretRef" in submitted, false);
  assert.equal("apiKey" in submitted, false);
  assert.equal("value" in submitted, false);
  lease.destroy();
  assert.deepEqual([...lease.value], new Array(18).fill(0));
  lease.destroy();
});

test("mTLS credential resolver rejects lease drift, expiry and non-canonical key encoding", async () => {
  const cases = [
    { tenantId: "another-tenant" },
    { expiresAt: new Date(now - 1).toISOString() },
    { expiresAt: new Date(now + 6 * 60_000).toISOString() },
    { value: "not-base64" },
  ];
  for (const drift of cases) {
    const resolver = new MtlsGatewayCredentialResolver({
      endpoint: "https://credential-broker.internal/v1/inference-credentials/resolve",
      tls,
      now: () => now,
      http: async (_url, request) => {
        const submitted = JSON.parse(request.body ?? "null") as Record<string, unknown>;
        return {
          statusCode: 200,
          payload: {
            schemaVersion: "deviludo.inference-credential-lease.v1",
            requestId: submitted.requestId,
            ...binding,
            encoding: "base64",
            value: Buffer.from("fixed-provider-key").toString("base64"),
            expiresAt: new Date(now + 60_000).toISOString(),
            ...drift,
          },
        };
      },
    });
    await assert.rejects(resolver.resolve(binding), /invalid bound lease/);
  }
});

test("mTLS credential resolver uses a distinct provider-probe lease contract without inventing a tenant run", async () => {
  const submissions: Record<string, unknown>[] = [];
  const resolver = new MtlsGatewayCredentialResolver({
    endpoint: "https://credential-broker.internal/v1/inference-credentials/resolve",
    tls,
    now: () => now,
    http: async (_url, request) => {
      const submitted = JSON.parse(request.body ?? "null") as Record<string, unknown>;
      submissions.push(submitted);
      return {
        statusCode: 200,
        payload: {
          schemaVersion: "deviludo.inference-provider-probe-credential-lease.v1",
          requestId: submitted.requestId,
          providerRevisionId: "provider-r4",
          credentialVersionId: "credential-v7",
          encoding: "base64",
          value: Buffer.from("probe-provider-key").toString("base64"),
          expiresAt: new Date(now + 60_000).toISOString(),
        },
      };
    },
  });
  const lease = await resolver.resolveProviderProbe({ providerRevisionId: "provider-r4", credentialVersionId: "credential-v7" });
  assert.equal(Buffer.from(lease.value).toString("utf8"), "probe-provider-key");
  const submitted = submissions[0] ?? {};
  assert.equal(submitted.schemaVersion, "deviludo.inference-provider-probe-credential-request.v1");
  assert.equal("tenantId" in submitted, false);
  assert.equal("runId" in submitted, false);
  assert.equal("value" in submitted, false);
  lease.destroy();
  assert.ok([...lease.value].every((value) => value === 0));
});

test("mTLS credential resolver readiness verifies the exact workload and rejects unsafe endpoints", async () => {
  const urls: string[] = [];
  const resolver = new MtlsGatewayCredentialResolver({
    endpoint: "https://credential-broker.internal/v1/inference-credentials/resolve",
    tls,
    http: async (url) => {
      urls.push(url.href);
      return { statusCode: 200, payload: { status: "ok", service: "deviludo-inference-credential-broker" } };
    },
  });
  await resolver.probe();
  assert.deepEqual(urls, ["https://credential-broker.internal/healthz"]);

  for (const endpoint of [
    "http://credential-broker.internal/v1/inference-credentials/resolve",
    "https://user:key@credential-broker.internal/v1/inference-credentials/resolve",
    "https://credential-broker.internal/v1/inference-credentials/resolve?token=x",
    "https://credential-broker.internal/another-path",
  ]) assert.throws(() => new MtlsGatewayCredentialResolver({ endpoint, tls }), /credential-free HTTPS/);
});
