import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  localDeploymentOwnerMatches,
  parseSupervisedChildArguments,
} from "../scripts/local/supervised-child.mjs";

const deploymentId = "a".repeat(32);

test("local child supervisor accepts only one absolute owner and fixed parent identity", () => {
  const ownerFile = resolve(".deviludo/local-deployment.json");
  assert.deepEqual(parseSupervisedChildArguments([
    "--parent-pid", "123",
    "--owner-file", ownerFile,
    "--deployment-id", deploymentId,
    "--", "--import", "tsx", "/tmp/entry.ts",
  ]), {
    parentPid: 123,
    ownerFile,
    deploymentId,
    childArguments: ["--import", "tsx", "/tmp/entry.ts"],
  });
  assert.throws(() => parseSupervisedChildArguments([
    "--parent-pid", "123",
    "--owner-file", "relative.json",
    "--deployment-id", deploymentId,
    "--", "-e", "setInterval(() => {}, 1000)",
  ]), /configuration is invalid/);
  assert.throws(() => parseSupervisedChildArguments([
    "--parent-pid", "123",
    "--owner-file", ownerFile,
    "--deployment-id", deploymentId,
    "--extra", "value",
    "--", "-e", "setInterval(() => {}, 1000)",
  ]), /configuration is invalid/);
});

test("a supervised local child exits when its launcher's deployment ownership changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-local-supervisor-"));
  const ownerFile = join(directory, "owner.json");
  const supervisorEntry = resolve("scripts/local/supervised-child.mjs");
  const owner = {
    schema: "deviludo.local-sidecar-session.v1",
    deploymentId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  let supervisor;
  try {
    await writeFile(ownerFile, `${JSON.stringify({ ...owner, apiKey: "must-not-be-admitted" })}\n`, { mode: 0o600 });
    assert.equal(localDeploymentOwnerMatches(ownerFile, process.pid, deploymentId), false);
    await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    assert.equal(localDeploymentOwnerMatches(ownerFile, process.pid, deploymentId), true);
    if (process.platform !== "win32") {
      await chmod(ownerFile, 0o644);
      assert.equal(localDeploymentOwnerMatches(ownerFile, process.pid, deploymentId), false);
      await chmod(ownerFile, 0o600);
    }
    supervisor = spawn(process.execPath, [
      supervisorEntry,
      "--parent-pid", String(process.pid),
      "--owner-file", ownerFile,
      "--deployment-id", deploymentId,
      "--", "-e", "setInterval(() => {}, 1000)",
    ], { stdio: "ignore" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    assert.equal(supervisor.exitCode, null);
    await writeFile(ownerFile, `${JSON.stringify({ ...owner, deploymentId: "b".repeat(32) })}\n`, { mode: 0o600 });
    let timeout;
    const [code, signal] = await Promise.race([
      once(supervisor, "exit"),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("supervisor did not stop")), 4_000); }),
    ]).finally(() => clearTimeout(timeout));
    assert.equal(code, 1);
    assert.equal(signal, null);
  } finally {
    if (supervisor?.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
