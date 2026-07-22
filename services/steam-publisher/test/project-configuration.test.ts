import assert from "node:assert/strict";
import test from "node:test";
import type { SteamBuildSession } from "../src/contracts";
import { SteamProjectConfigurationCoordinator } from "../src/project-configuration";
import type {
  SteamProjectConfigurationIntent,
  SteamProjectConfigurationStore,
  SteamProjectReleaseConfiguration,
} from "../src/project-configuration-contracts";
import { PostgresSteamProjectConfigurationStore } from "../src/project-configuration-postgres";
import type { SteamPostgresClient, SteamPostgresPool } from "../src/enrollment-postgres";
import { postgresReadinessResult } from "./postgres-readiness-fixture";

const now = new Date("2099-01-01T00:00:00.000Z");
const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const principal = Object.freeze({ tenantId, userId, sessionBinding: "s".repeat(43) });

class MemoryStore implements SteamProjectConfigurationStore {
  intent: SteamProjectConfigurationIntent | null = null;
  configuration: SteamProjectReleaseConfiguration | null = null;
  readonly session: SteamBuildSession = Object.freeze({ id: "44444444-4444-4444-8444-444444444444", tenantId,
    accountId: "build-account-1", accountName: "deviludo_build", configVdfSecretRef: "vault://steam/config-vdf/1",
    credentialVersionId: "55555555-5555-4555-8555-555555555555", allowedAppIds: Object.freeze(["480", "570"]),
    permissions: Object.freeze(["EditAppMetadata", "PublishAppChanges"] as const), state: "ACTIVE",
    verifiedAt: now.toISOString(), expiresAt: "2099-03-01T00:00:00.000Z" });

  async probe() {}
  async findStatus() { return Object.freeze({ activeConfiguration: this.configuration, pendingIntent: this.intent?.state === "CONFIGURING" ? this.intent : null }); }
  async createIntent(input: Parameters<SteamProjectConfigurationStore["createIntent"]>[0]) {
    if (this.intent) {
      if (this.intent.idempotencyKey === input.idempotencyKey && this.intent.requestDigest === input.requestDigest) return this.intent;
      throw new Error("idempotency key conflicts");
    }
    this.intent = Object.freeze({ ...input, state: "CONFIGURING", buildSession: this.session,
      releaseConfigurationId: null, completedAt: null });
    return this.intent;
  }
  async findIntent(input: Parameters<SteamProjectConfigurationStore["findIntent"]>[0]) {
    if (!this.intent || this.intent.id !== input.intentId || this.intent.tenantId !== input.tenantId
      || this.intent.projectId !== input.projectId || this.intent.userId !== input.userId
      || this.intent.sessionBindingDigest !== input.sessionBindingDigest) throw new Error("principal mismatch");
    return this.intent;
  }
  async complete(input: Parameters<SteamProjectConfigurationStore["complete"]>[0]) {
    if (!this.intent) throw new Error("intent missing");
    this.configuration = Object.freeze({ id: input.releaseConfigurationId, projectId: input.projectId, revision: 1,
      steamAppId: input.steamAppId, betaBranch: input.betaBranch, platformDepots: input.platformDepots,
      buildSessionId: this.session.id, buildSessionState: this.session.state,
      buildSessionExpiresAt: this.session.expiresAt, accountName: this.session.accountName, createdAt: input.at });
    this.intent = Object.freeze({ ...this.intent, state: "COMPLETED", releaseConfigurationId: input.releaseConfigurationId,
      completedAt: input.at });
    return this.configuration;
  }
}

function coordinator(store = new MemoryStore()) {
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const revoked: string[] = [];
  return { store, writes, revoked, value: new SteamProjectConfigurationCoordinator({ store,
    publicOrigin: "https://steam.deviludo.example/", now: () => now,
    vault: { async write(input) { writes.push({ path: input.path, bytes: new Uint8Array(input.plaintext) });
      return { secretRef: "vault://steam/beta/password/v1", maskedFingerprint: "sha256:01234567…abcdef" }; },
    async revoke(secretRef) { revoked.push(secretRef); } } }) };
}

class ProbePool implements SteamPostgresPool {
  released = 0;
  query = "";

  constructor(private readonly missingTable: string | null = null) {}

  async connect(): Promise<SteamPostgresClient> {
    return {
      query: async <Row extends Record<string, unknown>>(query: string) => {
        this.query = query;
        const readiness = postgresReadinessResult<Row>(query, this.missingTable);
        if (!readiness) throw new Error("Unexpected probe query");
        return readiness;
      },
      release: () => { this.released += 1; },
    };
  }
}

