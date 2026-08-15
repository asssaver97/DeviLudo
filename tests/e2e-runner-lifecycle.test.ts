import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateGuestInteractionScript } from "../scripts/e2e-interaction-contract.mjs";
import {
  readCliArgument,
  waitForChildWithHardTimeout,
} from "../deploy/assets/e2e-process-lifecycle.mjs";

test("the guest accepts a semantic mouse journey with post-action Oracle evidence", () => {
  const changed = Object.freeze({ source: "STATE", key: "session.started", operator: "CHANGED" });
  const script = {
    events: [
      { type: "checkpoint", id: "start", role: "START", visualMode: "STABLE_REPLAY",
        assertions: [{ source: "SCENE", operator: "EXISTS" }] },
      { type: "click", stepId: "start-game", intent: "START_SESSION", targetId: "new-game",
        button: "LEFT", coversRequirementIds: ["req-new-game"], postconditions: [changed] },
      { type: "checkpoint", id: "complete", role: "COMPLETION", visualMode: "DYNAMIC",
        changeTargetId: "game-viewport", assertions: [{ source: "STATE", key: "session.started", operator: "EQUALS", value: true }] },
    ],
  };
  assert.equal(validateGuestInteractionScript(script, ["req-new-game"], new Set(["req-new-game"])), true);
});

test("an omitted optional regression argument stays empty instead of reading argv[0]", () => {
  const argv = ["/usr/local/bin/node", "/opt/deviludo/local-tart-guest-runner.mjs", "test", "--artifact", "/tmp/build.tar.gz"];
  assert.equal(readCliArgument(argv, "--regression"), "");
  assert.equal(readCliArgument(argv, "--artifact"), "/tmp/build.tar.gz");
  assert.equal(readCliArgument([...argv, "--regression", "--job-id", "job"], "--regression"), "");
});

test("a framed runner exits after returning its result even while the parent stdin remains open", async () => {
  const child = spawn(process.execPath, [new URL("./fixtures/e2e-result-exit-child.mjs", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
  child.stdin.write(`${JSON.stringify({ type: "execute" })}\n`);
  const [code] = await Promise.race([
    once(child, "close"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("result child did not exit")), 1_000)),
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /"type":"result"/);
});

test("the hard deadline terminates a stuck process group", async () => {
  const killProcessGroup = process.platform !== "win32";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: killProcessGroup,
  });
  const pid = child.pid;
  assert.ok(pid);
  const startedAt = Date.now();
  const result = await waitForChildWithHardTimeout(child, {
    timeoutMs: 50,
    terminateGraceMs: 50,
    killProcessGroup,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 1_000);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.throws(() => process.kill(pid, 0));
});

test("the production Guest, relay, executor and node all wire the lifecycle guards", async () => {
  const [guest, tartRelay, executor, node, release] = await Promise.all([
    readFile(new URL("../scripts/executors/godot-window-e2e-guest.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/executors/local-tart-guest-runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/e2e-job-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/e2e-node/src/executor.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);
  assert.match(guest, /validateGuestInteractionScript as validInteractionScript/);
  assert.match(guest, /policyInput\?\.close\(\)/);
  assert.match(tartRelay, /readCliArgument\(process\.argv, name\)/);
  assert.match(tartRelay, /waitForChildWithHardTimeout\(remote/);
  assert.match(executor, /waitForChildWithHardTimeout\(child/);
  assert.match(node, /waitForChildWithHardTimeout\(child/);
  assert.match(release, /E2E_MACOS\.tar\.gz[^\n]+e2e-process-lifecycle\.mjs/);
});
