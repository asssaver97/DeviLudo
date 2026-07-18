import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactPreparationService } from "../src/service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const identity = Object.freeze({
  spiffeId: "spiffe://deviludo.internal/runner-control/artifact-preparer",
  certificateFingerprint: "a".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2030-01-01T00:00:00.000Z",
});
const trigger = Object.freeze({
  schemaVersion: "deviludo.source-execution-preparation-trigger.v1",
  tenantId,
  projectId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  lockKey: "b".repeat(64),
  mode: "CANDIDATE" as const,
  commitSha: "c".repeat(40),
  targetMatrix: Object.freeze(["linux"] as const),
});
const authorityRequest = Object.freeze({ authoritative: true });
const receipt = Object.freeze({
  executionLockId: "44444444-4444-4444-8444-444444444444",
  executionLockDigest: "d".repeat(64),
  sourceDigest: "e".repeat(64),
  sourceArtifactDigest: "f".repeat(64),
  sourceObjectKey: "source",
  testPlanDigest: "0".repeat(64),
  testPlanObjectKey: "plan",
  created: true,
});

test("Artifact Preparer authorizes the caller before resolving and executing server authority", async () => {
  const calls: string[] = [];
  const service = new ArtifactPreparationService({
    tenants: {
      async authorize(selectedIdentity, selectedTenant) {
        calls.push("authorize");
        assert.deepEqual(selectedIdentity, identity);
        assert.equal(selectedTenant, tenantId);
      },
      async probe() { calls.push("tenant-probe"); },
    },
    authority: {
      async resolve(value) {
        calls.push("resolve");
        assert.deepEqual(value, trigger);
        return authorityRequest as never;
      },
      async probe() { calls.push("authority-probe"); },
    },
    preparer: {
      async prepare(value) {
        calls.push("prepare");
        assert.deepEqual(value, authorityRequest);
        return receipt;
      },
    },
  });
  assert.deepEqual(await service.prepare(identity, trigger), receipt);
  assert.deepEqual(calls, ["authorize", "resolve", "prepare"]);
  await service.probe();
  assert.deepEqual(new Set(calls.slice(3)), new Set(["tenant-probe", "authority-probe"]));
});

test("Artifact Preparer rejects extra trigger fields before tenant or database access", async () => {
  let touched = false;
  const service = new ArtifactPreparationService({
    tenants: { async authorize() { touched = true; }, async probe() {} },
    authority: { async resolve() { touched = true; return authorityRequest as never; }, async probe() {} },
    preparer: { async prepare() { touched = true; return receipt; } },
  });
  await assert.rejects(service.prepare(identity, { ...trigger, sourceDigest: "a".repeat(64) }), /trigger fields is invalid/);
  assert.equal(touched, false);
});
