import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  GitHubInstallationAuthorizationBroker,
  InMemoryGitHubAuthorizationSecretStore,
  InMemoryGitHubAuthorizationStore,
} from "../src/github-auth";
import { GitHubRestUserAuthorizationVerifier } from "../src/github-auth-rest";
import type { GitHubAuthorizationPrincipal, GitHubVerifiedInstallation } from "../src/github-auth-contracts";
import {
  InMemoryGitHubBrokerRequestLedger,
  registerGitHubAuthorizationBrokerRoutes,
} from "../src/github-auth-http";
import {
  PostgresGitHubAuthorizationStore,
  type ScmPostgresClient,
  type ScmPostgresQueryResult,
} from "../src/github-auth-postgres";
import { PostgresGitHubBrokerRequestLedger } from "../src/github-auth-ledger-postgres";
import { MtlsGitHubAuthorizationSecretClient } from "../src/github-auth-secret-client";

const principal: GitHubAuthorizationPrincipal = Object.freeze({
  tenantId: "tenant-north-dock",
  userId: "user-ada",
  sessionBinding: "session-binding-with-at-least-32-bytes-ada",
  expectedGithubUserId: 7,
});

const verifiedInstallation: GitHubVerifiedInstallation = Object.freeze({
  installationId: "42",
  githubUserId: 7,
  githubUserNodeId: "U_ada",
  githubUserLogin: "ada",
  accountNodeId: "O_north-dock",
  accountLogin: "north-dock",
  repositorySelection: "selected",
  permissions: Object.freeze({ contents: "write", pull_requests: "write", metadata: "read" }),
  appSlug: "deviludo-app",
  verifiedAt: "2099-01-01T00:00:00.000Z",
});

test("two-stage GitHub App authorization stores only state digests and persists a user-verified installation", async () => {
  const store = new InMemoryGitHubAuthorizationStore();
  const secrets = new InMemoryGitHubAuthorizationSecretStore();
  const verifierInputs: unknown[] = [];
  const broker = new GitHubInstallationAuthorizationBroker({
    appSlug: "deviludo-app",
    clientId: "Iv1.abcdefghijklmnop",
    redirectUri: "https://deviludo.example/api/connections/github/callback",
    store,
    secrets,
    verifier: {
      async verify(input) {
        verifierInputs.push(input);
        return { ...verifiedInstallation, verifiedAt: input.at };
      },
    },
    now: () => new Date("2099-01-01T00:00:00.000Z"),
  });

  const install = await broker.begin(principal, "/projects/ember/settings/connections");
  const installUrl = new URL(install.authorizeUrl);
  const installState = installUrl.searchParams.get("state") ?? "";
  assert.equal(installUrl.origin, "https://github.com");
  assert.equal(installUrl.pathname, "/apps/deviludo-app/installations/new");
  assert.equal(installState.length, 43);
  assert.equal([...store.intents.keys()].includes(installState), false);
  assert.doesNotMatch(JSON.stringify([...store.intents.values()]), new RegExp(installState));

  const oauth = await broker.beginUserAuthorization({ principal, state: installState, installationId: "42", setupAction: "install" });
  const oauthUrl = new URL(oauth.authorizeUrl);
  const oauthState = oauthUrl.searchParams.get("state") ?? "";
  assert.equal(oauthUrl.href.includes("code_challenge_method=S256"), true);
  assert.equal(oauthUrl.searchParams.get("redirect_uri"), "https://deviludo.example/api/connections/github/callback");
  assert.equal(oauthUrl.searchParams.get("code_challenge")?.length, 43);
  await assert.rejects(
    broker.beginUserAuthorization({ principal, state: installState, installationId: "42", setupAction: "install" }),
    /expired or already used/,
  );

  const completed = await broker.completeUserAuthorization({ principal, state: oauthState, code: "single-use-github-code" });
  assert.equal(completed.returnPath, "/projects/ember/settings/connections");
  assert.deepEqual(completed.installation, { ...verifiedInstallation, verifiedAt: "2099-01-01T00:00:00.000Z" });
  assert.equal(store.installations.get("tenant-north-dock:42")?.accountLogin, "north-dock");
  assert.equal(verifierInputs.length, 1);
  assert.equal(JSON.stringify(store.intents).includes("single-use-github-code"), false);
  assert.equal(JSON.stringify(store.intents).includes("session-binding-with-at-least-32-bytes-ada"), false);
});

