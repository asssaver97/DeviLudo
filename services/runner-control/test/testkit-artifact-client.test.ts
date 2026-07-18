import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Canonical } from "../src/canonical";
import type { RunnerJobPayload, SignedRunnerJob } from "../src/contracts";
import {
  MtlsTestKitArtifactClient,
  testKitArtifactProcessEnvironmentFromEnv,
  type TestKitArtifactBrokerHttp,
  type TestKitArtifactTransferHttp,
} from "../src/testkit-artifact-client";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2030-01-01T00:00:00.000Z");
const sha = (value: string) => value.repeat(64);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function signedJob(inputDigest: string, testPlanDigest = sha("5")): SignedRunnerJob {
  const payload: RunnerJobPayload = {
    schemaVersion: "deviludo.runner-job.v2",
    attemptId,
    tenantId,
    projectId,
    runId: "44444444-4444-4444-8444-444444444444",
    iterationId: "55555555-5555-4555-8555-555555555555",
    runnerId: "runner-linux-1",
    platform: "linux",
    fencingToken: 3,
    leaseExpiresAt: "2030-01-01T00:10:00.000Z",
    executionLockId: "66666666-6666-4666-8666-666666666666",
    executionLockDigest: sha("1"),
    commitSha: "a".repeat(40),
    sourceDigest: sha("2"),
    execution: {
      kind: "SOURCE_ARTIFACT",
      objectKey: `tenants/${tenantId}/projects/${projectId}/sources/${inputDigest}.tar.zst`,
      artifactDigest: inputDigest,
    },
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    specDigest: sha("4"),
    testPlanDigest,
    runnerToolchainRevisionId: "88888888-8888-4888-8888-888888888888",
    runnerToolchainDigest: sha("0"),
    targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable",
    godotTestKitDigest: sha("6"),
    exportTemplatesDigest: sha("7"),
    runnerCapabilityDigest: sha("8"),
    buildManifestDigest: sha("9"),
    sbomDigest: sha("a"),
    vulnerabilityScanDigest: sha("b"),
    assetLicenseLedgerDigest: sha("c"),
    requiredEvidence: ["logs", "junit", "input-timeline", "screenshots", "video", "production-export"],
  };
  return Object.freeze({
    payload,
    signature: Object.freeze({ algorithm: "Ed25519", keyId: "runner-job-key-01", value: "opaque-signature" }),
  });
}

