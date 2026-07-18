import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { EvidenceArchiveWorkloadIdentity } from "../src/contracts";
import {
  SignedPreparedInputTenantAuthorizer,
  signPreparedInputAssignments,
  type PreparedInputAssignmentClaims,
} from "../src/prepared-input-assignments";

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenantId = "22222222-2222-4222-8222-222222222222";
const spiffeId = "spiffe://deviludo.internal/artifact-preparer";
const now = new Date("2030-01-01T00:05:00.000Z");
const fingerprint = "a".repeat(64);
const identity: EvidenceArchiveWorkloadIdentity = {
  spiffeId,
  certificateFingerprint: fingerprint,
  certificateSerial: "01",
  certificateNotAfter: "2030-01-02T00:00:00.000Z",
};

test("signed prepared-input assignments bind certificate identity and exact tenant set", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claims = assignmentClaims();
  let envelope: unknown = signPreparedInputAssignments("prepared-input-key-01", privateKey, claims);
  const authorizer = new SignedPreparedInputTenantAuthorizer({
    loader: { async load() { return envelope; } },
    publicKeys: new Map([["prepared-input-key-01", publicKey]]),
    spiffeId,
    now: () => now,
  });
  await authorizer.probe();
  await authorizer.authorize(identity, tenantId);
  await assert.rejects(authorizer.authorize(identity, otherTenantId), /authorization/);
  await assert.rejects(authorizer.authorize({ ...identity, certificateFingerprint: "b".repeat(64) }, tenantId), /authorization/);
  await assert.rejects(authorizer.authorize({ ...identity, spiffeId: "spiffe://deviludo.internal/other" }, tenantId), /authorization/);

  envelope = { ...(envelope as object), claims: { ...claims, tenantIds: [tenantId, otherTenantId] } };
  await assert.rejects(authorizer.authorize(identity, tenantId), /signature/);
});

test("signed prepared-input assignments reject expiry, unsorted tenants and stale certificates", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const expired = signPreparedInputAssignments("prepared-input-key-01", privateKey, assignmentClaims());
  const expiredAuthorizer = new SignedPreparedInputTenantAuthorizer({
    loader: { async load() { return expired; } },
    publicKeys: new Map([["prepared-input-key-01", publicKey]]),
    spiffeId,
    now: () => new Date("2030-01-01T00:10:00.000Z"),
  });
  await assert.rejects(expiredAuthorizer.probe(), /claims/);

  assert.throws(() => signPreparedInputAssignments("prepared-input-key-01", privateKey, {
    ...assignmentClaims(),
    tenantIds: [otherTenantId, tenantId],
  }), /tenant set/);

  const validAuthorizer = new SignedPreparedInputTenantAuthorizer({
    loader: { async load() { return signPreparedInputAssignments("prepared-input-key-01", privateKey, assignmentClaims()); } },
    publicKeys: new Map([["prepared-input-key-01", publicKey]]),
    spiffeId,
    now: () => now,
  });
  await assert.rejects(validAuthorizer.authorize({ ...identity, certificateNotAfter: now.toISOString() }, tenantId), /identity/);
});

function assignmentClaims(): PreparedInputAssignmentClaims {
  return {
    kind: "deviludo-prepared-input-assignments",
    version: 1,
    revision: 7,
    spiffeId,
    certificateFingerprint: fingerprint,
    tenantIds: [tenantId],
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:10:00.000Z",
  };
}
