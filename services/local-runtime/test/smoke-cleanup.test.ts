import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupLocalSmokeStorage } from "../src/smoke-cleanup";

test("smoke storage cleanup removes only exact generated project trees", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "deviludo-smoke-cleanup-"));
  try {
    const runtime = path.join(temporary, "runtime");
    const agent = path.join(temporary, "agent");
    const projectId = "smoke-validation-12345-mrxqiuav";
    await Promise.all([
      mkdir(path.join(runtime, projectId, "run", "evidence"), { recursive: true }),
      mkdir(path.join(runtime, ".scm", projectId, "run"), { recursive: true }),
      mkdir(path.join(agent, ".executions", projectId, "run"), { recursive: true }),
      mkdir(path.join(runtime, "user-project", "run"), { recursive: true }),
    ]);
    await writeFile(path.join(runtime, "user-project", "run", "sentinel"), "keep");

    const receipt = await cleanupLocalSmokeStorage([runtime, agent], [projectId]);
    assert.equal(receipt.removedPaths, 3);
    await assert.rejects(access(path.join(runtime, projectId)));
    await assert.rejects(access(path.join(runtime, ".scm", projectId)));
    await assert.rejects(access(path.join(agent, ".executions", projectId)));
    await access(path.join(runtime, "user-project", "run", "sentinel"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("smoke storage cleanup rejects non-smoke identities before removing anything", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "deviludo-smoke-reject-"));
  try {
    const generated = "smoke-spec-12345-mrxqiuav";
    await mkdir(path.join(temporary, generated), { recursive: true });
    await assert.rejects(cleanupLocalSmokeStorage([temporary], [generated, "user-project"]), /target is invalid/);
    await access(path.join(temporary, generated));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("smoke storage cleanup fails closed on a symlink target", { skip: process.platform === "win32" }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "deviludo-smoke-symlink-"));
  try {
    const root = path.join(temporary, "runtime");
    const outside = path.join(temporary, "outside");
    const valid = "smoke-feedback-12345-mrxqiuav";
    const linked = "smoke-release-gates-12345-mrxqiuav";
    await Promise.all([mkdir(path.join(root, valid), { recursive: true }), mkdir(outside)]);
    await symlink(outside, path.join(root, linked));
    await assert.rejects(cleanupLocalSmokeStorage([root], [valid, linked]), /target is invalid/);
    await access(path.join(root, valid));
    await access(outside);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
