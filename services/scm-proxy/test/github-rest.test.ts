import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { GitHubRepositoryBinding } from "../src/github-contracts";
import { GitHubAppInstallationTokenBroker, GitHubRestConnector } from "../src/github-rest";

const token = "ghs_fixture_secret_that_must_not_leak";
const binding: GitHubRepositoryBinding = {
  tenantId: "tenant-1",
  projectId: "project-1",
  installationId: "123456",
  repositoryId: 991,
  repositoryNodeId: "R_repo991",
  owner: "north-dock-studio",
  name: "ember-archipelago",
  defaultBranch: "main",
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("installation token broker signs a short App JWT and requests one repository-scoped token", async () => {
  let signingInput = "";
  let tokenRequests = 0;
  let observed: { url: string; authorization: string; body: unknown; version: string } | null = null;
  const broker = new GitHubAppInstallationTokenBroker({
    appId: "778899",
    signer: {
      keyId: "vault-github-app-key-v3",
      async signRs256(input) {
        signingInput = new TextDecoder().decode(input);
        return new Uint8Array(256).fill(7);
      },
    },
    fetch: (async (input, init) => {
      tokenRequests += 1;
      const headers = new Headers(init?.headers);
      observed = {
        url: String(input),
        authorization: headers.get("authorization") ?? "",
        body: JSON.parse(String(init?.body)),
        version: headers.get("x-github-api-version") ?? "",
      };
      return jsonResponse({
        token,
        expires_at: "2099-01-01T00:00:00.000Z",
        repositories: [{ id: binding.repositoryId }],
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      }, 201);
    }) as typeof fetch,
  });

  const access = await broker.issue(binding);
  const capture = observed as unknown as { url: string; authorization: string; body: unknown; version: string };
  const [header, claims] = signingInput.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(payload.iss, "778899");
  assert.equal(payload.exp - payload.iat, 600);
  assert.equal(capture.url, "https://api.github.com/app/installations/123456/access_tokens");
  assert.match(capture.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.deepEqual(capture.body, {
    repository_ids: [991],
    permissions: { contents: "write", pull_requests: "write" },
  });
  assert.equal(capture.version, "2026-03-10");
  assert.equal(access.value, token);
  assert.equal(access.repositoryId, binding.repositoryId);
  assert.equal((await broker.issue(binding)).value, token);
  assert.equal(tokenRequests, 1, "a fresh token must not be minted for every Git blob request");
});

test("source snapshot token broker requests only repository Contents read", async () => {
  let requestBody: unknown;
  const broker = new GitHubAppInstallationTokenBroker({
    appId: "778899",
    permissionMode: "source-read",
    signer: {
      keyId: "vault-github-app-key-v3",
      async signRs256() { return new Uint8Array(256).fill(7); },
    },
    fetch: (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        token,
        expires_at: "2099-01-01T00:00:00.000Z",
        repositories: [{ id: binding.repositoryId }],
        permissions: { contents: "read", metadata: "read" },
      }, 201);
    }) as typeof fetch,
  });
  await broker.issue(binding);
  assert.deepEqual(requestBody, {
    repository_ids: [991],
    permissions: { contents: "read" },
  });
});

test("REST connector maps Git data, Draft PR, GraphQL ready and merge operations without exposing its token", async () => {
  const requests: Array<{ method: string; url: URL; headers: Headers; body: unknown }> = [];
  const pull = (draft: boolean) => ({
    number: 18,
    node_id: "PR_node18",
    html_url: "https://github.com/north-dock-studio/ember-archipelago/pull/18",
    state: "open",
    draft,
    merged: false,
    merge_commit_sha: null,
    head: { ref: "deviludo/project-1/attempt-1", sha: "c".repeat(40) },
    base: { ref: "main", sha: "a".repeat(40) },
  });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url, headers, body });
    if (url.pathname === "/repositories/991") return jsonResponse({
      id: 991,
      node_id: binding.repositoryNodeId,
      owner: { login: binding.owner },
      name: binding.name,
      default_branch: "main",
      archived: false,
      disabled: false,
    });
    if (url.pathname.endsWith("/git/trees")) return jsonResponse({ sha: "1".repeat(40) }, 201);
    if (url.pathname.endsWith("/pulls") && method === "POST") return jsonResponse(pull(true), 201);
    if (url.pathname === "/graphql") return jsonResponse({
      data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_node18", isDraft: false } } },
    });
    if (url.pathname.endsWith("/pulls/18/merge")) return jsonResponse({
      sha: "d".repeat(40), merged: true, message: "Pull Request successfully merged",
    });
    throw new Error(`unexpected fixture request ${method} ${url.pathname}`);
  }) as typeof fetch;
  const connector = new GitHubRestConnector({
    tokens: { async issue() { return { value: token, expiresAt: "2099-01-01T00:00:00.000Z", installationId: "123456", repositoryId: 991 }; } },
    fetch: fetcher,
  });

  assert.equal((await connector.getRepository(binding)).repositoryNodeId, binding.repositoryNodeId);
  const tree = await connector.createTree(binding, {
    baseTreeSha: "b".repeat(40),
    entries: [{ path: "game/main.gd", mode: "100644", type: "blob", sha: "2".repeat(40) }],
  });
  assert.equal(tree.treeSha, "1".repeat(40));
  const created = await connector.createDraftPullRequest(binding, {
    title: "Implement SPEC-008",
    body: "Approved specification",
    headBranch: "deviludo/project-1/attempt-1",
    baseBranch: "main",
  });
  assert.equal(created.draft, true);
  await connector.markPullRequestReady(binding, created.nodeId);
  const merged = await connector.mergePullRequest(binding, {
    number: 18,
    expectedHeadSha: "c".repeat(40),
    commitTitle: "Merge candidate",
    commitMessage: "Evidence passed",
  });
  assert.equal(merged.mergeCommitSha, "d".repeat(40));
  assert.equal(requests.every((request) => request.headers.get("authorization") === `Bearer ${token}`), true);
  assert.equal(requests.every((request) => request.headers.get("x-github-api-version") === "2026-03-10"), true);
  assert.deepEqual(requests.find((request) => request.url.pathname.endsWith("/git/trees"))?.body, {
    base_tree: "b".repeat(40),
    tree: [{ path: "game/main.gd", mode: "100644", type: "blob", sha: "2".repeat(40) }],
  });
  const pullBody = requests.find((request) => request.url.pathname.endsWith("/pulls"))?.body as Record<string, unknown>;
  assert.equal(pullBody.draft, true);
});

