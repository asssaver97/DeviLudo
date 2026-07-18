import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import type { EvidenceBundle } from "../../../lib/domain/e2e";
import { REQUIRED_RUNNER_EVIDENCE } from "../../runner-control/src/coordinator";
import { sha256Canonical, signCanonical } from "../../runner-control/src/canonical";
import type { RunnerJobPayload, SignedRunnerJob } from "../../runner-control/src/contracts";
import {
  RunnerArtifactGrantService,
  runnerArtifactObjectKey,
  runnerTestPlanObjectKey,
  type RunnerArtifactTransfer,
} from "../src/runner-artifacts";
import type { ImmutableObjectPut, ImmutableObjectStore } from "../src/contracts";

const keys = generateKeyPairSync("ed25519");
const now = new Date("2030-01-01T00:00:00.000Z");
const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const identity = Object.freeze({
  spiffeId: "spiffe://deviludo.internal/e2e/runner-linux-1",
  certificateFingerprint: "1".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2031-01-01T00:00:00.000Z",
});
const sha = (character: string) => character.repeat(64);

function payload(overrides: Partial<RunnerJobPayload> = {}): RunnerJobPayload {
  return Object.freeze({
    schemaVersion: "deviludo.runner-job.v2",
    attemptId,
    tenantId,
    projectId,
    runId: "44444444-4444-4444-8444-444444444444",
    iterationId: "55555555-5555-4555-8555-555555555555",
    runnerId: "runner-linux-1",
    platform: "linux",
    fencingToken: 7,
    leaseExpiresAt: "2030-01-01T00:10:00.000Z",
    executionLockId: "66666666-6666-4666-8666-666666666666",
    executionLockDigest: sha("2"),
    commitSha: "a".repeat(40),
    sourceDigest: sha("3"),
    execution: {
      kind: "SOURCE_ARTIFACT" as const,
      objectKey: `tenants/${tenantId}/projects/${projectId}/sources/${sha("4")}.tar.zst`,
      artifactDigest: sha("4"),
    },
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    specDigest: sha("5"),
    testPlanDigest: sha("6"),
    targetMatrix: ["linux"] as const,
    requiredGodotVersion: "4.6.2-stable",
    godotTestKitDigest: sha("7"),
    exportTemplatesDigest: sha("8"),
    runnerCapabilityDigest: sha("9"),
    buildManifestDigest: sha("a"),
    sbomDigest: sha("b"),
    vulnerabilityScanDigest: sha("c"),
    assetLicenseLedgerDigest: sha("d"),
    requiredEvidence: REQUIRED_RUNNER_EVIDENCE,
    ...overrides,
  });
}

function signed(overrides: Partial<RunnerJobPayload> = {}): SignedRunnerJob {
  const value = payload(overrides);
  return Object.freeze({
    payload: value,
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId: "runner-job-key-01",
      value: signCanonical(keys.privateKey, value),
    }),
  });
}

class Transfer implements RunnerArtifactTransfer {
  readonly grants: Array<Record<string, unknown>> = [];
  readonly verified: Array<{ objectKey: string; artifactDigest: string; sizeBytes?: number }> = [];

  async createDownloadGrant(input: { objectKey: string; artifactDigest: string; expiresAt: string }) {
    this.grants.push({ type: "download", ...input });
    return { url: "https://s3.internal/download?signature=opaque", method: "GET" as const, requiredHeaders: {}, expiresAt: input.expiresAt };
  }

  async createUploadGrant(input: { objectKey: string; artifactDigest: string; sizeBytes: number; contentType: string; expiresAt: string }) {
    this.grants.push({ type: "upload", ...input });
    return {
      url: "https://s3.internal/upload?signature=opaque",
      method: "PUT" as const,
      requiredHeaders: { "content-type": input.contentType, "content-length": String(input.sizeBytes) },
      expiresAt: input.expiresAt,
    };
  }

  async verifyObject(input: { objectKey: string; artifactDigest: string; sizeBytes?: number }) {
    this.verified.push(input);
    return { sizeBytes: input.sizeBytes ?? 123 };
  }

  async probe(): Promise<void> {}
}

class Reservations implements ImmutableObjectStore {
  readonly objects = new Map<string, ImmutableObjectPut>();
  async putImmutable(input: ImmutableObjectPut) {
    const existing = this.objects.get(input.objectKey);
    if (existing) {
      if (existing.contentDigest !== input.contentDigest) throw new Error("reservation conflict");
      return { created: false };
    }
    this.objects.set(input.objectKey, input);
    return { created: true };
  }
  async probe(): Promise<void> {}
}

function service(transfer = new Transfer(), fleetResult = true) {
  const fleetCalls: unknown[] = [];
  const reservations = new Reservations();
  return {
    transfer,
    reservations,
    fleetCalls,
    service: new RunnerArtifactGrantService({
      jobKeyId: "runner-job-key-01",
      jobPublicKey: keys.publicKey,
      fleet: {
        authorizeJob: async (input) => {
          fleetCalls.push(input);
          return fleetResult;
        },
        probe: async () => undefined,
      },
      transfer,
      reservations,
      now: () => now,
    }),
  };
}