test("GitHub authorization state is bound to tenant, user, session, stage and expiry", async () => {
  let now = new Date("2099-01-01T00:00:00.000Z");
  const broker = new GitHubInstallationAuthorizationBroker({
    appSlug: "deviludo-app",
    clientId: "Iv1.abcdefghijklmnop",
    redirectUri: "http://127.0.0.1:3000/api/connections/github/callback",
    store: new InMemoryGitHubAuthorizationStore(),
    secrets: new InMemoryGitHubAuthorizationSecretStore(),
    verifier: { async verify() { return verifiedInstallation; } },
    now: () => now,
  });
  const install = await broker.begin(principal);
  const state = new URL(install.authorizeUrl).searchParams.get("state") ?? "";
  await assert.rejects(
    broker.beginUserAuthorization({ principal: { ...principal, sessionBinding: `${principal.sessionBinding}-other` }, state, installationId: "42", setupAction: "install" }),
    /state is invalid/,
  );
  now = new Date("2099-01-01T00:11:00.000Z");
  await assert.rejects(
    broker.beginUserAuthorization({ principal, state, installationId: "42", setupAction: "install" }),
    /expired or already used/,
  );
  await assert.rejects(broker.begin(principal, "//attacker.example"), /return path/);
});

test("internal GitHub broker HTTP route is workload-authenticated and idempotent", async () => {
  const store = new InMemoryGitHubAuthorizationStore();
  const broker = new GitHubInstallationAuthorizationBroker({
    appSlug: "deviludo-app",
    clientId: "Iv1.abcdefghijklmnop",
    redirectUri: "https://deviludo.example/api/connections/github/callback",
    store,
    secrets: new InMemoryGitHubAuthorizationSecretStore(),
    verifier: { async verify(input) { return { ...verifiedInstallation, verifiedAt: input.at }; } },
    now: () => new Date("2099-01-01T00:00:00.000Z"),
  });
  let authorized = false;
  const server = Fastify({ logger: false });
  registerGitHubAuthorizationBrokerRoutes(server, {
    broker,
    ledger: new InMemoryGitHubBrokerRequestLedger(),
    authorize() {
      if (!authorized) throw new Error("not authorized");
    },
  });
  const beginRequest = {
    method: "POST",
    url: "/v1/github/authorizations/begin",
    headers: { "idempotency-key": "github-begin-http-001" },
    payload: { principal, returnPath: "/settings/connections" },
  } as const;
  assert.equal((await server.inject(beginRequest)).statusCode, 401);
  authorized = true;
  const first = await server.inject(beginRequest);
  const replay = await server.inject(beginRequest);
  assert.equal(first.statusCode, 201);
  assert.deepEqual(replay.json(), first.json());
  assert.equal(store.intents.size, 1);
  const installState = new URL(first.json().authorizeUrl).searchParams.get("state") ?? "";

  const setup = await server.inject({
    method: "POST",
    url: "/v1/github/authorizations/setup",
    headers: { "idempotency-key": "github-setup-http-001" },
    payload: { principal, state: installState, installationId: "42", setupAction: "install" },
  });
  assert.equal(setup.statusCode, 200);
  const oauthState = new URL(setup.json().authorizeUrl).searchParams.get("state") ?? "";
  const completed = await server.inject({
    method: "POST",
    url: "/v1/github/authorizations/complete",
    headers: { "idempotency-key": "github-oauth-http-001" },
    payload: { principal, state: oauthState, code: "single-use-code" },
  });
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(completed.json(), { returnPath: "/settings/connections" });
  assert.doesNotMatch(completed.body, /single-use-code|session-binding/);
  await server.close();
});

test("Postgres GitHub authorization store applies tenant RLS and persists only digests", async () => {
  const statements: { text: string; values?: readonly unknown[] }[] = [];
  const intent = {
    id: "11111111-1111-4111-8111-111111111111",
    stateDigest: "a".repeat(64),
    tenantId: "22222222-2222-4222-8222-222222222222",
    userId: "user-ada",
    sessionBindingDigest: "b".repeat(64),
    stage: "INSTALL",
    installationId: null,
    pkceVerifierSecretRef: null,
    returnPath: "/settings/connections",
    status: "PENDING",
    claimToken: null,
    claimExpiresAt: null,
    createdAt: "2099-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:10:00.000Z",
    completedAt: null,
    failureCode: null,
  } as const;
  const client: ScmPostgresClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<ScmPostgresQueryResult<Row>> {
      statements.push({ text, values });
      if (text.includes("SET status = 'CLAIMED'")) {
        return {
          rowCount: 1,
          rows: [{
            id: intent.id,
            state_digest: intent.stateDigest,
            tenant_id: intent.tenantId,
            user_subject: intent.userId,
            session_binding_digest: intent.sessionBindingDigest,
            stage: intent.stage,
            installation_id: null,
            pkce_verifier_secret_ref: null,
            return_path: intent.returnPath,
            status: "CLAIMED",
            claim_token: values?.[5],
            claim_expires_at: values?.[7],
            created_at: intent.createdAt,
            expires_at: intent.expiresAt,
            completed_at: null,
            failure_code: null,
          }],
        } as unknown as ScmPostgresQueryResult<Row>;
      }
      if (text.includes("RETURNING")) return { rowCount: 1, rows: [{ id: intent.id }] } as unknown as ScmPostgresQueryResult<Row>;
      return { rowCount: 0, rows: [] } as ScmPostgresQueryResult<Row>;
    },
    release() {},
  };
  const store = new PostgresGitHubAuthorizationStore({ async connect() { return client; } });
  await store.create(intent);
  const claimed = await store.claim({
    stateDigest: intent.stateDigest,
    stage: "INSTALL",
    tenantId: intent.tenantId,
    userId: intent.userId,
    sessionBindingDigest: intent.sessionBindingDigest,
    claimToken: "33333333-3333-4333-8333-333333333333",
    claimedAt: intent.createdAt,
    claimExpiresAt: "2099-01-01T00:02:00.000Z",
  });
  assert.equal(claimed.status, "CLAIMED");
  const begins = statements.filter((entry) => entry.text === "BEGIN").length;
  assert.equal(statements.filter((entry) => entry.text.includes("set_config")).length, begins);
  assert.equal(JSON.stringify(statements).includes(principal.sessionBinding), false);
  assert.equal(JSON.stringify(statements).includes(intent.sessionBindingDigest), true);
});

