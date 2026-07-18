import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { canonicalJson, sha256Canonical } from "../../runner-control/src/canonical";
import type { RunnerJobPayload, SignedRunnerJob } from "../../runner-control/src/contracts";
import type { TestKitArtifactKind } from "../../runner-control/src/testkit-artifact-client";
import { GodotTestKitController, type GodotTestKitArtifactPort } from "../src/controller";
import type { GodotHarnessResult, GodotTestKitRunRequest, GodotTestPlan } from "../src/contracts";
import type { GodotPlatformDriver } from "../src/godot-driver";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const sha = (value: string) => value.repeat(64);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

test("fixed Controller downloads frozen inputs, produces six artifacts and replays without rerunning Godot", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-godot-controller-"));
  try {
    const fixture = await controllerFixture(root);
    const first = await fixture.controller.run(fixture.request, fixture.runRoot);
    assert.equal(first.status, "PASSED");
    assert.equal(fixture.driverCalls.count, 1);
    assert.deepEqual([...new Set(fixture.uploads.map((upload) => upload.kind))].sort(), [
      "input-timeline", "junit", "logs", "production-export", "screenshot-manifest", "video-manifest",
    ]);
    for (const value of Object.values(first).filter((item) => typeof item === "string" && item.length === 64)) assert.match(value, /^[a-f0-9]{64}$/);

    const replay = await fixture.controller.run(fixture.request, fixture.runRoot);
    assert.deepEqual(replay, first);
    assert.equal(fixture.driverCalls.count, 1);
    assert.equal(fixture.downloads.count, 2);
    assert.equal(fixture.uploads.length, 12);
    const videoPackage = await readFile(fixture.uploads.find((upload) => upload.kind === "video-manifest")!.path);
    assert.equal(videoPackage.includes(Buffer.from(digest("video-bytes"))), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fixed Controller fails closed when the production export is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-godot-controller-"));
  try {
    const fixture = await controllerFixture(root, { emptyExport: true });
    const result = await fixture.controller.run(fixture.request, fixture.runRoot);
    assert.equal(result.status, "FAILED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fixed Controller rejects local evidence tampering before replay upload", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-godot-controller-"));
  try {
    const fixture = await controllerFixture(root);
    await fixture.controller.run(fixture.request, fixture.runRoot);
    const state = JSON.parse(await readFile(join(fixture.runRoot, "prepared-evidence.json"), "utf8")) as {
      artifacts: Array<{ kind: string; path: string }>;
    };
    const log = state.artifacts.find((artifact) => artifact.kind === "logs")!;
    if (process.platform !== "win32") await chmod(log.path, 0o600);
    await writeFile(log.path, "tampered\n");
    const uploadsBefore = fixture.uploads.length;
    await assert.rejects(fixture.controller.run(fixture.request, fixture.runRoot), /prepared artifact content/);
    assert.equal(fixture.uploads.length, uploadsBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("test plan parser rejects noncanonical or incomplete outcome plans before Godot", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-godot-controller-"));
  try {
    const fixture = await controllerFixture(root);
    const pretty = Buffer.from(JSON.stringify(fixture.plan, null, 2));
    const job = signedJob(digest(fixture.source), digest(pretty));
    const request = runRequest(join(root, "godot"), job);
    const port: GodotTestKitArtifactPort = {
      downloadInput: async (_job, path) => { await writeFile(path, fixture.source); return { sizeBytes: fixture.source.byteLength, artifactDigest: digest(fixture.source) }; },
      downloadTestPlan: async (_job, path) => { await writeFile(path, pretty); return { sizeBytes: pretty.byteLength, artifactDigest: digest(pretty) }; },
      uploadEvidence: async () => { throw new Error("must not upload"); },
    };
    const runRoot = join(root, "invalid-run");
    await mkdir(runRoot);
    const controller = new GodotTestKitController({ artifacts: port, driver: { run: async () => { throw new Error("must not run"); } } });
    await assert.rejects(controller.run(request, runRoot), /canonical encoding/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function controllerFixture(root: string, options: { readonly emptyExport?: boolean } = {}) {
  const project = Buffer.from("config_version=5\n[application]\nconfig/name=\"Fixture\"\n");
  const source = sourceBundle([{ name: "project.godot", body: project }]);
  const plan = testPlan();
  const planBytes = Buffer.from(canonicalJson(plan));
  const job = signedJob(digest(source), digest(planBytes));
  const godot = join(root, "godot");
  await writeFile(godot, "pinned-godot");
  const request = runRequest(godot, job);
  const runRoot = join(root, "run");
  await mkdir(runRoot, { mode: 0o700 });
  const uploads: Array<{ kind: TestKitArtifactKind; path: string; artifactDigest: string }> = [];
  const downloads = { count: 0 };
  const artifacts: GodotTestKitArtifactPort = {
    async downloadInput(_job, path) {
      downloads.count += 1;
      await writeFile(path, source, { flag: "wx" });
      return { sizeBytes: source.byteLength, artifactDigest: digest(source) };
    },
    async downloadTestPlan(_job, path) {
      downloads.count += 1;
      await writeFile(path, planBytes, { flag: "wx" });
      return { sizeBytes: planBytes.byteLength, artifactDigest: digest(planBytes) };
    },
    async uploadEvidence(_job, kind, path) {
      const value = await readFile(path);
      const artifactDigest = digest(value);
      uploads.push({ kind, path, artifactDigest });
      return { objectKey: `objects/${kind}/${artifactDigest}`, artifactDigest, sizeBytes: value.byteLength };
    },
  };
  const driverCalls = { count: 0 };
  const driver: GodotPlatformDriver = {
    async run(input) {
      driverCalls.count += 1;
      const harnessRoot = join(input.runRoot, "harness-output");
      const screenshotsRoot = join(harnessRoot, "screenshots");
      const exportRoot = join(input.runRoot, "production-export");
      await Promise.all([mkdir(screenshotsRoot, { recursive: true }), mkdir(exportRoot)]);
      const start = Buffer.from("png-start");
      const win = Buffer.from("png-win");
      await Promise.all([
        writeFile(join(screenshotsRoot, "start.png"), start),
        writeFile(join(screenshotsRoot, "win.png"), win),
        writeFile(join(harnessRoot, "video.avi"), "video-bytes"),
        ...(options.emptyExport ? [] : [writeFile(join(exportRoot, "DeviLudo.x86_64"), "export-bytes")]),
      ]);
      const harness: GodotHarnessResult = {
        schemaVersion: "deviludo.godot-harness-result.v1",
        status: "PASSED",
        checks: input.plan.scenarios.map((scenario) => ({
          id: scenario.id, outcome: scenario.outcome, status: "PASSED", durationMs: 10, code: "OK",
        })),
        inputTimeline: input.plan.scenarios.flatMap((scenario) => scenario.steps.map((step, stepIndex) => ({
          scenarioId: scenario.id,
          stepIndex,
          kind: step.kind,
          frame: stepIndex + 1,
        }))),
        screenshots: [
          { name: "start", file: "screenshots/start.png", sha256: digest(start), width: 640, height: 360 },
          { name: "win", file: "screenshots/win.png", sha256: digest(win), width: 640, height: 360 },
        ],
        performance: { averageFrameMs: 8, p95FrameMs: 12, sampledFrames: 120 },
        videoFile: "video.avi",
        createdAt: "2030-01-01T00:00:01.000Z",
      };
      return {
        commands: ["import", "boot", "platform-suite", "production-export", "production-boot"].map((id) => ({
          id: id as "import", status: "PASSED" as const, durationMs: 10, code: "OK",
        })),
        harness,
        exportRoot,
        logs: "Godot platform commands completed.\n",
      };
    },
  };
  return {
    controller: new GodotTestKitController({ artifacts, driver, now: () => new Date("2030-01-01T00:00:02.000Z") }),
    request,
    runRoot,
    uploads,
    downloads,
    driverCalls,
    source,
    plan,
  };
}

function runRequest(godot: string, job: SignedRunnerJob): GodotTestKitRunRequest {
  return {
    schemaVersion: "deviludo.testkit-run-request.v2",
    jobDigest: sha256Canonical(job.payload),
    testKitDigest: job.payload.godotTestKitDigest,
    godot: { executable: godot, binaryDigest: digest("pinned-godot"), version: job.payload.requiredGodotVersion },
    signedJob: job,
  };
}

function signedJob(sourceArtifactDigest: string, testPlanDigest: string): SignedRunnerJob {
  const payload: RunnerJobPayload = {
    schemaVersion: "deviludo.runner-job.v2",
    attemptId,
    tenantId,
    projectId,
    runId: "44444444-4444-4444-8444-444444444444",
    iterationId: "55555555-5555-4555-8555-555555555555",
    runnerId: "runner-linux-1",
    platform: "linux",
    fencingToken: 1,
    leaseExpiresAt: "2030-01-01T01:00:00.000Z",
    executionLockId: "66666666-6666-4666-8666-666666666666",
    executionLockDigest: sha("1"),
    commitSha: "a".repeat(40),
    sourceDigest: sha("2"),
    execution: {
      kind: "SOURCE_ARTIFACT",
      objectKey: `tenants/${tenantId}/projects/${projectId}/sources/${sourceArtifactDigest}.tar.zst`,
      artifactDigest: sourceArtifactDigest,
    },
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    specDigest: sha("3"),
    testPlanDigest,
    runnerToolchainRevisionId: "88888888-8888-4888-8888-888888888888",
    runnerToolchainDigest: sha("0"),
    targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable",
    godotTestKitDigest: sha("4"),
    exportTemplatesDigest: sha("5"),
    runnerCapabilityDigest: sha("6"),
    buildManifestDigest: sha("7"),
    sbomDigest: sha("8"),
    vulnerabilityScanDigest: sha("9"),
    assetLicenseLedgerDigest: sha("a"),
    requiredEvidence: ["logs", "junit", "input-timeline", "screenshots", "video", "production-export"],
  };
  return { payload, signature: { algorithm: "Ed25519", keyId: "runner-job-key-01", value: "opaque-signature" } };
}

function testPlan(): GodotTestPlan {
  const outcomes = ["CORE_LOOP", "WIN", "LOSE", "PAUSE_SETTINGS", "SAVE_LOAD"] as const;
  return {
    schemaVersion: "deviludo.godot-test-plan.v2",
    engine: "godot-4",
    targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable",
    timeouts: { importSeconds: 60, bootSeconds: 60, suiteSeconds: 300, exportSeconds: 600 },
    performance: { warmupFrames: 30, sampleFrames: 120, maximumAverageFrameMs: 16, maximumP95FrameMs: 32 },
    scenarios: outcomes.map((outcome, index) => ({
      id: `${String(index + 1).padStart(2, "0")}-${outcome.toLowerCase().replaceAll("_", "-")}`,
      outcome,
      steps: [
        { kind: "WAIT_FRAMES", frames: 2 } as const,
        { kind: "ASSERT_GROUP_COUNT", group: `deviludo.${outcome.toLowerCase()}`, minimum: 0, maximum: 100 } as const,
        ...(index < 2 ? [{ kind: "SCREENSHOT" as const, name: index === 0 ? "start" : "win" }] : []),
      ],
    })),
  };
}

function sourceBundle(entries: readonly Readonly<{ name: string; body: Buffer }>[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o600);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.body.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar", 257, "ascii");
    header.write("00", 263, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
    header[154] = 0;
    header[155] = 32;
    chunks.push(header, entry.body, Buffer.alloc((512 - (entry.body.byteLength % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return zstdCompressSync(Buffer.concat(chunks));
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  target.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  target[offset + length - 1] = 0;
}
