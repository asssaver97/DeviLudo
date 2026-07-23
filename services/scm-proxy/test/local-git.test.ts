import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { LocalGitScmProxy } from "../src/local-git";

const execFileAsync = promisify(execFile);

async function fixture(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `deviludo-scm-${name}-`));
  const storageRoot = path.join(root, "storage");
  const workspaceRoot = path.join(storageRoot, "project-1", "run-1", "workspace");
  await mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "project.godot"), "[application]\nconfig/name=\"SCM test\"\n", "utf8");
  await writeFile(path.join(workspaceRoot, "scripts", "main.gd"), "extends Node\n", "utf8");
  return {
    root,
    storageRoot,
    workspaceRoot,
    binding: {
      projectId: "project-1",
      runId: "run-1",
      attemptId: "attempt-1",
      specRevisionId: "SPEC-001",
      workspaceRoot,
    },
  };
}

test("SCM proxy keeps Git metadata outside the workspace and creates an idempotent candidate", async () => {
  const value = await fixture("candidate");
  const proxy = new LocalGitScmProxy({ storageRoot: value.storageRoot });
  const base = await proxy.prepare(value.binding);
  assert.match(base.baseCommitSha, /^[a-f0-9]{40}$/);
  assert.equal((await proxy.prepare(value.binding)).baseCommitSha, base.baseCommitSha);
  await assert.rejects(readFile(path.join(value.workspaceRoot, ".git"), "utf8"), /ENOENT/);

  await writeFile(path.join(value.workspaceRoot, "scripts", "main.gd"), "extends Node\nfunc _ready():\n\tprint(\"candidate\")\n", "utf8");
  await writeFile(path.join(value.workspaceRoot, "scripts", "save.gd"), "extends RefCounted\n", "utf8");
  const candidate = await proxy.finalize({
    ...value.binding,
    expectedBaseCommitSha: base.baseCommitSha,
    candidateBranch: "deviludo/run-1/attempt-1",
    commitMessage: "agent: implement SPEC-001",
  });
  assert.match(candidate.commitSha, /^[a-f0-9]{40}$/);
  assert.match(candidate.sourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(candidate.changedFiles, ["scripts/main.gd", "scripts/save.gd"]);
  assert.equal(Object.isFrozen(candidate.changedFiles), true);
  assert.deepEqual(await proxy.finalize({
    ...value.binding,
    expectedBaseCommitSha: base.baseCommitSha,
    candidateBranch: "deviludo/run-1/attempt-1",
    commitMessage: "agent: implement SPEC-001",
  }), candidate);

  const merged = await proxy.merge({
    ...value.binding,
    expectedCandidateCommitSha: candidate.commitSha,
    expectedSourceDigest: candidate.sourceDigest,
  });
  assert.equal(merged.mainCommitSha, candidate.commitSha);
  assert.equal(merged.sourceDigest, candidate.sourceDigest);
  assert.equal(merged.branch, "main");
  assert.deepEqual(await proxy.merge({
    ...value.binding,
    expectedCandidateCommitSha: candidate.commitSha,
    expectedSourceDigest: candidate.sourceDigest,
  }), merged);

  const gitDirectory = path.join(value.storageRoot, ".scm", "project-1", "run-1", "attempt-1", "repository", ".git");
  await execFileAsync("/usr/bin/git", [`--git-dir=${gitDirectory}`, "cat-file", "-e", `${candidate.commitSha}^{commit}`]);
});

test("SCM proxy rejects no-op runs, lock drift and unsafe branch names", async () => {
  const value = await fixture("locks");
  const proxy = new LocalGitScmProxy({ storageRoot: value.storageRoot });
  const base = await proxy.prepare(value.binding);
  const common = { ...value.binding, expectedBaseCommitSha: base.baseCommitSha, commitMessage: "agent: no-op" };
  await assert.rejects(proxy.finalize({ ...common, candidateBranch: "deviludo/no-op" }), /without a candidate file change/);
  await assert.rejects(proxy.finalize({ ...common, expectedBaseCommitSha: "f".repeat(40), candidateBranch: "deviludo/drift" }), /base commit lock/);
  await assert.rejects(proxy.finalize({ ...common, candidateBranch: "deviludo/../escape" }), /branch is invalid/);
});

test("SCM merge rejects candidate evidence drift before moving main", async () => {
  const value = await fixture("merge-drift");
  const proxy = new LocalGitScmProxy({ storageRoot: value.storageRoot });
  const base = await proxy.prepare(value.binding);
  await writeFile(path.join(value.workspaceRoot, "scripts", "main.gd"), "extends Node\nfunc _ready():\n\tprint(\"candidate\")\n", "utf8");
  const candidate = await proxy.finalize({
    ...value.binding,
    expectedBaseCommitSha: base.baseCommitSha,
    candidateBranch: "deviludo/run-1/attempt-1",
    commitMessage: "agent: implement SPEC-001",
  });
  await assert.rejects(proxy.merge({
    ...value.binding,
    expectedCandidateCommitSha: "f".repeat(40),
    expectedSourceDigest: candidate.sourceDigest,
  }), /accepted evidence/);
  await assert.rejects(proxy.merge({
    ...value.binding,
    expectedCandidateCommitSha: candidate.commitSha,
    expectedSourceDigest: "e".repeat(64),
  }), /accepted evidence/);
});

test("SCM proxy rejects symlinks, nested Git metadata and workspaces outside its storage root", async () => {
  const symlinked = await fixture("symlink");
  await symlink("project.godot", path.join(symlinked.workspaceRoot, "linked.godot"));
  await assert.rejects(new LocalGitScmProxy({ storageRoot: symlinked.storageRoot }).prepare(symlinked.binding), /symlinks are forbidden/);

  const metadata = await fixture("metadata");
  await mkdir(path.join(metadata.workspaceRoot, "nested", ".git"), { recursive: true });
  await assert.rejects(new LocalGitScmProxy({ storageRoot: metadata.storageRoot }).prepare(metadata.binding), /must not contain Git metadata/);

  const outside = await fixture("outside");
  const outsideWorkspace = path.join(outside.root, "outside-workspace");
  await mkdir(outsideWorkspace);
  await assert.rejects(new LocalGitScmProxy({ storageRoot: outside.storageRoot }).prepare({ ...outside.binding, workspaceRoot: outsideWorkspace }), /child of SCM storageRoot/);
});
