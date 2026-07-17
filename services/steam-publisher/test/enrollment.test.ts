import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySteamEnrollmentStore,
  SteamEnrollmentCoordinator,
} from "../src/enrollment";
import type {
  SteamAuthenticatedLogin,
  SteamEnrollmentPrincipal,
} from "../src/enrollment-contracts";

const now = new Date("2099-01-01T00:00:00.000Z");
const principal: SteamEnrollmentPrincipal = Object.freeze({
  tenantId: "tenant-north-dock",
  userId: "user-ada",
  sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
});

function authenticated(configVdf: Uint8Array): SteamAuthenticatedLogin {
  return Object.freeze({
    kind: "AUTHENTICATED",
    accountId: "steam-account-42",
    accountName: "deviludo_build_bot",
    configVdf,
    allowedAppIds: Object.freeze(["2841930"]),
    permissions: Object.freeze(["EditAppMetadata", "PublishAppChanges"] as const),
    expiresAt: "2099-02-01T00:00:00.000Z",
  });
}

test("Steam enrollment requires an isolated Guard challenge and persists only a config.vdf SecretRef", async () => {
  const store = new InMemorySteamEnrollmentStore();
  const configVdf = new TextEncoder().encode("sensitive-config-vdf-session");
  const vaultWrites: Uint8Array[] = [];
  let beginPassword = "";
  let completedCode = "";
  const coordinator = new SteamEnrollmentCoordinator({
    store,
    publicOrigin: "https://steam-enroll.deviludo.example/",
    now: () => now,
    connector: {
      async begin(input) {
        beginPassword = new TextDecoder().decode(input.password);
        return { kind: "GUARD_REQUIRED", challengeSecretRef: "vault://kv/steam/challenges/challenge-1" };
      },
      async completeGuard(input) {
        completedCode = new TextDecoder().decode(input.guardCode);
        assert.equal(input.challengeSecretRef, "vault://kv/steam/challenges/challenge-1");
        return authenticated(configVdf);
      },
    },
    vault: {
      async write(input) {
        vaultWrites.push(input.plaintext.slice());
        assert.match(input.path, /^steam\/config-vdf\/tenant-north-dock\//);
        return {
          secretRef: "vault://kv/steam/config-vdf/version-1",
          maskedFingerprint: "sha256:1234abcd…987654",
        };
      },
      async revoke() { throw new Error("must not revoke a committed secret"); },
    },
  });

  const started = await coordinator.begin(principal, "steam-enrollment-1");
  const replay = await coordinator.begin(principal, "steam-enrollment-1");
  assert.deepEqual(replay, started);
  assert.equal(started.state, "WAITING_CREDENTIALS");
  assert.equal(started.enrollmentUrl, `https://steam-enroll.deviludo.example/enrollments/${started.enrollmentId}`);

  const password = new TextEncoder().encode("not-a-real-password");
  const challenged = await coordinator.submitCredentials({
    principal,
    enrollmentId: started.enrollmentId,
    accountName: "deviludo_build_bot",
    password,
  });
  assert.equal(beginPassword, "not-a-real-password");
  assert.deepEqual([...password], new Array(password.byteLength).fill(0));
  assert.equal(challenged.state, "WAITING_STEAM_GUARD");

  const guardCode = new TextEncoder().encode("ABC123");
  const ready = await coordinator.submitGuardCode({ principal, enrollmentId: started.enrollmentId, guardCode });
  assert.equal(completedCode, "ABC123");
  assert.deepEqual([...guardCode], new Array(guardCode.byteLength).fill(0));
  assert.deepEqual([...configVdf], new Array(configVdf.byteLength).fill(0));
  assert.equal(new TextDecoder().decode(vaultWrites[0]), "sensitive-config-vdf-session");
  assert.equal(ready.state, "READY");
  assert.equal(ready.enrollmentUrl, null);

  const persisted = await store.find({
    tenantId: principal.tenantId,
    enrollmentId: started.enrollmentId,
    userId: principal.userId,
    sessionBindingDigest: (await import("node:crypto")).createHash("sha256").update(principal.sessionBinding).digest("hex"),
  });
  assert.equal(persisted.buildSession?.configVdfSecretRef, "vault://kv/steam/config-vdf/version-1");
  const serialized = JSON.stringify(persisted);
  assert.doesNotMatch(serialized, /not-a-real-password|ABC123|sensitive-config-vdf-session/);
});

test("Steam enrollment binds idempotency and browser session and revokes an uncommitted Vault write", async () => {
  const store = new InMemorySteamEnrollmentStore();
  const configVdf = new TextEncoder().encode("uncommitted-config-vdf");
  const revoked: string[] = [];
  const coordinator = new SteamEnrollmentCoordinator({
    store,
    publicOrigin: "https://steam-enroll.deviludo.example/",
    now: () => now,
    connector: {
      async begin() { return authenticated(configVdf); },
      async completeGuard() { throw new Error("must not run"); },
    },
    vault: {
      async write() {
        return { secretRef: "vault://kv/steam/config-vdf/uncommitted", maskedFingerprint: "sha256:1234abcd…987654" };
      },
      async revoke(secretRef) { revoked.push(secretRef); },
    },
  });
  const started = await coordinator.begin(principal, "steam-enrollment-2");
  await assert.rejects(
    coordinator.begin({ ...principal, sessionBinding: "different-session-binding-that-is-also-long-enough" }, "steam-enrollment-2"),
    /idempotency key conflicts/,
  );
  await assert.rejects(
    coordinator.submitCredentials({
      principal: { ...principal, userId: "user-mallory" },
      enrollmentId: started.enrollmentId,
      accountName: "deviludo_build_bot",
      password: new TextEncoder().encode("another-password"),
    }),
    /principal does not match/,
  );

  const rejectingStore = new InMemorySteamEnrollmentStore();
  const rejectingCoordinator = new SteamEnrollmentCoordinator({
    store: {
      create: (input) => rejectingStore.create(input),
      find: (input) => rejectingStore.find(input),
      saveChallenge: (input) => rejectingStore.saveChallenge(input),
      async complete() { throw new Error("database unavailable"); },
    },
    publicOrigin: "https://steam-enroll.deviludo.example/",
    now: () => now,
    connector: {
      async begin() { return authenticated(configVdf); },
      async completeGuard() { throw new Error("must not run"); },
    },
    vault: {
      async write() {
        return { secretRef: "vault://kv/steam/config-vdf/uncommitted", maskedFingerprint: "sha256:1234abcd…987654" };
      },
      async revoke(secretRef) { revoked.push(secretRef); },
    },
  });
  const retry = await rejectingCoordinator.begin(principal, "steam-enrollment-3");
  const password = new TextEncoder().encode("third-password");
  await assert.rejects(rejectingCoordinator.submitCredentials({
    principal,
    enrollmentId: retry.enrollmentId,
    accountName: "deviludo_build_bot",
    password,
  }), /database unavailable/);
  assert.deepEqual(revoked, ["vault://kv/steam/config-vdf/uncommitted"]);
  assert.deepEqual([...password], new Array(password.byteLength).fill(0));
  assert.deepEqual([...configVdf], new Array(configVdf.byteLength).fill(0));
});