test("production GitHub request ledger fences retries without persisting OAuth state or responses", async () => {
  const statements: { text: string; values?: readonly unknown[] }[] = [];
  let status: "CLAIMED" | "COMPLETED" = "CLAIMED";
  let claimToken = "";
  const client: ScmPostgresClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<ScmPostgresQueryResult<Row>> {
      statements.push({ text, values });
      if (text.includes("INSERT INTO deviludo.github_authorization_request_ledger")) {
        claimToken = String(values?.[4]);
        return { rowCount: 1, rows: [] } as ScmPostgresQueryResult<Row>;
      }
      if (text.includes("SELECT operation, request_digest")) {
        return { rowCount: 1, rows: [{
          operation: "BEGIN",
          request_digest: "d".repeat(64),
          status,
          claim_token: status === "CLAIMED" ? claimToken : null,
          claim_active: status === "CLAIMED",
        }] } as unknown as ScmPostgresQueryResult<Row>;
      }
      if (text.includes("SET status = 'COMPLETED'")) {
        status = "COMPLETED";
        return { rowCount: 1, rows: [] } as ScmPostgresQueryResult<Row>;
      }
      if (text.includes("to_regclass")) {
        return { rowCount: 1, rows: [{ ledger: "deviludo.github_authorization_request_ledger" }] } as unknown as ScmPostgresQueryResult<Row>;
      }
      return { rowCount: 0, rows: [] } as ScmPostgresQueryResult<Row>;
    },
    release() {},
  };
  const ledger = new PostgresGitHubBrokerRequestLedger({ async connect() { return client; } });
  const state = "secret-oauth-state-that-must-never-be-persisted";
  const input = {
    tenantId: "22222222-2222-4222-8222-222222222222",
    operationName: "BEGIN" as const,
    idempotencyKey: "github-begin-durable-001",
    requestDigest: "d".repeat(64),
    operation: async () => ({ authorizeUrl: `https://github.com/install?state=${state}` }),
  };
  assert.match((await ledger.execute(input)).authorizeUrl, /github\.com/);
  await assert.rejects(ledger.execute(input), /already completed/);
  await ledger.probe();
  assert.equal(statements.filter((entry) => entry.text.includes("set_config('app.tenant_id'")).length, 3);
  assert.equal(JSON.stringify(statements).includes(state), false);
  assert.equal(JSON.stringify(statements).includes("authorizeUrl"), false);
});

test("mTLS GitHub secret client transports PKCE and client secrets only as bounded binary leases", async () => {
  const calls: Array<{ url: string; body?: Buffer }> = [];
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const secretRef = "vault://transit/github-auth/pkce-001";
  const pkce = "p".repeat(43);
  const clientSecret = "github-client-secret-value";
  const client = new MtlsGitHubAuthorizationSecretClient({
    endpoint: "https://secret-broker.internal/",
    tls: { key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    async http(url, input) {
      calls.push({ url: String(url), body: input.body });
      if (url.pathname === "/v1/github-authorization-secrets") {
        assert.equal(input.body?.toString("utf8"), pkce);
        return brokerResponse(201, "application/json", {
          schemaVersion: "deviludo.github-authorization-secret.v1", secretRef, expiresAt,
        });
      }
      if (url.pathname === "/v1/github-authorization-secrets:take") {
        return { statusCode: 200, contentType: "application/octet-stream", payload: Buffer.from(pkce) };
      }
      if (url.pathname === "/v1/github-authorization-secrets:revoke") {
        return { statusCode: 204, contentType: "", payload: Buffer.alloc(0) };
      }
      if (url.pathname === "/v1/static-secret-leases:resolve") {
        return { statusCode: 200, contentType: "application/octet-stream", payload: Buffer.from(clientSecret) };
      }
      return brokerResponse(200, "application/json", { status: "ok", service: "deviludo-secret-broker" });
    },
  });
  assert.equal(await client.put(pkce, expiresAt), secretRef);
  assert.equal(await client.take(secretRef), pkce);
  const lease = await client.resolve("vault://kv/github/client-secret/v3");
  assert.equal(lease.value, clientSecret);
  lease.destroy();
  assert.throws(() => lease.value, /destroyed/);
  await client.delete(secretRef);
  await client.probe();
  assert.equal(calls.length, 5);
  assert.equal(calls[0]?.body?.every((byte) => byte === 0), true);
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(pkce));
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(clientSecret));
});

