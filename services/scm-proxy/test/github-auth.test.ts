import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubInstallationAuthorizationBroker,
  InMemoryGitHubAuthorizationSecretStore,
  InMemoryGitHubAuthorizationStore,
} from "../src/github-auth";
import { GitHubRestUserAuthorizationVerifier } from "../src/github-auth-rest";
import type { GitHubAuthorizationPrincipal, GitHubVerifiedInstallation } from "../src/github-auth-contracts";

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
