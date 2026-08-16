import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export async function readAgentGuidanceSnapshot(path = "/run/deviludo/guidance.ndjson") {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = raw.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try {
      const value = JSON.parse(line);
      return typeof value?.content === "string" && value.content.trim()
        ? [{ content: value.content.trim(), receivedAt: typeof value.receivedAt === "string" ? value.receivedAt : null }]
        : [];
    } catch {
      return [];
    }
  });
  return Object.freeze({
    digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    byteLength: Buffer.byteLength(raw),
    entries: Object.freeze(entries),
  });
}

export function agentGuidanceArrivedDuringRun(before, after) {
  if (!before || !after || before.digest === after.digest) return [];
  if (after.byteLength < before.byteLength || after.entries.length < before.entries.length) {
    return after.entries.map(entry => entry.content);
  }
  return after.entries.slice(before.entries.length).map(entry => entry.content);
}

export async function waitForAgentGuidanceQuiescence(
  initial,
  path = "/run/deviludo/guidance.ndjson",
  { quiescenceMs = 1_500, pollMs = 100 } = {},
) {
  if (!initial || typeof initial !== "object") throw new Error("Initial Agent guidance snapshot is required");
  if (!Number.isFinite(quiescenceMs) || quiescenceMs < 0 || quiescenceMs > 10_000
    || !Number.isFinite(pollMs) || pollMs < 5 || pollMs > 1_000) {
    throw new Error("Agent guidance quiescence options are invalid");
  }
  let latest = initial;
  let unchangedSince = Date.now();
  while (Date.now() - unchangedSince < quiescenceMs) {
    await sleep(Math.min(pollMs, Math.max(1, quiescenceMs - (Date.now() - unchangedSince))));
    const next = await readAgentGuidanceSnapshot(path);
    if (next.digest !== latest.digest || next.byteLength !== latest.byteLength
      || next.entries.length !== latest.entries.length) {
      latest = next;
      unchangedSince = Date.now();
    }
  }
  return latest;
}

export async function snapshotAgentProjectTurn(projectRoot, snapshotRoot) {
  const roots = separatedRoots(projectRoot, snapshotRoot);
  await assertSafeDirectory(roots.project, "Agent project root");
  await rm(roots.snapshot, { recursive: true, force: true });
  await mkdir(dirname(roots.snapshot), { recursive: true });
  await cp(roots.project, roots.snapshot, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

export async function restoreAgentProjectTurn(projectRoot, snapshotRoot) {
  const roots = separatedRoots(projectRoot, snapshotRoot);
  await assertSafeDirectory(roots.snapshot, "Agent turn snapshot");
  await rm(roots.project, { recursive: true, force: true });
  await mkdir(dirname(roots.project), { recursive: true });
  await cp(roots.snapshot, roots.project, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

export async function discardAgentProjectTurnSnapshot(snapshotRoot) {
  const snapshot = resolve(snapshotRoot);
  if (snapshot === "/" || snapshot.length < 8) throw new Error("Agent turn snapshot path is unsafe");
  await rm(snapshot, { recursive: true, force: true });
}

function separatedRoots(projectRoot, snapshotRoot) {
  const project = resolve(projectRoot);
  const snapshot = resolve(snapshotRoot);
  if (project === "/" || snapshot === "/" || project === snapshot
    || project.startsWith(`${snapshot}${sep}`) || snapshot.startsWith(`${project}${sep}`)) {
    throw new Error("Agent project and turn snapshot roots must be separate safe directories");
  }
  return { project, snapshot };
}

async function assertSafeDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a safe directory`);
}
