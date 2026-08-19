import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentGuidanceArrivedDuringRun,
  discardAgentProjectTurnSnapshot,
  readAgentGuidanceSnapshot,
  restoreAgentProjectTurn,
  snapshotAgentProjectTurn,
  waitForAgentGuidanceQuiescence,
} from "../services/sandbox-executor/agent-guidance-contract.mjs";

test("detects only guidance appended during a model run", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-guidance-"));
  const path = join(root, "guidance.ndjson");
  await writeFile(path, `${JSON.stringify({ content: "keep the existing route", receivedAt: "2026-08-16T00:00:00Z" })}\n`);
  const before = await readAgentGuidanceSnapshot(path);
  await writeFile(path, [
    JSON.stringify({ content: "keep the existing route", receivedAt: "2026-08-16T00:00:00Z" }),
    JSON.stringify({ content: "limit the change to the current failure", receivedAt: "2026-08-16T00:00:01Z" }),
    "",
  ].join("\n"));
  const after = await readAgentGuidanceSnapshot(path);
  assert.deepEqual(agentGuidanceArrivedDuringRun(before, after), ["limit the change to the current failure"]);
});

test("does not force a replay when the guidance stream is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-guidance-"));
  const path = join(root, "guidance.ndjson");
  await writeFile(path, `${JSON.stringify({ content: "one bounded change" })}\n`);
  const snapshot = await readAgentGuidanceSnapshot(path);
  assert.deepEqual(agentGuidanceArrivedDuringRun(snapshot, snapshot), []);
});

test("holds the completion gate until late live guidance becomes quiescent", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-guidance-"));
  const path = join(root, "guidance.ndjson");
  await writeFile(path, "");
  const before = await readAgentGuidanceSnapshot(path);
  // Start the gate first, then append while it is sleeping before its initial
  // poll. This preserves the race being tested without relying on a timer that
  // can fire after the whole quiescence window on a loaded CI runner.
  const settling = waitForAgentGuidanceQuiescence(before, path, { quiescenceMs: 30, pollMs: 5 });
  await writeFile(path, `${JSON.stringify({ content: "replace the just-finished fallback" })}\n`);
  const settled = await settling;
  assert.deepEqual(agentGuidanceArrivedDuringRun(before, settled), ["replace the just-finished fallback"]);
});

test("treats a replaced guidance stream conservatively", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-guidance-"));
  const path = join(root, "guidance.ndjson");
  await writeFile(path, `${JSON.stringify({ content: "old scope that is intentionally much longer" })}\n`);
  const before = await readAgentGuidanceSnapshot(path);
  await writeFile(path, `${JSON.stringify({ content: "new scope" })}\n`);
  const after = await readAgentGuidanceSnapshot(path);
  assert.deepEqual(agentGuidanceArrivedDuringRun(before, after), ["new scope"]);
});

test("restores the exact pre-call project when live guidance supersedes a model turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-guidance-worktree-"));
  const project = join(root, "project");
  const snapshot = join(root, "turn-snapshot");
  await mkdir(join(project, "scripts"), { recursive: true });
  await writeFile(join(project, "scripts", "main.gd"), "original\n");
  await writeFile(join(project, "keep.txt"), "keep\n");
  await symlink("keep.txt", join(project, "keep-link"));

  await snapshotAgentProjectTurn(project, snapshot);
  await writeFile(join(project, "scripts", "main.gd"), "unaccepted model edit\n");
  await writeFile(join(project, "extra.txt"), "out of scope\n");

  await restoreAgentProjectTurn(project, snapshot);
  assert.equal(await readFile(join(project, "scripts", "main.gd"), "utf8"), "original\n");
  assert.equal(await readFile(join(project, "keep-link"), "utf8"), "keep\n");
  await assert.rejects(readFile(join(project, "extra.txt"), "utf8"), /ENOENT/);
  await discardAgentProjectTurnSnapshot(snapshot);
  await assert.rejects(readFile(join(snapshot, "keep.txt"), "utf8"), /ENOENT/);
});

test("rejects overlapping project and snapshot roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-guidance-worktree-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await assert.rejects(
    snapshotAgentProjectTurn(project, join(project, ".snapshot")),
    /must be separate safe directories/,
  );
});
