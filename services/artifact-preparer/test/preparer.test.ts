import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../../runner-control/src/canonical";
import type { RunnerExecutionLock } from "../../runner-control/src/execution-lock";
import {
  SourceExecutionPreparer,
  type AuthoritativeSourceSnapshotPort,
  type FrozenTestPlanPort,
  type PreparedInputObjectPort,
  type RunnerExecutionLockPort,
} from "../src/preparer";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const executionLockId = "44444444-4444-4444-8444-444444444444";
const sha = (value: string) => value.repeat(64);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

test("source execution preparer publishes exact inputs before one immutable execution lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-artifact-preparer-"));
  try {
    const fixture = createFixture(root);
    const first = await fixture.preparer.prepare(fixture.request);
    assert.equal(first.created, true);
    assert.equal(first.sourceDigest, sha("a"));
    assert.match(first.sourceObjectKey, new RegExp(`^tenants/${tenantId}/projects/${projectId}/sources/[a-f0-9]{64}\\.tar\\.zst$`));
    assert.equal(first.testPlanObjectKey, `tenants/${tenantId}/projects/${projectId}/test-plans/${fixture.request.testPlanDigest}.json`);
    assert.equal(fixture.objects.size, 2);
    assert.equal(fixture.locks.size, 1);
    const persisted = [...fixture.locks.values()][0]!;
    assert.equal(persisted.payload.execution.kind, "SOURCE_ARTIFACT");
    if (persisted.payload.execution.kind === "SOURCE_ARTIFACT") {
      assert.equal(persisted.payload.execution.artifactDigest, first.sourceArtifactDigest);
    }
    assert.deepEqual(persisted.payload.targetMatrix, ["linux", "macos"]);

    const replay = await fixture.preparer.prepare(fixture.request);
    assert.deepEqual(replay, { ...first, created: false });
    assert.equal(fixture.objects.size, 2);
    assert.equal(fixture.locks.size, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source execution preparer rejects plan, source and receipt drift before persisting a lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-artifact-preparer-"));
  try {
    const invalidPlan = createFixture(join(root, "plan"), { corruptPlan: true });
    await assert.rejects(invalidPlan.preparer.prepare(invalidPlan.request), /test plan digest/);
    assert.equal(invalidPlan.locks.size, 0);

    const invalidSource = createFixture(join(root, "source"), { invalidSourceDigest: true });
    await assert.rejects(invalidSource.preparer.prepare(invalidSource.request), /source receipt/);
    assert.equal(invalidSource.locks.size, 0);

    const mismatchedSource = createFixture(join(root, "source-mismatch"), { mismatchedSourceDigest: true });
    await assert.rejects(mismatchedSource.preparer.prepare(mismatchedSource.request), /source receipt/);
    assert.equal(mismatchedSource.locks.size, 0);

    const drift = createFixture(join(root, "receipt"), { driftReceipt: true });
    await assert.rejects(drift.preparer.prepare(drift.request), /object receipt/);
    assert.equal(drift.locks.size, 0);

    const malformed = createFixture(join(root, "request"));
    await assert.rejects(malformed.preparer.prepare({ ...malformed.request, futureField: true }), /request fields/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function createFixture(root: string, options: {
  readonly corruptPlan?: boolean;
  readonly invalidSourceDigest?: boolean;
  readonly mismatchedSourceDigest?: boolean;
  readonly driftReceipt?: boolean;
} = {}) {
  const plan = testPlan();
  const planBytes = Buffer.from(canonicalJson(plan), "utf8");
  const toolchain = {
    schemaVersion: "deviludo.runner-toolchain.v1" as const,
    requiredGodotVersion: "4.6.2-stable",
    godotTestKitDigest: sha("3"),
    exportTemplates: { linux: sha("4"), macos: sha("5") },
    buildManifestDigest: sha("6"),
    sbomDigest: sha("7"),
    vulnerabilityScanDigest: sha("8"),
    assetLicenseLedgerDigest: sha("9"),
  };
  const request = {
    schemaVersion: "deviludo.source-execution-preparation.v1" as const,
    tenantId,
    projectId,
    runId,
    lockKey: sha("1"),
    mode: "CANDIDATE" as const,
    commitSha: "a".repeat(40),
    sourceDigest: sha("a"),
    specRevisionId: "55555555-5555-4555-8555-555555555555",
    specDigest: sha("2"),
    testPlanDigest: digest(planBytes),
    runnerToolchainRevisionId: "66666666-6666-4666-8666-666666666666",
    runnerToolchainDigest: digest(Buffer.from(canonicalJson(toolchain), "utf8")),
    targetMatrix: ["linux", "macos"] as const,
    toolchain,
  };
  const sources: AuthoritativeSourceSnapshotPort = {
    async materialize(input) {
      await mkdir(join(input.destinationPath, "scripts"), { recursive: true });
      await Promise.all([
        writeFile(join(input.destinationPath, "project.godot"), "config_version=5\n[application]\nconfig/name=\"Fixture\"\n"),
        writeFile(join(input.destinationPath, "scripts", "main.gd"), "extends Node\n"),
      ]);
      return { sourceDigest: options.invalidSourceDigest ? "invalid" : options.mismatchedSourceDigest ? sha("f") : sha("a") };
    },
  };
  const plans: FrozenTestPlanPort = {
    async read() { return options.corruptPlan ? Buffer.concat([planBytes, Buffer.from("\n")]) : planBytes; },
  };
  const objects = new Map<string, { digest: string; bytes: Buffer }>();
  const publish = (objectKey: string, artifactDigest: string, bytes: Buffer) => {
    assert.equal(digest(bytes), artifactDigest);
    const existing = objects.get(objectKey);
    if (existing) assert.deepEqual(existing, { digest: artifactDigest, bytes });
    else objects.set(objectKey, { digest: artifactDigest, bytes });
    return {
      objectKey: options.driftReceipt ? `${objectKey}-drift` : objectKey,
      artifactDigest,
      sizeBytes: bytes.byteLength,
    };
  };
  const objectPort: PreparedInputObjectPort = {
    async publishFile(input) { return publish(input.objectKey, input.artifactDigest, await readFile(input.path)); },
  };
  const locks = new Map<string, { payload: RunnerExecutionLock; digest: string }>();
  const lockPort: RunnerExecutionLockPort = {
    async persist(input) {
      const existing = locks.get(input.lockKey);
      if (existing) {
        assert.equal(canonicalJson(existing.payload), canonicalJson(input.payload));
        assert.equal(existing.digest, input.payloadDigest);
        return { executionLockId, payloadDigest: input.payloadDigest, created: false };
      }
      locks.set(input.lockKey, { payload: input.payload, digest: input.payloadDigest });
      return { executionLockId, payloadDigest: input.payloadDigest, created: true };
    },
  };
  return {
    preparer: new SourceExecutionPreparer({
      sources,
      plans,
      objects: objectPort,
      locks: lockPort,
      workRoot: join(root, "work"),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    }),
    request,
    objects,
    locks,
  };
}

function testPlan() {
  const outcomes = ["CORE_LOOP", "WIN", "LOSE", "PAUSE_SETTINGS", "SAVE_LOAD"] as const;
  return {
    schemaVersion: "deviludo.godot-test-plan.v2",
    engine: "godot-4",
    targetMatrix: ["linux", "macos"],
    requiredGodotVersion: "4.6.2-stable",
    timeouts: { importSeconds: 60, bootSeconds: 60, suiteSeconds: 300, exportSeconds: 600 },
    performance: { warmupFrames: 30, sampleFrames: 120, maximumAverageFrameMs: 16, maximumP95FrameMs: 32 },
    scenarios: outcomes.map((outcome, index) => ({
      id: `${String(index + 1).padStart(2, "0")}-${outcome.toLowerCase().replaceAll("_", "-")}`,
      outcome,
      steps: [
        { kind: "WAIT_FRAMES", frames: 2 },
        ...(index < 2 ? [{ kind: "SCREENSHOT", name: index === 0 ? "start" : "win" }] : []),
      ],
    })),
  };
}
