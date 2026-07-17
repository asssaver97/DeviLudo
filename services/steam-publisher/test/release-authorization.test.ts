import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { signSteamPublishAuthorization, verifySteamPublishAuthorization } from "../src/artifacts";
import {
  InMemoryReleaseAuthorizationStore,
  ReleaseAuthorizationCoordinator,
} from "../src/release-authorization";
import { PostgresReleaseAuthorizationStore } from "../src/release-authorization-postgres";
import type {
  SteamPostgresClient,
  SteamPostgresQueryResult,
} from "../src/enrollment-postgres";

const now = new Date("2099-01-01T00:05:00.000Z");
const signingKey = generateKeyPairSync("ed25519");
const principal = Object.freeze({
  tenantId: "tenant-north-dock",
  userId: "user-ada",
  sessionBinding: "session-binding-with-at-least-thirty-two-random-characters",
});
const snapshot = Object.freeze({
  tenantId: principal.tenantId,
  projectId: "project-ember",
  releaseId: "release-9",
  workflowId: "delivery-project-ember-9",
  state: "WAITING_MFA" as const,
  mainCommitSha: "a".repeat(40),
  evidenceBundleDigest: "b".repeat(64),
});

test("fresh MFA signs the authoritative release and resumes the same Temporal workflow idempotently", async () => {
  const store = new InMemoryReleaseAuthorizationStore();
  let verifierCalls = 0;
  let signerCalls = 0;
  let archiveCalls = 0;
  let signalCalls = 0;
  let failFirstSignal = true;
  const coordinator = new ReleaseAuthorizationCoordinator({
    store,
    publicOrigin: "https://mfa.deviludo.example/",
    now: () => now,
    snapshots: {
      async resolveForMfa(input) {
        assert.deepEqual(input, { tenantId: principal.tenantId, releaseId: snapshot.releaseId, requestedBy: principal.userId });
        return snapshot;
      },
    },
    challenges: {
      async begin(input) {
        assert.equal(input.releaseId, snapshot.releaseId);
        assert.match(input.sessionBindingDigest, /^[a-f0-9]{64}$/);
        return { authorizationUrl: `https://mfa.deviludo.example/approvals/${input.approvalId}` };
      },
    },
    verifier: {
      async verify(input) {
        verifierCalls += 1;
        assert.deepEqual(input.assertion, { opaqueWebAuthnResponse: true });
        return {
          approvalId: input.approvalId,
          userId: principal.userId,
          assertionId: "mfa-assertion-91",
          assuranceLevel: "AAL2",
          verifiedAt: now.toISOString(),
        };
      },
    },
    signer: {
      async sign(claims) {
        signerCalls += 1;
        return signSteamPublishAuthorization("mfa-key-1", signingKey.privateKey, claims);
      },
    },
    archive: {
      async persist(input) {
        archiveCalls += 1;
        assert.equal(input.releaseId, snapshot.releaseId);
        assert.equal(verifySteamPublishAuthorization(signingKey.publicKey, input.authorization), true);
        assert.equal(input.authorization.claims.mainCommitSha, snapshot.mainCommitSha);
        assert.equal(input.authorization.claims.evidenceBundleDigest, snapshot.evidenceBundleDigest);
      },
    },
    workflow: {
      async signal(input) {
        signalCalls += 1;
        assert.equal(input.workflowId, snapshot.workflowId);
        assert.match(input.signalId, /^mfa:/);
        if (failFirstSignal) {
          failFirstSignal = false;
          throw new Error("Temporal temporarily unavailable");
        }
      },
    },
  });

  const started = await coordinator.begin(principal, snapshot.releaseId, "release-auth-9");
  const replay = await coordinator.begin(principal, snapshot.releaseId, "release-auth-9");
  assert.deepEqual(replay, started);
  assert.equal(started.state, "MFA_REQUIRED");
  assert.equal(started.workflowId, null);

  await assert.rejects(
    coordinator.complete({ tenantId: principal.tenantId, userId: principal.userId, approvalId: started.approvalId, assertion: { opaqueWebAuthnResponse: true } }),
    /Temporal temporarily unavailable/,
  );
  const completed = await coordinator.complete({ tenantId: principal.tenantId, userId: principal.userId, approvalId: started.approvalId, assertion: { ignoredOnResume: true } });
  assert.equal(completed.state, "DISPATCHED");
  assert.equal(completed.workflowId, snapshot.workflowId);
  assert.equal(verifierCalls, 1);
  assert.equal(signerCalls, 1);
  assert.equal(archiveCalls, 2);
  assert.equal(signalCalls, 2);
  assert.deepEqual(await coordinator.complete({ tenantId: principal.tenantId, userId: principal.userId, approvalId: started.approvalId, assertion: null }), completed);
});

