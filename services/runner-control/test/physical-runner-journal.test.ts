import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerEvent } from "../../../lib/domain/e2e";
import type { PlatformEvidenceManifest } from "../src/contracts";
import { sha256Canonical } from "../src/canonical";
import { FilePhysicalRunnerJournal } from "../src/physical-runner-journal";
import type { PhysicalRunnerJournalRecord } from "../src/physical-runner";

const attemptId = "11111111-1111-4111-8111-111111111111";
const sha = (value: string) => value.repeat(64);

function event(overrides: Partial<RunnerEvent> = {}): RunnerEvent {
  return {
    attemptId,
    runnerId: "runner-linux-1",
    fencingToken: 7,
    seqNo: 1,
    commitSha: "a".repeat(40),
    sourceDigest: sha("1"),
    platform: "linux",
    type: "STARTED",
    status: "RUNNING",
    artifactDigest: null,
    occurredAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function evidence(): PlatformEvidenceManifest {
  const core = {
    schemaVersion: "deviludo.platform-evidence.v1" as const,
    attemptId,
    fencingToken: 7,
    commitSha: "a".repeat(40),
    sourceDigest: sha("1"),
    specRevisionId: "22222222-2222-4222-8222-222222222222",
    specDigest: sha("2"),
    testPlanDigest: sha("3"),
    targetMatrix: ["linux"] as const,
    godotTestKitDigest: sha("4"),
    exportTemplatesDigest: sha("5"),
    platform: "linux" as const,
    runnerId: "runner-linux-1",
    runnerCapabilityDigest: sha("6"),
    exportDigest: sha("7"),
    logsDigest: sha("8"),
    junitDigest: sha("9"),
    inputTimelineDigest: sha("a"),
    screenshotManifestDigest: sha("b"),
    videoManifestDigest: sha("c"),
    status: "PASSED" as const,
    createdAt: "2030-01-01T00:00:01.000Z",
  };
  return { ...core, manifestDigest: sha256Canonical(core) };
}

function record(stage: "STARTED" | "EVIDENCE" | "COMPLETED" = "STARTED"): PhysicalRunnerJournalRecord {
  const manifest = stage === "STARTED" ? null : evidence();
  const completed = stage === "COMPLETED";
  return {
    schemaVersion: "deviludo.physical-runner-journal.v1",
    attemptId,
    fencingToken: 7,
    jobDigest: sha("d"),
    startedEvent: event(),
    evidenceManifest: manifest,
    completionEvent: completed ? event({
      seqNo: 2,
      type: "PLATFORM_COMPLETED",
      status: "PASSED",
      artifactDigest: manifest?.manifestDigest ?? null,
      occurredAt: "2030-01-01T00:00:02.000Z",
    }) : null,
    completed,
  };
}

test("file journal atomically persists and reloads a monotonic machine-authenticated record", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-physical-journal-"));
  try {
    const journal = new FilePhysicalRunnerJournal({ root, hmacKey: Buffer.alloc(32, 7) });
    await journal.save(record());
    await journal.save(record("EVIDENCE"));
    await journal.save(record("COMPLETED"));
    const loaded = await journal.load(attemptId, 7);
    assert.equal(loaded?.completed, true);
    assert.equal(loaded?.evidenceManifest?.manifestDigest, evidence().manifestDigest);
    assert.equal(Object.isFrozen(loaded), true);
    const files = await readdir(root);
    assert.deepEqual(files, [`${attemptId}.7.journal.json`]);
    if (process.platform !== "win32") {
      assert.equal((await stat(root)).mode & 0o077, 0);
      assert.equal((await stat(join(root, files[0]!))).mode & 0o077, 0);
    }
    await assert.rejects(journal.save(record()), /not monotonic/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file journal detects record edits and a different machine key", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-physical-journal-"));
  try {
    const key = Buffer.alloc(32, 8);
    const journal = new FilePhysicalRunnerJournal({ root, hmacKey: key });
    await journal.save(record("EVIDENCE"));
    const file = join(root, `${attemptId}.7.journal.json`);

    const otherMachine = new FilePhysicalRunnerJournal({ root, hmacKey: Buffer.alloc(32, 9) });
    await assert.rejects(otherMachine.load(attemptId, 7), /envelope is invalid/);

    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      record: { startedEvent: { occurredAt: string } };
    };
    parsed.record.startedEvent.occurredAt = "2030-01-01T00:00:09.000Z";
    await writeFile(file, JSON.stringify(parsed), "utf8");
    await assert.rejects(journal.load(attemptId, 7), /envelope is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file journal rejects relative roots, weak keys and unsafe record identities", async () => {
  assert.throws(() => new FilePhysicalRunnerJournal({ root: "relative", hmacKey: Buffer.alloc(32) }), /root is invalid/);
  assert.throws(() => new FilePhysicalRunnerJournal({ root: tmpdir(), hmacKey: Buffer.alloc(16) }), /HMAC key is invalid/);
  const root = await mkdtemp(join(tmpdir(), "deviludo-physical-journal-"));
  try {
    const journal = new FilePhysicalRunnerJournal({ root, hmacKey: Buffer.alloc(32, 1) });
    await assert.rejects(journal.load("../attempt", 7), /envelope is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
