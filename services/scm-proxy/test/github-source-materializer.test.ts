import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitHubRepositoryBinding, GitHubSourceTreeConnector, GitHubSourceTreeEntry } from "../src/github-contracts";
import { GitHubSourceMaterializer } from "../src/github-source-materializer";

const binding: GitHubRepositoryBinding = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  installationId: "123456",
  repositoryId: 991,
  repositoryNodeId: "R_repo991",
  owner: "north-dock-studio",
  name: "ember-archipelago",
  defaultBranch: "main",
};
const commitSha = "a".repeat(40);
const sourceDigest = "b".repeat(64);

test("GitHub source materializer writes exact verified blobs without Git metadata", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deviludo-github-source-")));
  try {
    const fixture = materializerFixture();
    const destinationPath = join(root, "snapshot");
    assert.deepEqual(await fixture.materializer.materialize({ binding, commitSha, expectedSourceDigest: sourceDigest, destinationPath }), {
      sourceDigest,
    });
    assert.equal((await readFile(join(destinationPath, "project.godot"), "utf8")).includes("config_version"), true);
    assert.equal((await stat(join(destinationPath, "scripts", "main.gd"))).isFile(), true);
    assert.deepEqual(fixture.blobCalls.sort(), fixture.entries.map((entry) => entry.sha).sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("GitHub source materializer rejects source drift, symlinks, submodules and path escapes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deviludo-github-source-")));
  try {
    await assert.rejects(materializerFixture({ sourceDigest: "f".repeat(64) }).materializer.materialize({
      binding, commitSha, expectedSourceDigest: sourceDigest, destinationPath: join(root, "digest"),
    }), /tree receipt/);
    for (const entry of [
      treeEntry("link", "120000", "blob", "c"),
      treeEntry("vendor", "160000", "commit", "d"),
      treeEntry(".git/config", "100644", "blob", "e"),
      treeEntry("../escape", "100644", "blob", "f"),
    ] as const) {
      await assert.rejects(materializerFixture({ entries: [entry] }).materializer.materialize({
        binding,
        commitSha,
        expectedSourceDigest: sourceDigest,
        destinationPath: join(root, `rejected-${entry.sha[0]}`),
      }), /tree entry/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function materializerFixture(options: {
  readonly sourceDigest?: string;
  readonly entries?: readonly GitHubSourceTreeEntry[];
} = {}) {
  const blobs = new Map<string, Buffer>();
  const entries = options.entries ?? [
    blobEntry("project.godot", Buffer.from('config_version=5\n[application]\nconfig/name="Fixture"\n'), "1"),
    blobEntry("scripts/main.gd", Buffer.from("extends Node\n"), "2"),
  ];
  for (const entry of entries) blobs.set(entry.sha, Buffer.from(`fixture:${entry.path}`));
  if (!options.entries) {
    blobs.set(entries[0]!.sha, Buffer.from('config_version=5\n[application]\nconfig/name="Fixture"\n'));
    blobs.set(entries[1]!.sha, Buffer.from("extends Node\n"));
  }
  const blobCalls: string[] = [];
  const connector: GitHubSourceTreeConnector = {
    async getSourceTree() {
      return {
        commitSha,
        treeSha: "9".repeat(40),
        sourceDigest: options.sourceDigest ?? sourceDigest,
        entries,
      };
    },
    async getBlob(_binding, sha) {
      blobCalls.push(sha);
      const value = blobs.get(sha);
      if (!value) throw new Error("missing blob");
      return value;
    },
  };
  return { materializer: new GitHubSourceMaterializer(connector), blobCalls, entries };
}

function blobEntry(path: string, content: Buffer, marker: string): GitHubSourceTreeEntry {
  const sha = createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
  void marker;
  return { path, mode: "100644", type: "blob", sha };
}

function treeEntry(
  path: string,
  mode: GitHubSourceTreeEntry["mode"],
  type: GitHubSourceTreeEntry["type"],
  marker: string,
): GitHubSourceTreeEntry {
  return { path, mode, type, sha: marker.repeat(40) };
}
