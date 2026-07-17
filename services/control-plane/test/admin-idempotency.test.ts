import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAdminIdempotencyStore } from "../src/admin-idempotency";

const identityDigest = "a".repeat(64);
const requestFingerprint = "b".repeat(64);

test("admin idempotency store fences concurrent claims and replays only a completed exact request", async () => {
  let now = Date.parse("2026-07-18T00:00:00.000Z");
  const store = new InMemoryAdminIdempotencyStore(() => now);
  const first = await store.acquire({ identityDigest, requestFingerprint });
  assert.equal(first.kind, "ACQUIRED");
  if (first.kind !== "ACQUIRED") throw new Error("claim expected");

  assert.deepEqual(await store.acquire({ identityDigest, requestFingerprint }), { kind: "BUSY" });
  assert.deepEqual(await store.acquire({ identityDigest, requestFingerprint: "c".repeat(64) }), { kind: "CONFLICT" });

  await store.release({ identityDigest, requestFingerprint, claimToken: first.claimToken });
  const reclaimed = await store.acquire({ identityDigest, requestFingerprint });
  assert.equal(reclaimed.kind, "ACQUIRED");
  if (reclaimed.kind !== "ACQUIRED") throw new Error("reclaim expected");
  assert.notEqual(reclaimed.claimToken, first.claimToken);

  const payload = { credential: { id: "credential-1", plaintextRecoverable: false } };
  await store.complete({ identityDigest, requestFingerprint, claimToken: reclaimed.claimToken, payload });
  assert.deepEqual(await store.acquire({ identityDigest, requestFingerprint }), { kind: "REPLAY", payload });

  now += 24 * 60 * 60_000 + 1;
  const expired = await store.acquire({ identityDigest, requestFingerprint: "c".repeat(64) });
  assert.equal(expired.kind, "ACQUIRED");
});

test("admin idempotency completion rejects a lost claim and oversized response", async () => {
  const store = new InMemoryAdminIdempotencyStore(() => Date.parse("2026-07-18T00:00:00.000Z"));
  const claim = await store.acquire({ identityDigest, requestFingerprint });
  if (claim.kind !== "ACQUIRED") throw new Error("claim expected");
  await assert.rejects(store.complete({
    identityDigest,
    requestFingerprint,
    claimToken: "11111111-1111-4111-8111-111111111111",
    payload: {},
  }), /claim was lost/);
  await assert.rejects(store.complete({
    identityDigest,
    requestFingerprint,
    claimToken: claim.claimToken,
    payload: { value: "x".repeat(1024 * 1024) },
  }), /result is invalid/);
});