test("project Steam configuration readiness requires every immutable schema table", async () => {
  const ready = new ProbePool();
  await new PostgresSteamProjectConfigurationStore(ready).probe();
  assert.match(ready.query, /steam_project_configuration_intents/);
  assert.match(ready.query, /steam_project_depot_configurations/);
  assert.match(ready.query, /steam_project_release_configurations/);
  assert.match(ready.query, /steam_build_sessions/);
  assert.match(ready.query, /steam_enrollments/);
  assert.match(ready.query, /tenant_memberships/);
  assert.equal(ready.released, 1);

  const incomplete = new ProbePool("steam_project_depot_configurations");
  await assert.rejects(new PostgresSteamProjectConfigurationStore(incomplete).probe(), /schema is unavailable/);
  assert.equal(incomplete.released, 1);
});

test("project Steam configuration freezes one immutable release revision and never replays the branch secret", async () => {
  const runtime = coordinator();
  assert.equal((await runtime.value.status(principal, projectId)).state, "UNCONFIGURED");
  const intent = await runtime.value.begin(principal, projectId, "configure-project-1");
  assert.equal(intent.state, "CONFIGURING");
  assert.equal(intent.configurationUrl,
    `https://steam.deviludo.example/projects/${projectId}/steam-configuration/${intent.intentId}`);
  assert.equal((await runtime.value.status(principal, projectId)).state, "CONFIGURING");

  const password = new TextEncoder().encode("privateBeta42!");
  const completed = await runtime.value.completeConfiguration({ principal, projectId, intentId: intent.intentId,
    steamAppId: "480", betaBranch: "deviludo_beta", platformDepots: Object.freeze({ windows: "481", linux: "482" }),
    branchPassword: password });
  assert.equal(completed.state, "READY");
  assert.equal(completed.revision, 1);
  assert.deepEqual([...password], new Array(password.byteLength).fill(0));
  assert.equal(runtime.writes.length, 1);
  assert.match(runtime.writes[0]!.path, new RegExp(`^steam/beta-branch-password/${tenantId}/${projectId}/`));
  assert.equal(new TextDecoder().decode(runtime.writes[0]!.bytes), "privateBeta42!");
  assert.deepEqual(await runtime.value.status(principal, projectId), {
    state: "READY", projectId, configurationUrl: null, intentExpiresAt: null, revision: 1,
    steamAppId: "480", betaBranch: "deviludo_beta", platformDepots: { windows: "481", linux: "482" },
    accountName: "deviludo_build", sessionExpiresAt: "2099-03-01T00:00:00.000Z",
  });

  const replay = new TextEncoder().encode("differentBeta9!");
  assert.equal((await runtime.value.completeConfiguration({ principal, projectId, intentId: intent.intentId,
    steamAppId: "570", betaBranch: "other_beta", platformDepots: { macos: "571" }, branchPassword: replay })).state, "READY");
  assert.equal(runtime.writes.length, 1);
  assert.deepEqual([...replay], new Array(replay.byteLength).fill(0));
  assert.equal(runtime.store.configuration?.steamAppId, "480");
});

test("project Steam configuration rejects an App outside the bound build session before Vault", async () => {
  const runtime = coordinator();
  const intent = await runtime.value.begin(principal, projectId, "configure-project-2");
  const password = new TextEncoder().encode("privateBeta42!");
  await assert.rejects(runtime.value.completeConfiguration({ principal, projectId, intentId: intent.intentId,
    steamAppId: "730", betaBranch: "deviludo_beta", platformDepots: { windows: "731" }, branchPassword: password }),
  /does not authorize/);
  assert.equal(runtime.writes.length, 0);
  assert.deepEqual([...password], new Array(password.byteLength).fill(0));
});

test("project Steam configuration revokes the just-written Vault version when persistence fails", async () => {
  const store = new MemoryStore();
  store.complete = async () => { throw new Error("database unavailable"); };
  const runtime = coordinator(store);
  const intent = await runtime.value.begin(principal, projectId, "configure-project-3");
  await assert.rejects(runtime.value.completeConfiguration({ principal, projectId, intentId: intent.intentId,
    steamAppId: "480", betaBranch: "deviludo_beta", platformDepots: { windows: "481" },
    branchPassword: new TextEncoder().encode("privateBeta42!") }), /database unavailable/);
  assert.deepEqual(runtime.revoked, ["vault://steam/beta/password/v1"]);
});
