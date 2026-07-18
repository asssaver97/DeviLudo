import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerJobPayload, SignedRunnerJob } from "../src/contracts";
import type { PhysicalRunnerExecutionOutput } from "../src/physical-runner";
import { LockedTestKitExecutor, type TestKitProcess } from "../src/testkit-executor";

const tenantId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const sha = (value: string) => value.repeat(64);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function job(testKitDigest: string, overrides: Partial<RunnerJobPayload> = {}): RunnerJobPayload {
  return {
    schemaVersion: "deviludo.runner-job.v2",
    attemptId,
    tenantId,
    projectId: "33333333-3333-4333-8333-333333333333",
    runId: "44444444-4444-4444-8444-444444444444",
    iterationId: "55555555-5555-4555-8555-555555555555",
    runnerId: "runner-linux-1",
    platform: "linux",
    fencingToken: 3,
    leaseExpiresAt: "2030-01-01T00:05:00.000Z",
    executionLockId: "66666666-6666-4666-8666-666666666666",
    executionLockDigest: sha("1"),
    commitSha: "a".repeat(40),
    sourceDigest: sha("2"),
    execution: {
      kind: "SOURCE_ARTIFACT",
      objectKey: `tenants/${tenantId}/source/game.tar.zst`,
      artifactDigest: sha("3"),
    },
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    specDigest: sha("4"),
    testPlanDigest: sha("5"),
    targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable",
    godotTestKitDigest: testKitDigest,
    exportTemplatesDigest: sha("6"),
    runnerCapabilityDigest: sha("7"),
    buildManifestDigest: sha("8"),
    sbomDigest: sha("9"),
    vulnerabilityScanDigest: sha("a"),
    assetLicenseLedgerDigest: sha("b"),
    requiredEvidence: ["logs", "junit", "input-timeline", "screenshots", "video", "production-export"],
    ...overrides,
  };
}

function signedJob(testKitDigest: string, overrides: Partial<RunnerJobPayload> = {}): SignedRunnerJob {
  return {
    payload: job(testKitDigest, overrides),
    signature: { algorithm: "Ed25519", keyId: "runner-job-key-01", value: "signed-envelope-test-value" },
  };
}

