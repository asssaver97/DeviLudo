import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { commitVerifiedGitDirectory } from "../scripts/local-git-commit.mjs";

const execute = promisify(execFile);
const workflowId = "11111111-1111-4111-8111-111111111111";

test("E2E-approved local Git changes are committed once without staging excluded secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-auto-commit-"));
  try {
    await git(directory, ["init", "--initial-branch=main"]);
    await writeFile(join(directory, "project.godot"), "[application]\n");
    await writeFile(join(directory, "README.md"), "before\n");
    await git(directory, ["add", "project.godot", "README.md"]);
    await git(directory, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);

    await writeFile(join(directory, "README.md"), "after\n");
    await mkdir(join(directory, "scripts"));
    await writeFile(join(directory, "scripts", "main.gd"), "extends Node\n");
    await writeFile(join(directory, ".env"), "TOKEN=must-not-be-committed\n");
    let verificationCount = 0;
    const commit = await commitVerifiedGitDirectory({
      directory,
      workflowId,
      iterationNumber: 2,
      sourcePaths: ["README.md", "project.godot", "scripts/main.gd"],
      includePath: (path: string) => path !== ".env",
      verifySource: async () => { verificationCount += 1; },
    });

    assert.equal(commit.outcome, "COMMITTED");
    assert.match(commit.commitHash ?? "", /^[0-9a-f]{40}$/);
    assert.equal(commit.branch, "main");
    assert.equal(verificationCount, 2);
    assert.match((await git(directory, ["log", "-1", "--format=%B"])).stdout, /deviludo: complete iteration 2/);
    assert.match((await git(directory, ["log", "-1", "--format=%B"])).stdout, new RegExp(`DeviLudo-Workflow: ${workflowId}`));
    assert.deepEqual((await git(directory, ["show", "--name-only", "--format="])).stdout.trim().split("\n").sort(), [
      "README.md",
      "scripts/main.gd",
    ]);
    assert.match((await git(directory, ["status", "--short"])).stdout, /\?\? \.env/);

    const repeated = await commitVerifiedGitDirectory({
      directory,
      workflowId,
      iterationNumber: 2,
      sourcePaths: ["README.md", "project.godot", "scripts/main.gd"],
      includePath: (path: string) => path !== ".env",
      verifySource: async () => undefined,
    });
    assert.equal(repeated.outcome, "NO_CHANGES");
    assert.equal(repeated.commitHash, commit.commitHash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic commit refuses a user-owned staged index and leaves it intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-auto-commit-index-"));
  try {
    await git(directory, ["init", "--initial-branch=main"]);
    await writeFile(join(directory, "project.godot"), "[application]\n");
    await git(directory, ["add", "project.godot"]);
    await git(directory, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
    await writeFile(join(directory, "project.godot"), "[application]\nconfig/name=Changed\n");
    await git(directory, ["add", "project.godot"]);

    await assert.rejects(
      commitVerifiedGitDirectory({
        directory,
        workflowId,
        iterationNumber: 1,
        sourcePaths: ["project.godot"],
        includePath: () => true,
        verifySource: async () => undefined,
      }),
      (error: Error & { code?: string }) => error.code === "GIT_INDEX_NOT_CLEAN",
    );
    assert.match((await git(directory, ["diff", "--cached", "--name-only"])).stdout, /project\.godot/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic commit creates the first commit in an otherwise empty Git repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-auto-commit-unborn-"));
  try {
    await git(directory, ["init", "--initial-branch=main"]);
    await writeFile(join(directory, "project.godot"), "[application]\n");
    const commit = await commitVerifiedGitDirectory({
      directory,
      workflowId,
      iterationNumber: 1,
      sourcePaths: ["project.godot"],
      includePath: () => true,
      verifySource: async () => undefined,
    });
    assert.equal(commit.outcome, "COMMITTED");
    assert.equal((await git(directory, ["rev-list", "--count", "HEAD"])).stdout.trim(), "1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function git(directory: string, args: readonly string[]) {
  return execute("git", ["-C", directory, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
}