function harness(options: {
  input: Buffer;
  testPlan?: Buffer;
  mutateUpload?: boolean;
  extraUploadHeader?: boolean;
  transferOrigin?: string;
  lieAboutDownload?: boolean;
}) {
  const brokerCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transfers = { downloads: 0, uploads: 0 };
  const origin = options.transferOrigin ?? "https://s3.internal";
  const broker: TestKitArtifactBrokerHttp = async (request) => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    brokerCalls.push({ path: request.url.pathname, body });
    if (request.url.pathname.endsWith("grants")) {
      const operation = body.operation as Record<string, unknown>;
      const signed = body.job as SignedRunnerJob;
      if (operation.kind === "DOWNLOAD_INPUT") {
        const execution = signed.payload.execution;
        assert.equal(execution.kind, "SOURCE_ARTIFACT");
        return { statusCode: 200, payload: grant({
          job: signed,
          operation: "DOWNLOAD_INPUT",
          artifactKind: "source-artifact",
          artifactDigest: execution.artifactDigest,
          objectKey: execution.objectKey,
          sizeBytes: null,
          method: "GET",
          url: `${origin}/source?signature=opaque`,
          requiredHeaders: {},
          commitRequired: false,
        }) };
      }
      if (operation.kind === "DOWNLOAD_TEST_PLAN") {
        return { statusCode: 200, payload: grant({
          job: signed,
          operation: "DOWNLOAD_TEST_PLAN",
          artifactKind: "test-plan",
          artifactDigest: signed.payload.testPlanDigest,
          objectKey: `tenants/${signed.payload.tenantId}/projects/${signed.payload.projectId}/test-plans/${signed.payload.testPlanDigest}.json`,
          sizeBytes: null,
          method: "GET",
          url: `${origin}/plan?signature=opaque`,
          requiredHeaders: {},
          commitRequired: false,
        }) };
      }
      const artifactKind = operation.artifactKind as string;
      const artifactDigest = operation.artifactDigest as string;
      const sizeBytes = operation.sizeBytes as number;
      const requiredHeaders: Record<string, string> = {
        "content-length": String(sizeBytes),
        "content-type": artifactKind === "junit" ? "application/xml" : "text/plain",
        "if-none-match": "*",
        "x-amz-checksum-sha256": Buffer.from(artifactDigest, "hex").toString("base64"),
        "x-amz-meta-deviludo-sha256": artifactDigest,
      };
      if (options.extraUploadHeader) requiredHeaders.authorization = "must-not-be-forwarded";
      return { statusCode: 200, payload: grant({
        job: signed,
        operation: "UPLOAD_EVIDENCE",
        artifactKind,
        artifactDigest,
        objectKey: artifactKey(signed, artifactKind, artifactDigest),
        sizeBytes,
        method: "PUT",
        url: `${origin}/upload?signature=opaque`,
        requiredHeaders,
        commitRequired: true,
      }) };
    }
    assert.equal(request.url.pathname.endsWith("commits"), true);
    const signed = body.job as SignedRunnerJob;
    const artifactKind = body.artifactKind as string;
    const artifactDigest = body.artifactDigest as string;
    const sizeBytes = body.sizeBytes as number;
    return { statusCode: 200, payload: {
      schemaVersion: "deviludo.runner-artifact-commit-receipt.v1",
      jobDigest: sha256Canonical(signed.payload),
      attemptId: signed.payload.attemptId,
      platform: signed.payload.platform,
      artifactKind,
      artifactDigest,
      objectKey: artifactKey(signed, artifactKind, artifactDigest),
      sizeBytes,
      verified: true,
    } };
  };
  const transfer: TestKitArtifactTransferHttp = {
    async download(request) {
      transfers.downloads += 1;
      const selected = request.url.pathname === "/plan" ? (options.testPlan ?? options.input) : options.input;
      await writeFile(
        request.destinationPath,
        options.lieAboutDownload ? Buffer.alloc(selected.byteLength, 0x78) : selected,
        { flag: "wx" },
      );
      return { statusCode: 200, sizeBytes: selected.byteLength, artifactDigest: digest(selected) };
    },
    async upload(request) {
      transfers.uploads += 1;
      assert.equal((await readFile(request.sourcePath)).byteLength, request.sizeBytes);
      if (options.mutateUpload) await writeFile(request.sourcePath, Buffer.alloc(request.sizeBytes, 0x78));
      return { statusCode: 200 };
    },
  };
  const client = new MtlsTestKitArtifactClient({
    endpoint: "https://archive.internal",
    tls: { key: Buffer.alloc(32), certificate: Buffer.alloc(32), ca: Buffer.alloc(32) },
    transferCa: Buffer.alloc(32),
    allowedTransferOrigins: ["https://s3.internal"],
    brokerHttp: broker,
    transferHttp: transfer,
    now: () => now,
  });
  return { client, brokerCalls, transfers };
}