function evidence(status: "PASSED" | "FAILED" = "PASSED"): PhysicalRunnerExecutionOutput {
  return {
    exportDigest: sha("1"),
    logsDigest: sha("2"),
    junitDigest: sha("3"),
    inputTimelineDigest: sha("4"),
    screenshotManifestDigest: sha("5"),
    videoManifestDigest: sha("6"),
    status,
    createdAt: "2030-01-01T00:00:01.000Z",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deviludo-testkit-executor-"));
  const testKitExecutable = join(root, "testkit-controller");
  const godotExecutable = join(root, "godot");
  const workRoot = join(root, "work");
  const testKitBytes = Buffer.from("pinned-testkit-controller-v1");
  const godotBytes = Buffer.from("pinned-godot-4.6.2-stable");
  await writeFile(testKitExecutable, testKitBytes);
  await writeFile(godotExecutable, godotBytes);
  return {
    root,
    testKitExecutable,
    testKitDigest: digest(testKitBytes),
    godotExecutable,
    godotBinaryDigest: digest(godotBytes),
    workRoot,
  };
}

test("locked TestKit executor verifies binaries, fixed argv and reuses one content-bound result", async () => {
  const files = await fixture();
  try {
    let calls = 0;
    const process: TestKitProcess = async (executable, args, options) => {
      calls += 1;
      assert.equal(executable, files.testKitExecutable);
      assert.deepEqual(args.slice(0, 2), ["run", "--request-file"]);
      assert.equal(args[3], "--output-file");
      assert.equal(options.cwd.startsWith(await realpath(files.workRoot)), true);
      assert.equal(options.env.API_KEY, undefined);
      assert.equal(options.env.NODE_ENV, "production");
      assert.equal(options.env.DISPLAY, ":91");
      assert.equal(options.env.XDG_RUNTIME_DIR, "/run/user/1000");
      assert.equal(options.env.DEVILUDO_TESTKIT_ARTIFACT_BROKER_URL, "https://archive.internal");
      const request = JSON.parse(await readFile(args[2]!, "utf8")) as {
        schemaVersion: string;
        jobDigest: string;
        testKitDigest: string;
        godot: { binaryDigest: string };
        signedJob: SignedRunnerJob;
      };
      assert.equal(request.schemaVersion, "deviludo.testkit-run-request.v2");
      assert.equal(request.signedJob.signature.keyId, "runner-job-key-01");
      await writeFile(args[4]!, JSON.stringify({
        schemaVersion: "deviludo.testkit-run-result.v1",
        jobDigest: request.jobDigest,
        testKitDigest: request.testKitDigest,
        godotBinaryDigest: request.godot.binaryDigest,
        evidence: evidence(),
      }), "utf8");
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const executor = new LockedTestKitExecutor({
      ...files,
      godotVersion: "4.6.2-stable",
      process,
      hostEnvironment: {
        API_KEY: "must-not-leak",
        LANG: "C.UTF-8",
        DISPLAY: ":91",
        XDG_RUNTIME_DIR: "/run/user/1000",
        WAYLAND_DISPLAY: "wayland-0\ninvalid",
      },
      testKitEnvironment: artifactEnvironment(),
      now: () => new Date("2030-01-01T00:00:02.000Z"),
    });
    assert.equal((await executor.execute(signedJob(files.testKitDigest))).status, "PASSED");
    assert.equal((await executor.execute(signedJob(files.testKitDigest))).status, "PASSED");
    assert.equal(calls, 1);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("locked TestKit executor rejects partial or unknown child environment", async () => {
  const files = await fixture();
  try {
    assert.throws(() => new LockedTestKitExecutor({
      ...files,
      godotVersion: "4.6.2-stable",
      testKitEnvironment: { DEVILUDO_TESTKIT_ARTIFACT_BROKER_URL: "https://archive.internal" },
    }), /environment is incomplete/);
    assert.throws(() => new LockedTestKitExecutor({
      ...files,
      godotVersion: "4.6.2-stable",
      testKitEnvironment: { ...artifactEnvironment(), API_KEY: "must-not-leak" },
    }), /environment is invalid/);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

function artifactEnvironment(): Readonly<Record<string, string>> {
  return {
    DEVILUDO_TESTKIT_ARTIFACT_BROKER_URL: "https://archive.internal",
    DEVILUDO_TESTKIT_ARTIFACT_TLS_KEY_FILE: "/run/secrets/testkit/tls.key",
    DEVILUDO_TESTKIT_ARTIFACT_TLS_CERT_FILE: "/run/secrets/testkit/tls.crt",
    DEVILUDO_TESTKIT_ARTIFACT_CA_FILE: "/run/secrets/testkit/archive-ca.crt",
    DEVILUDO_TESTKIT_TRANSFER_CA_FILE: "/run/secrets/testkit/transfer-ca.crt",
    DEVILUDO_TESTKIT_ALLOWED_TRANSFER_ORIGINS_JSON: '["https://s3.internal"]',
  };
}

test("locked TestKit executor rejects binary, request and result binding drift", async () => {
  const files = await fixture();
  try {
    let resultDigest = files.testKitDigest;
    const process: TestKitProcess = async (_executable, args) => {
      const request = JSON.parse(await readFile(args[2]!, "utf8")) as {
        jobDigest: string;
        godot: { binaryDigest: string };
      };
      await writeFile(args[4]!, JSON.stringify({
        schemaVersion: "deviludo.testkit-run-result.v1",
        jobDigest: request.jobDigest,
        testKitDigest: resultDigest,
        godotBinaryDigest: request.godot.binaryDigest,
        evidence: evidence("FAILED"),
      }), "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const executor = new LockedTestKitExecutor({
      ...files,
      godotVersion: "4.6.2-stable",
      process,
      now: () => new Date("2030-01-01T00:00:02.000Z"),
    });
    resultDigest = sha("f");
    await assert.rejects(executor.execute(signedJob(files.testKitDigest)), /result binding is invalid/);

    await rm(files.workRoot, { recursive: true, force: true });
    await writeFile(files.testKitExecutable, "tampered-controller");
    await assert.rejects(executor.execute(signedJob(files.testKitDigest)), /integrity check failed/);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("locked TestKit executor fails closed on an existing request collision and controller failure", async () => {
  const files = await fixture();
  try {
    let calls = 0;
    const process: TestKitProcess = async () => {
      calls += 1;
      return { exitCode: 9, stdout: "", stderr: "sensitive diagnostics" };
    };
    const executor = new LockedTestKitExecutor({
      ...files,
      godotVersion: "4.6.2-stable",
      process,
      now: () => new Date("2030-01-01T00:00:02.000Z"),
    });
    await assert.rejects(executor.execute(signedJob(files.testKitDigest)), /controller failed/);
    assert.equal(calls, 1);
    await assert.rejects(executor.execute(signedJob(files.testKitDigest, { sourceDigest: sha("f") })), /request conflicts/);
    assert.equal(calls, 1);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});
