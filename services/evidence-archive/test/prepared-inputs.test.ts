import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { EvidenceArchiveWorkloadIdentity, ImmutableObjectPut, ImmutableObjectStore } from "../src/contracts";
import { PreparedInputGrantService, type PreparedInputTenantAuthorizer } from "../src/prepared-inputs";
import type { RunnerArtifactTransfer } from "../src/runner-artifacts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const sha = (value: string) => value.repeat(64);
const identity: EvidenceArchiveWorkloadIdentity = {
  spiffeId: "spiffe://deviludo.internal/artifact-preparer",
  certificateFingerprint: sha("a"),
  certificateSerial: "01",
  certificateNotAfter: "2030-01-02T00:00:00.000Z",
};

test("prepared input service derives one short-lived checksum-bound source grant and immutable commit", async () => {
  const fixture = serviceFixture();
  const request = input("source-bundle", sha("b"), 1_024);
  const grant = await fixture.service.grant(identity, request);
  assert.equal(grant.objectKey, `tenants/${tenantId}/projects/${projectId}/sources/${sha("b")}.tar.zst`);
  assert.equal(grant.contentType, "application/zstd");
  assert.equal(grant.method, "PUT");
  assert.equal(grant.commitRequired, true);
  assert.equal((grant.requiredHeaders as Record<string, string>)["x-amz-checksum-sha256"], Buffer.from(sha("b"), "hex").toString("base64"));
  assert.equal(JSON.stringify(grant).includes("secret"), false);

  const receipt = await fixture.service.commit(identity, {
    ...request,
    schemaVersion: "deviludo.prepared-input-commit-request.v1",
  });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.objectKey, grant.objectKey);
  assert.match(String(receipt.bindingDigest), /^[a-f0-9]{64}$/);
  assert.equal(fixture.reservations.size, 1);
  assert.deepEqual(await fixture.service.commit(identity, {
    ...request,
    schemaVersion: "deviludo.prepared-input-commit-request.v1",
  }), receipt);
  assert.equal(fixture.reservations.size, 1);
});

test("prepared input service derives test-plan scope and rejects tenant, size and field drift", async () => {
  const fixture = serviceFixture();
  const plan = await fixture.service.grant(identity, input("test-plan", sha("c"), 2_048));
  assert.equal(plan.objectKey, `tenants/${tenantId}/projects/${projectId}/test-plans/${sha("c")}.json`);
  assert.equal(plan.contentType, "application/json");
  await assert.rejects(fixture.service.grant(identity, { ...input("test-plan", sha("c"), 2_048), tenantId: projectId }), /tenant forbidden/);
  await assert.rejects(fixture.service.grant(identity, input("test-plan", sha("c"), 5 * 1024 * 1024)), /artifact size/);
  await assert.rejects(fixture.service.grant(identity, { ...input("test-plan", sha("c"), 2_048), objectKey: "attacker" }), /request fields/);
  await assert.rejects(fixture.service.commit(identity, {
    ...input("source-bundle", sha("d"), 3_000),
    schemaVersion: "deviludo.prepared-input-commit-request.v1",
  }), /stored object/);
});

function input(kind: "source-bundle" | "test-plan", artifactDigest: string, sizeBytes: number) {
  return {
    schemaVersion: "deviludo.prepared-input-grant-request.v1",
    tenantId,
    projectId,
    runId,
    lockKey: sha("1"),
    artifactKind: kind,
    artifactDigest,
    sizeBytes,
  };
}

function serviceFixture() {
  const reservations = new Map<string, ImmutableObjectPut>();
  const store: ImmutableObjectStore = {
    async putImmutable(value) {
      assert.equal(createHash("sha256").update(value.body).digest("hex"), value.contentDigest);
      const existing = reservations.get(value.objectKey);
      if (existing) {
        if (!existing.body.equals(value.body) || existing.contentDigest !== value.contentDigest) throw new Error("conflict");
        return { created: false };
      }
      reservations.set(value.objectKey, value);
      return { created: true };
    },
    async probe() {},
  };
  const authorizer: PreparedInputTenantAuthorizer = {
    async authorize(observed, tenant) {
      if (observed.spiffeId !== identity.spiffeId || tenant !== tenantId) throw new Error("tenant forbidden");
    },
    async probe() {},
  };
  const granted = new Map<string, number>();
  const transfer: RunnerArtifactTransfer = {
    async probe() {},
    async createDownloadGrant() { throw new Error("not supported"); },
    async createUploadGrant(value) {
      granted.set(value.objectKey, value.sizeBytes);
      return {
        url: `https://s3.internal/bucket/${value.objectKey}`,
        method: "PUT",
        requiredHeaders: {
          "content-length": String(value.sizeBytes),
          "content-type": value.contentType,
          "if-none-match": "*",
          "x-amz-checksum-sha256": Buffer.from(value.artifactDigest, "hex").toString("base64"),
          "x-amz-meta-deviludo-sha256": value.artifactDigest,
        },
        expiresAt: value.expiresAt,
      };
    },
    async verifyObject(value) {
      const sizeBytes = granted.get(value.objectKey);
      if (sizeBytes === undefined || sizeBytes !== value.sizeBytes) throw new Error("stored object mismatch");
      return { sizeBytes };
    },
  };
  return {
    service: new PreparedInputGrantService({
      authorizer,
      transfer,
      reservations: store,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    }),
    reservations,
  };
}
