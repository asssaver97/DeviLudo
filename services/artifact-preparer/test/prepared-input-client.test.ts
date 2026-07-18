import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type {
  TestKitArtifactBrokerHttp,
  TestKitArtifactTransferHttp,
} from "../../runner-control/src/testkit-artifact-client";
import {
  MtlsPreparedInputObjectClient,
  preparedInputObjectClientFromEnv,
  preparedInputProcessEnvironmentFromEnv,
} from "../src/prepared-input-client";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const lockKey = "1".repeat(64);
const now = new Date("2030-01-01T00:00:00.000Z");
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

test("prepared-input client verifies, streams and commits one immutable source file", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-prepared-input-client-"));
  try {
    const bytes = Buffer.from("immutable compressed source fixture");
    const path = join(root, "source.tar.zst");
    await writeFile(path, bytes, { flag: "wx" });
    const fixture = harness();
    const receipt = await fixture.client.publishFile(sourceInput(path, bytes));
    assert.deepEqual(receipt, {
      objectKey: objectKey("source-bundle", digest(bytes)),
      artifactDigest: digest(bytes),
      sizeBytes: bytes.byteLength,
    });
    assert.deepEqual(fixture.calls.map((call) => call.path), [
      "/v1/prepared-input-grants",
      "/v1/prepared-input-commits",
    ]);
    assert.equal(fixture.uploads, 1);
    assert.equal(fixture.calls[0]?.body.objectKey, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepared-input client publishes the canonical test plan through the same file boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-prepared-input-client-"));
  try {
    const bytes = Buffer.from('{"schemaVersion":"deviludo.godot-test-plan.v2"}');
    const path = join(root, "test-plan.json");
    await writeFile(path, bytes, { flag: "wx" });
    const fixture = harness();
    const input = {
      ...sourceInput(path, bytes),
      artifactKind: "test-plan" as const,
      objectKey: objectKey("test-plan", digest(bytes)),
      contentType: "application/json" as const,
    };
    assert.deepEqual(await fixture.client.publishFile(input), {
      objectKey: input.objectKey,
      artifactDigest: digest(bytes),
      sizeBytes: bytes.byteLength,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepared-input client rejects grant drift, unapproved authority and upload-time mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-prepared-input-client-"));
  try {
    const bytes = Buffer.from("source bytes");
    const path = join(root, "source.tar.zst");
    await writeFile(path, bytes, { flag: "wx" });
    await assert.rejects(harness({ driftGrant: true }).client.publishFile(sourceInput(path, bytes)), /Broker response is invalid/);
    await assert.rejects(harness({ transferOrigin: "https://evil.invalid" }).client.publishFile(sourceInput(path, bytes)), /Broker response is invalid/);
    const mutation = harness({ mutateUpload: true });
    await assert.rejects(mutation.client.publishFile(sourceInput(path, bytes)), /changed during upload/);
    assert.equal(mutation.calls.filter((call) => call.path.endsWith("commits")).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepared-input client refuses local file or receipt drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-prepared-input-client-"));
  try {
    const bytes = Buffer.from("source bytes");
    const path = join(root, "source.tar.zst");
    await writeFile(path, bytes, { flag: "wx" });
    const wrongDigest = "f".repeat(64);
    await assert.rejects(
      harness().client.publishFile({
        ...sourceInput(path, bytes),
        artifactDigest: wrongDigest,
        objectKey: objectKey("source-bundle", wrongDigest),
      }),
      /Broker response is invalid/,
    );
    await assert.rejects(harness({ driftReceipt: true }).client.publishFile(sourceInput(path, bytes)), /Broker response is invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prepared-input environment accepts only normalized file-mounted transport configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-prepared-input-env-"));
  try {
    const key = join(root, "tls.key");
    const certificate = join(root, "tls.crt");
    const ca = join(root, "archive-ca.crt");
    const transferCa = join(root, "transfer-ca.crt");
    await Promise.all([key, certificate, ca, transferCa].map((path) => writeFile(path, Buffer.alloc(32, 0x61), { flag: "wx" })));
    const env = {
      DEVILUDO_PREPARED_INPUT_BROKER_URL: "https://archive.internal",
      DEVILUDO_PREPARED_INPUT_TLS_KEY_FILE: key,
      DEVILUDO_PREPARED_INPUT_TLS_CERT_FILE: certificate,
      DEVILUDO_PREPARED_INPUT_CA_FILE: ca,
      DEVILUDO_PREPARED_INPUT_TRANSFER_CA_FILE: transferCa,
      DEVILUDO_PREPARED_INPUT_ALLOWED_TRANSFER_ORIGINS_JSON: '["https://a.internal","https://b.internal"]',
      DEVILUDO_PREPARED_INPUT_REQUEST_TIMEOUT_SECONDS: "15",
      API_KEY: "must-not-leak",
    };
    const controlled = preparedInputProcessEnvironmentFromEnv(env);
    assert.equal(controlled.DEVILUDO_PREPARED_INPUT_BROKER_URL, "https://archive.internal");
    assert.equal(controlled.DEVILUDO_PREPARED_INPUT_REQUEST_TIMEOUT_SECONDS, "15");
    assert.equal(controlled.API_KEY, undefined);
    assert.ok(await preparedInputObjectClientFromEnv(env) instanceof MtlsPreparedInputObjectClient);
    assert.throws(() => preparedInputProcessEnvironmentFromEnv({
      ...env,
      DEVILUDO_PREPARED_INPUT_ALLOWED_TRANSFER_ORIGINS_JSON: '["https://b.internal","https://a.internal"]',
    }), /configuration is invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function sourceInput(path: string, bytes: Buffer) {
  const artifactDigest = digest(bytes);
  return {
    tenantId,
    projectId,
    runId,
    lockKey,
    artifactKind: "source-bundle" as const,
    objectKey: objectKey("source-bundle", artifactDigest),
    artifactDigest,
    sizeBytes: bytes.byteLength,
    contentType: "application/zstd" as const,
    path,
  };
}

function objectKey(kind: "source-bundle" | "test-plan", artifactDigest: string): string {
  return kind === "source-bundle"
    ? `tenants/${tenantId}/projects/${projectId}/sources/${artifactDigest}.tar.zst`
    : `tenants/${tenantId}/projects/${projectId}/test-plans/${artifactDigest}.json`;
}

function harness(options: {
  readonly driftGrant?: boolean;
  readonly driftReceipt?: boolean;
  readonly mutateUpload?: boolean;
  readonly transferOrigin?: string;
} = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let uploads = 0;
  const brokerHttp: TestKitArtifactBrokerHttp = async (request) => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    calls.push({ path: request.url.pathname, body });
    const artifactKind = body.artifactKind as "source-bundle" | "test-plan";
    const artifactDigest = body.artifactDigest as string;
    const sizeBytes = body.sizeBytes as number;
    const contentType = artifactKind === "source-bundle" ? "application/zstd" : "application/json";
    const key = objectKey(artifactKind, artifactDigest);
    const core = {
      tenantId,
      projectId,
      runId,
      lockKey,
      artifactKind,
      artifactDigest,
      sizeBytes,
      objectKey: key,
      contentType,
    };
    if (request.url.pathname.endsWith("grants")) {
      return { statusCode: 200, payload: {
        schemaVersion: "deviludo.prepared-input-grant.v1",
        ...core,
        bindingDigest: options.driftGrant ? "f".repeat(64) : sha256Canonical(core),
        method: "PUT",
        url: `${options.transferOrigin ?? "https://s3.internal"}/bucket/${key}?signature=opaque`,
        requiredHeaders: uploadHeaders(contentType, artifactDigest, sizeBytes),
        expiresAt: "2030-01-01T00:05:00.000Z",
        commitRequired: true,
      } };
    }
    return { statusCode: 200, payload: {
      schemaVersion: "deviludo.prepared-input-commit-receipt.v1",
      ...core,
      bindingDigest: options.driftReceipt ? "e".repeat(64) : sha256Canonical(core),
      verified: true,
    } };
  };
  const transferHttp: TestKitArtifactTransferHttp = {
    async download() { throw new Error("not supported"); },
    async upload(request) {
      uploads += 1;
      assert.equal((await readFile(request.sourcePath)).byteLength, request.sizeBytes);
      if (options.mutateUpload) await writeFile(request.sourcePath, Buffer.alloc(request.sizeBytes, 0x78));
      return { statusCode: 200 };
    },
  };
  const client = new MtlsPreparedInputObjectClient({
    endpoint: "https://archive.internal",
    tls: { key: Buffer.alloc(32), certificate: Buffer.alloc(32), ca: Buffer.alloc(32) },
    transferCa: Buffer.alloc(32),
    allowedTransferOrigins: ["https://s3.internal"],
    brokerHttp,
    transferHttp,
    now: () => now,
  });
  return { client, calls, get uploads() { return uploads; } };
}

function uploadHeaders(contentType: string, artifactDigest: string, sizeBytes: number): Record<string, string> {
  return {
    "content-length": String(sizeBytes),
    "content-type": contentType,
    "if-none-match": "*",
    "x-amz-checksum-sha256": Buffer.from(artifactDigest, "hex").toString("base64"),
    "x-amz-meta-deviludo-sha256": artifactDigest,
  };
}