test("release authorization rejects snapshot drift, wrong MFA user and unapproved redirect origins", async () => {
  function build(options: { wrongSnapshot?: boolean; wrongUser?: boolean; evilUrl?: boolean }) {
    return new ReleaseAuthorizationCoordinator({
      store: new InMemoryReleaseAuthorizationStore(),
      publicOrigin: "https://mfa.deviludo.example/",
      now: () => now,
      snapshots: { async resolveForMfa() { return options.wrongSnapshot ? { ...snapshot, mainCommitSha: "invalid" } : snapshot; } },
      challenges: { async begin(input) { return { authorizationUrl: `${options.evilUrl ? "https://evil.example" : "https://mfa.deviludo.example"}/approvals/${input.approvalId}` }; } },
      verifier: { async verify(input) { return { approvalId: input.approvalId, userId: options.wrongUser ? "user-mallory" : principal.userId, assertionId: "mfa-assertion-91", assuranceLevel: "AAL2", verifiedAt: now.toISOString() }; } },
      signer: { async sign(claims) { return signSteamPublishAuthorization("mfa-key-1", signingKey.privateKey, claims); } },
      archive: { async persist() {} },
      workflow: { async signal() {} },
    });
  }
  await assert.rejects(build({ wrongSnapshot: true }).begin(principal, snapshot.releaseId, "bad-snapshot"), /snapshot is invalid/);
  await assert.rejects(build({ evilUrl: true }).begin(principal, snapshot.releaseId, "bad-url"), /URL is invalid/);
  const wrongUser = build({ wrongUser: true });
  const started = await wrongUser.begin(principal, snapshot.releaseId, "bad-user");
  await assert.rejects(wrongUser.complete({ tenantId: principal.tenantId, userId: principal.userId, approvalId: started.approvalId, assertion: {} }), /MFA verification is invalid/);
});

test("Postgres release authorization lookup sets tenant RLS before reading an MFA record", async () => {
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  let released = false;
  const row = {
    approval_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    project_id: "33333333-3333-4333-8333-333333333333",
    release_id: "44444444-4444-4444-8444-444444444444",
    workflow_id: "delivery-release-44",
    user_subject: "user-ada",
    session_binding_digest: "a".repeat(64),
    idempotency_key: "release-auth-44",
    request_digest: "b".repeat(64),
    state: "MFA_REQUIRED",
    main_commit_sha: "c".repeat(40),
    evidence_bundle_digest: "d".repeat(64),
    authorization_url: "https://mfa.deviludo.example/approvals/11111111-1111-4111-8111-111111111111",
    mfa_assertion_id: null,
    signed_authorization: null,
    created_at: "2099-01-01T00:00:00.000Z",
    expires_at: "2099-01-01T00:10:00.000Z",
    verified_at: null,
    dispatched_at: null,
  };
  const client: SteamPostgresClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      calls.push({ text, values });
      if (text.includes("SELECT * FROM deviludo.steam_release_authorizations")) {
        return { rowCount: 1, rows: [row] } as unknown as SteamPostgresQueryResult<Row>;
      }
      return { rowCount: 0, rows: [] } as SteamPostgresQueryResult<Row>;
    },
    release() { released = true; },
  };
  const store = new PostgresReleaseAuthorizationStore({ async connect() { return client; } });
  const found = await store.find({ tenantId: row.tenant_id, approvalId: row.approval_id });
  assert.equal(calls[0].text, "BEGIN");
  assert.equal(calls[1].text, "SELECT set_config('app.tenant_id', $1, true)");
  assert.deepEqual(calls[1].values, [row.tenant_id]);
  assert.equal(calls.at(-1)?.text, "COMMIT");
  assert.equal(released, true);
  assert.equal(found.snapshot.mainCommitSha, row.main_commit_sha);
  assert.equal(found.signedAuthorization, null);
  assert.doesNotMatch(JSON.stringify(calls), /assertion|credential|mfa.?response/i);
});