test("TestKit downloads only the signed source object and reuses verified immutable input", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-testkit-artifact-"));
  try {
    const input = Buffer.from("signed source bytes");
    const fixture = harness({ input });
    const job = signedJob(digest(input));
    const destination = join(root, "source.tar.zst");
    assert.deepEqual(await fixture.client.downloadInput(job, destination), {
      sizeBytes: input.byteLength,
      artifactDigest: digest(input),
    });
    await fixture.client.downloadInput(job, destination);
    assert.deepEqual(await readFile(destination), input);
    assert.equal(fixture.transfers.downloads, 1);
    assert.equal(fixture.brokerCalls.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TestKit downloads the immutable test plan derived from the signed tenant and digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-testkit-artifact-"));
  try {
    const plan = Buffer.from('{"schemaVersion":"deviludo.godot-test-plan.v2"}');
    const fixture = harness({ input: Buffer.from("source"), testPlan: plan });
    const job = signedJob(digest("source"), digest(plan));
    const destination = join(root, "test-plan.json");
    assert.deepEqual(await fixture.client.downloadTestPlan(job, destination), {
      sizeBytes: plan.byteLength,
      artifactDigest: digest(plan),
    });
    assert.deepEqual(await readFile(destination), plan);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TestKit uploads exact evidence and commits the server-derived object binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-testkit-artifact-"));
  try {
    const fixture = harness({ input: Buffer.from("source") });
    const job = signedJob(digest("source"));
    const source = join(root, "junit.xml");
    await writeFile(source, "<testsuite tests=\"1\"/>");
    const receipt = await fixture.client.uploadEvidence(job, "junit", source);
    assert.equal(receipt.artifactDigest, digest("<testsuite tests=\"1\"/>"));
    assert.equal(receipt.objectKey, artifactKey(job, "junit", receipt.artifactDigest));
    assert.equal(fixture.transfers.uploads, 1);
    assert.deepEqual(fixture.brokerCalls.map((call) => call.path), [
      "/v1/runner-artifact-grants", "/v1/runner-artifact-commits",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TestKit refuses unexpected transfer authority, headers and upload-time file mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-testkit-artifact-"));
  try {
    const source = join(root, "junit.xml");
    await writeFile(source, "evidence");
    await assert.rejects(
      harness({ input: Buffer.from("source"), transferOrigin: "https://evil.invalid" }).client
        .downloadInput(signedJob(digest("source")), join(root, "input.tar.zst")),
      /Broker response is invalid/,
    );
    await assert.rejects(
      harness({ input: Buffer.from("source"), lieAboutDownload: true }).client
        .downloadInput(signedJob(digest("source")), join(root, "lying-input.tar.zst")),
      /file verification/,
    );
    await assert.rejects(
      harness({ input: Buffer.from("source"), extraUploadHeader: true }).client
        .uploadEvidence(signedJob(digest("source")), "junit", source),
      /Broker response is invalid/,
    );
    const mutation = harness({ input: Buffer.from("source"), mutateUpload: true });
    await assert.rejects(
      mutation.client.uploadEvidence(signedJob(digest("source")), "junit", source),
      /changed during upload/,
    );
    assert.equal(mutation.brokerCalls.filter((call) => call.path.endsWith("commits")).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TestKit process environment keeps only normalized artifact transport configuration", () => {
  const controlled = testKitArtifactProcessEnvironmentFromEnv({
    DEVILUDO_TESTKIT_ARTIFACT_BROKER_URL: "https://archive.internal",
    DEVILUDO_TESTKIT_ARTIFACT_TLS_KEY_FILE: "/run/secrets/testkit/tls.key",
    DEVILUDO_TESTKIT_ARTIFACT_TLS_CERT_FILE: "/run/secrets/testkit/tls.crt",
    DEVILUDO_TESTKIT_ARTIFACT_CA_FILE: "/run/secrets/testkit/archive-ca.crt",
    DEVILUDO_TESTKIT_TRANSFER_CA_FILE: "/run/secrets/testkit/s3-ca.crt",
    DEVILUDO_TESTKIT_ALLOWED_TRANSFER_ORIGINS_JSON: '["https://a.internal","https://b.internal"]',
    DEVILUDO_TESTKIT_ARTIFACT_REQUEST_TIMEOUT_SECONDS: "15",
    API_KEY: "must-not-leak",
  });
  assert.equal(controlled.DEVILUDO_TESTKIT_ARTIFACT_BROKER_URL, "https://archive.internal");
  assert.equal(controlled.DEVILUDO_TESTKIT_ARTIFACT_REQUEST_TIMEOUT_SECONDS, "15");
  assert.equal(controlled.API_KEY, undefined);
  assert.throws(() => testKitArtifactProcessEnvironmentFromEnv({
    ...controlled,
    DEVILUDO_TESTKIT_ALLOWED_TRANSFER_ORIGINS_JSON: '["https://b.internal","https://a.internal"]',
  }), /configuration is invalid/);
});

function grant(input: {
  job: SignedRunnerJob;
  operation: string;
  artifactKind: string;
  artifactDigest: string;
  objectKey: string;
  sizeBytes: number | null;
  method: string;
  url: string;
  requiredHeaders: Record<string, string>;
  commitRequired: boolean;
}) {
  return {
    schemaVersion: "deviludo.runner-artifact-grant.v1",
    jobDigest: sha256Canonical(input.job.payload),
    operation: input.operation,
    artifactKind: input.artifactKind,
    artifactDigest: input.artifactDigest,
    objectKey: input.objectKey,
    sizeBytes: input.sizeBytes,
    method: input.method,
    url: input.url,
    requiredHeaders: input.requiredHeaders,
    expiresAt: "2030-01-01T00:05:00.000Z",
    commitRequired: input.commitRequired,
  };
}

function artifactKey(job: SignedRunnerJob, kind: string, artifactDigest: string): string {
  const payload = job.payload;
  return `tenants/${payload.tenantId}/projects/${payload.projectId}/runner-artifacts/${payload.attemptId}/${payload.platform}/${kind}/${artifactDigest}`;
}