test("connector pins api.github.com, disables redirects and strips upstream error bodies", async () => {
  assert.throws(() => new GitHubRestConnector({
    tokens: { async issue() { throw new Error("unused"); } },
    apiBaseUrl: "https://github.example.internal/api/v3/",
  }), /fixed https:\/\/api.github.com/);

  let redirectMode: RequestRedirect | undefined;
  const connector = new GitHubRestConnector({
    tokens: { async issue() { return { value: token, expiresAt: "2099-01-01T00:00:00.000Z", installationId: "123456", repositoryId: 991 }; } },
    fetch: (async (_input, init) => {
      redirectMode = init?.redirect;
      return jsonResponse({ message: `upstream included ${token}` }, 403, { "x-github-request-id": "REQ-123" });
    }) as typeof fetch,
  });
  let message = "";
  await assert.rejects(connector.getRepository(binding), (error: unknown) => {
    message = error instanceof Error ? error.message : String(error);
    return /status 403/.test(message);
  });
  assert.equal(redirectMode, "error");
  assert.doesNotMatch(message, new RegExp(token));
  assert.doesNotMatch(message, /upstream included/);
  assert.match(message, /REQ-123/);
});

test("REST connector derives a deterministic source digest from the complete GitHub tree", async () => {
  const entries = [
    { path: "game/z.gd", mode: "100755", type: "blob", sha: "3".repeat(40) },
    { path: "game", mode: "040000", type: "tree", sha: "4".repeat(40) },
    { path: "game/a.gd", mode: "100644", type: "blob", sha: "2".repeat(40) },
  ];
  const connector = new GitHubRestConnector({
    tokens: { async issue() { return { value: token, expiresAt: "2099-01-01T00:00:00.000Z", installationId: "123456", repositoryId: 991 }; } },
    fetch: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/git/commits/${"c".repeat(40)}`)) {
        return jsonResponse({ sha: "c".repeat(40), tree: { sha: "d".repeat(40) } });
      }
      if (url.pathname.endsWith(`/git/trees/${"d".repeat(40)}`) && url.searchParams.get("recursive") === "1") {
        return jsonResponse({ sha: "d".repeat(40), truncated: false, tree: entries });
      }
      throw new Error(`unexpected tree fixture ${url}`);
    }) as typeof fetch,
  });
  const canonical = [entries[2], entries[0]]
    .map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}\0`).join("");
  const expected = (await import("node:crypto")).createHash("sha256").update(canonical).digest("hex");
  assert.equal(await connector.getSourceDigest(binding, "c".repeat(40)), expected);
  const tree = await connector.getSourceTree(binding, "c".repeat(40));
  assert.equal(tree.sourceDigest, expected);
  assert.deepEqual(tree.entries.map((entry) => entry.path), ["game/a.gd", "game/z.gd"]);
});

test("REST connector verifies exact Git blob SHA, declared size and canonical base64", async () => {
  const content = Buffer.from("extends Node\n");
  const blobSha = createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
  let response: unknown = {
    sha: blobSha,
    size: content.byteLength,
    encoding: "base64",
    content: content.toString("base64"),
  };
  const connector = new GitHubRestConnector({
    tokens: { async issue() { return { value: token, expiresAt: "2099-01-01T00:00:00.000Z", installationId: "123456", repositoryId: 991 }; } },
    fetch: (async () => jsonResponse(response)) as typeof fetch,
  });
  assert.deepEqual(await connector.getBlob(binding, blobSha), content);
  response = { ...response as object, content: Buffer.from("tampered").toString("base64"), size: 8 };
  await assert.rejects(connector.getBlob(binding, blobSha), /integrity/);
});

test("REST connector stops reading a streamed GitHub response at the configured bound", async () => {
  const connector = new GitHubRestConnector({
    tokens: { async issue() { return { value: token, expiresAt: "2099-01-01T00:00:00.000Z", installationId: "123456", repositoryId: 991 }; } },
    fetch: (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  await assert.rejects(connector.getRepository(binding), /size limit/);
});