test("REST verifier proves the signed-in user can access the exact installation and revokes its ephemeral token", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let destroyed = 0;
  const token = "ghu_ephemeral_user_access_token";
  const responses = [
    response({ access_token: token, token_type: "bearer", refresh_token: "ghr_must_not_escape" }),
    response({ id: 7, node_id: "U_ada", login: "ada" }),
    response({ total_count: 1, installations: [installationPayload()] }),
    new Response(null, { status: 204 }),
  ];
  const verifier = new GitHubRestUserAuthorizationVerifier({
    clientId: "Iv1.abcdefghijklmnop",
    clientSecretRef: "vault://kv/github/client-secret/v3",
    appSlug: "deviludo-app",
    redirectUri: "https://deviludo.example/api/connections/github/callback",
    secrets: {
      async resolve(secretRef) {
        assert.equal(secretRef, "vault://kv/github/client-secret/v3");
        return { value: "client-secret-plaintext", destroy() { destroyed += 1; } };
      },
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    },
  });

  const result = await verifier.verify({
    code: "one-time-code",
    codeVerifier: "a".repeat(43),
    installationId: "42",
    expectedGithubUserId: 7,
    at: "2099-01-01T00:00:00.000Z",
  });
  assert.deepEqual(result, verifiedInstallation);
  assert.equal(destroyed, 1);
  assert.equal(requests.length, 4);
  assert.equal(requests[0]?.url, "https://github.com/login/oauth/access_token");
  assert.equal(requests[0]?.init.redirect, "error");
  assert.match(String(requests[0]?.init.body), /code_verifier=/);
  assert.equal(requests[1]?.url, "https://api.github.com/user");
  assert.equal(requests[2]?.url, "https://api.github.com/user/installations?per_page=100&page=1");
  assert.equal(requests[3]?.init.method, "DELETE");
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes("client-secret"), false);
});

test("REST verifier rejects a spoofed user or elevated installation and still revokes the token", async () => {
  for (const scenario of [
    { userId: 8, installation: installationPayload() },
    { userId: 7, installation: installationPayload({ administration: "write" }) },
  ]) {
    const token = "ghu_ephemeral_user_access_token";
    let revoked = false;
    const responses = [
      response({ access_token: token, token_type: "bearer" }),
      response({ id: scenario.userId, node_id: "U_subject", login: "subject" }),
      ...(scenario.userId === 7 ? [response({ installations: [scenario.installation] })] : []),
      new Response(null, { status: 204 }),
    ];
    const verifier = new GitHubRestUserAuthorizationVerifier({
      clientId: "Iv1.abcdefghijklmnop",
      clientSecretRef: "vault://kv/github/client-secret/v3",
      appSlug: "deviludo-app",
      redirectUri: "https://deviludo.example/api/connections/github/callback",
      secrets: { async resolve() { return { value: "secret", destroy() {} }; } },
      fetch: async (_url, init) => {
        if (init?.method === "DELETE") revoked = true;
        const next = responses.shift();
        if (!next) throw new Error("unexpected request");
        return next;
      },
    });
    await assert.rejects(
      verifier.verify({ code: "code", codeVerifier: "b".repeat(43), installationId: "42", expectedGithubUserId: 7, at: "2099-01-01T00:00:00.000Z" }),
      /signed-in account|unapproved elevated permission/,
    );
    assert.equal(revoked, true);
  }
});

function installationPayload(extraPermissions: Record<string, string> = {}) {
  return {
    id: 42,
    app_slug: "deviludo-app",
    suspended_at: null,
    account: { node_id: "O_north-dock", login: "north-dock" },
    repository_selection: "selected",
    permissions: { contents: "write", pull_requests: "write", metadata: "read", ...extraPermissions },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function brokerResponse(statusCode: number, contentType: string, body: unknown) {
  return { statusCode, contentType, payload: Buffer.from(JSON.stringify(body)) };
}
