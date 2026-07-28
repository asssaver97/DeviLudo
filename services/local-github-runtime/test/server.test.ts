import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGitHubRuntimeHeaders } from "../src/request-auth";
import { createLocalGitHubRuntimeServer } from "../src/server";

const key = Buffer.alloc(32, 19);

test("real local GitHub runtime completes PKCE authorization, persists no token, and lists live repositories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-local-github-"));
  const privateKeyFile = join(directory, "app.pem");
  const clientSecretFile = join(directory, "client-secret");
  const stateFile = join(directory, "state.json");
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(clientSecretFile, "client-secret-plaintext\n", { mode: 0o600 });
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      return response({ access_token: "ghu_ephemeral-user-token", token_type: "bearer" });
    }
    if (url.pathname === "/user") return response({ id: 7, node_id: "U_ada", login: "ada" });
    if (url.pathname === "/user/installations") return response({ installations: [installation()] });
    if (url.pathname === "/applications/Iv1.abcdefghijklmnop/token") return new Response(null, { status: 204 });
    if (url.pathname === "/app/installations/42/access_tokens") {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      assert.match(authorization, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      assert.deepEqual(JSON.parse(String(init?.body)), { permissions: { metadata: "read" } });
      return response({ token: "ghs_repository-catalog-token", expires_at: new Date(Date.now() + 600_000).toISOString(), permissions: { metadata: "read" } }, 201);
    }
    if (url.pathname === "/installation/repositories") return response({ repositories: [
      { id: 99, node_id: "R_game", owner: { login: "ada" }, name: "real-game", default_branch: "develop", private: true, archived: false, disabled: false },
      { id: 100, node_id: "R_old", owner: { login: "ada" }, name: "archived", default_branch: "main", private: false, archived: true, disabled: false },
    ] });
    if (url.pathname === "/installation/token") return new Response(null, { status: 204 });
    throw new Error(`unexpected GitHub call ${url.href}`);
  };
  const options = {
    appId: "1234",
    appSlug: "deviludo-local-test",
    clientId: "Iv1.abcdefghijklmnop",
    clientSecretFile,
    privateKeyFile,
    redirectUri: "http://127.0.0.1:3000/api/connections/github/callback",
    githubUserId: 7,
    stateFile,
    authenticationKey: key,
    fetch: fetcher,
  } as const;
  const server = await createLocalGitHubRuntimeServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const unsigned = await fetch(`${origin}/v1/github/status`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unsigned.status, 403);

    const begin = await call(origin, "/v1/github/begin", { returnPath: "/settings/connections" });
    assert.equal(begin.response.status, 201);
    const installUrl = new URL(String(begin.payload.data.authorizeUrl));
    const installState = installUrl.searchParams.get("state") ?? "";
    assert.equal(installUrl.pathname, "/apps/deviludo-local-test/installations/new");

    const setup = await call(origin, "/v1/github/setup", { state: installState, installationId: "42", setupAction: "install" });
    assert.equal(setup.response.status, 200);
    const oauthUrl = new URL(String(setup.payload.data.authorizeUrl));
    assert.equal(oauthUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(oauthUrl.searchParams.get("redirect_uri"), options.redirectUri);

    const completed = await call(origin, "/v1/github/complete", { state: oauthUrl.searchParams.get("state"), code: "one-time-code" });
    assert.equal(completed.response.status, 200);
    assert.deepEqual(completed.payload.data, { returnPath: "/settings/connections" });

    const status = await call(origin, "/v1/github/status", {});
    assert.equal(status.payload.data.state, "CONNECTED");
    assert.equal(status.payload.data.accountLogin, "ada");

    const repositories = await call(origin, "/v1/github/repositories", {});
    assert.deepEqual(repositories.payload.data.installations?.[0]?.repositories, [{
      installationId: "42", repositoryId: 99, repositoryNodeId: "R_game", owner: "ada", name: "real-game",
      defaultBranch: "develop", private: true, archived: false, disabled: false,
    }]);
    const persisted = await readFile(stateFile, "utf8");
    assert.doesNotMatch(persisted, /one-time-code|client-secret|ghu_|ghs_|code_challenge/);
    assert.match(persisted, /"installationId":"42"/);
    assert.equal(calls.includes("DELETE https://api.github.com/applications/Iv1.abcdefghijklmnop/token"), true);
    assert.equal(calls.includes("DELETE https://api.github.com/installation/token"), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  const restored = await createLocalGitHubRuntimeServer(options);
  await new Promise<void>((resolve) => restored.listen(0, "127.0.0.1", resolve));
  const restoredAddress = restored.address();
  if (!restoredAddress || typeof restoredAddress === "string") throw new Error("missing restored address");
  try {
    const status = await call(`http://127.0.0.1:${restoredAddress.port}`, "/v1/github/status", {});
    assert.equal(status.payload.data.state, "CONNECTED");
    assert.equal(status.payload.data.installationCount, 1);
  } finally {
    await new Promise<void>((resolve, reject) => restored.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function call(origin: string, path: string, value: unknown) {
  const body = JSON.stringify(value);
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...createLocalGitHubRuntimeHeaders({ method: "POST", path, body }, { key }) },
    body,
  });
  return { response, payload: await response.json() as RuntimePayload };
}

type RuntimePayload = Readonly<{
  data: Readonly<{
    authorizeUrl?: string;
    returnPath?: string;
    state?: string;
    accountLogin?: string;
    installationCount?: number;
    installations?: readonly Readonly<{ repositories: readonly unknown[] }>[];
  }>;
}>;

function installation() {
  return {
    id: 42,
    app_slug: "deviludo-local-test",
    suspended_at: null,
    account: { node_id: "U_ada", login: "ada" },
    repository_selection: "selected",
    permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