test("signed source job receives only its exact short-lived download grant", async () => {
  const fixture = service();
  const job = signed();
  const grant = await fixture.service.grant(identity, {
    schemaVersion: "deviludo.runner-artifact-grant-request.v1",
    job,
    operation: { kind: "DOWNLOAD_INPUT" },
  });
  assert.equal(grant.jobDigest, sha256Canonical(job.payload));
  assert.equal(grant.objectKey, (job.payload.execution as { objectKey: string }).objectKey);
  assert.equal(grant.artifactDigest, (job.payload.execution as { artifactDigest: string }).artifactDigest);
  assert.equal(grant.expiresAt, "2030-01-01T00:05:00.000Z");
  assert.equal(grant.commitRequired, false);
  assert.equal(fixture.fleetCalls.length, 1);

  const plan = await fixture.service.grant(identity, {
    schemaVersion: "deviludo.runner-artifact-grant-request.v1",
    job,
    operation: { kind: "DOWNLOAD_TEST_PLAN" },
  });
  assert.equal(plan.artifactKind, "test-plan");
  assert.equal(plan.artifactDigest, job.payload.testPlanDigest);
  assert.equal(plan.objectKey, runnerTestPlanObjectKey(tenantId, projectId, job.payload.testPlanDigest));
  assert.equal(plan.commitRequired, false);
});

test("evidence upload and commit are derived from tenant, attempt, platform, kind and digest", async () => {
  const fixture = service();
  const job = signed();
  const artifactDigest = sha("e");
  const operation = { kind: "UPLOAD_EVIDENCE" as const, artifactKind: "junit" as const, artifactDigest, sizeBytes: 2048 };
  const grant = await fixture.service.grant(identity, {
    schemaVersion: "deviludo.runner-artifact-grant-request.v1",
    job,
    operation,
  });
  const objectKey = runnerArtifactObjectKey(tenantId, projectId, attemptId, "linux", "junit", artifactDigest);
  assert.equal(grant.objectKey, objectKey);
  assert.equal(grant.commitRequired, true);
  assert.equal((grant.requiredHeaders as Record<string, string>)["content-type"], "application/xml");

  const receipt = await fixture.service.commit(identity, {
    schemaVersion: "deviludo.runner-artifact-commit-request.v1",
    job,
    artifactKind: "junit",
    artifactDigest,
    sizeBytes: 2048,
  });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.objectKey, objectKey);
  assert.deepEqual(fixture.transfer.verified.at(-1), { objectKey, artifactDigest, sizeBytes: 2048 });
  assert.equal(fixture.reservations.objects.size, 1);

  await assert.rejects(fixture.service.grant(identity, {
    schemaVersion: "deviludo.runner-artifact-grant-request.v1",
    job,
    operation: { ...operation, artifactDigest: sha("f") },
  }), /reservation conflict/);
});

test("artifact grants reject signature, fleet, execution mode, size and field drift", async () => {
  const valid = signed();
  const tampered = { ...valid, payload: { ...valid.payload, runnerId: "runner-linux-2" } };
  await assert.rejects(service().service.grant(identity, {
    schemaVersion: "deviludo.runner-artifact-grant-request.v1", job: tampered, operation: { kind: "DOWNLOAD_INPUT" },
  }), /signed job/);
  await assert.rejects(service(new Transfer(), false).service.grant(identity, {
    schemaVersion: "deviludo.runner-artifact-grant-request.v1", job: valid, operation: { kind: "DOWNLOAD_INPUT" },
  }), /fleet assignment/);
  const steam = signed({ execution: { kind: "STEAM_CLEAN_INSTALL", steamAppId: "480", buildId: "123", betaBranch: "private_beta", installGrantId: "grant-1" } });
  await assert.rejects(service().service.grant(identity, {
    schemaVersion: "deviludo.runner-artifact-grant-request.v1", job: steam, operation: { kind: "DOWNLOAD_INPUT" },
  }), /execution mode/);
  await assert.rejects(service().service.grant(identity, {
    schemaVersion: "deviludo.runner-artifact-grant-request.v1",
    job: valid,
    operation: { kind: "UPLOAD_EVIDENCE", artifactKind: "junit", artifactDigest: sha("f"), sizeBytes: 17 * 1024 * 1024 },
  }), /artifact size/);
  await assert.rejects(service().service.grant(identity, {
    schemaVersion: "deviludo.runner-artifact-grant-request.v1", job: valid, operation: { kind: "DOWNLOAD_INPUT", extra: true },
  }), /fields/);
});

test("bundle admission verifies all six top-level evidence objects per platform", async () => {
  const fixture = service();
  const evidence = {
    platform: "linux" as const,
    runnerId: "runner-linux-1",
    runnerCapabilityDigest: sha("1"),
    exportDigest: sha("2"),
    logsDigest: sha("3"),
    junitDigest: sha("4"),
    inputTimelineDigest: sha("5"),
    screenshotManifestDigest: sha("6"),
    videoManifestDigest: sha("7"),
    status: "PASSED" as const,
  };
  await fixture.service.verifyEvidenceArtifacts({
    tenantId,
    projectId,
    bundle: { attemptId, platformEvidence: [evidence] } as unknown as EvidenceBundle,
  });
  assert.equal(fixture.transfer.verified.length, 6);
  assert.deepEqual(fixture.transfer.verified.map((item) => item.artifactDigest), [sha("2"), sha("3"), sha("4"), sha("5"), sha("6"), sha("7")]);
});
