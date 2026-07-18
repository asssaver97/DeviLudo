import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { RunnerJobPayload, SignedRunnerJob } from "../../runner-control/src/contracts";
import type { PhysicalRunnerExecutionOutput } from "../../runner-control/src/physical-runner";
import { runGodotTestKitCli } from "../src/run-cli";

const sha = (value: string) => value.repeat(64);

test("TestKit CLI parses the signed request before emitting one immutable bound result", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-testkit-cli-"));
  try {
    const requestPath = join(root, "request.json");
    const outputPath = join(root, "result.json");
    const request = runRequest("/opt/godot/godot");
    await writeFile(requestPath, JSON.stringify(request));
    let calls = 0;
    const evidence = result();
    const controller = {
      async run(value: unknown, runRoot: string): Promise<PhysicalRunnerExecutionOutput> {
        calls += 1;
        assert.equal(Object.isFrozen(value), true);
        assert.equal(runRoot, await realpath(root));
        return evidence;
      },
    };
    const argv = ["run", "--request-file", requestPath, "--output-file", outputPath];
    await runGodotTestKitCli(argv, {}, { controller });
    await runGodotTestKitCli(argv, {}, { controller });
    assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
      schemaVersion: "deviludo.testkit-run-result.v1",
      jobDigest: request.jobDigest,
      testKitDigest: request.testKitDigest,
      godotBinaryDigest: request.godot.binaryDigest,
      evidence,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TestKit CLI rejects malformed requests and control paths before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-testkit-cli-"));
  try {
    const requestPath = join(root, "request.json");
    const outputPath = join(root, "result.json");
    await writeFile(requestPath, JSON.stringify({ ...runRequest("/opt/godot/godot"), futureField: true }));
    const controller = { run: async (): Promise<PhysicalRunnerExecutionOutput> => { throw new Error("must not run"); } };
    await assert.rejects(runGodotTestKitCli([
      "run", "--request-file", requestPath, "--output-file", outputPath,
    ], {}, { controller }), /request fields/);
    await assert.rejects(runGodotTestKitCli([
      "run", "--request-file", requestPath, "--output-file", join(root, "other.json"),
    ], {}, { controller }), /control paths/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function runRequest(godotExecutable: string) {
  const payload: RunnerJobPayload = {
    schemaVersion: "deviludo.runner-job.v2",
    attemptId: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
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
    execution: { kind: "SOURCE_ARTIFACT", objectKey: "source.tar.zst", artifactDigest: sha("3") },
    specRevisionId: "77777777-7777-4777-8777-777777777777",
    specDigest: sha("4"),
    testPlanDigest: sha("5"),
    targetMatrix: ["linux"],
    requiredGodotVersion: "4.6.2-stable",
    godotTestKitDigest: sha("6"),
    exportTemplatesDigest: sha("7"),
    runnerCapabilityDigest: sha("8"),
    buildManifestDigest: sha("9"),
    sbomDigest: sha("a"),
    vulnerabilityScanDigest: sha("b"),
    assetLicenseLedgerDigest: sha("c"),
    requiredEvidence: ["logs", "junit", "input-timeline", "screenshots", "video", "production-export"],
  };
  const signedJob: SignedRunnerJob = {
    payload,
    signature: { algorithm: "Ed25519", keyId: "runner-job-key-01", value: "opaque-signature" },
  };
  return {
    schemaVersion: "deviludo.testkit-run-request.v2" as const,
    jobDigest: sha256Canonical(payload),
    testKitDigest: payload.godotTestKitDigest,
    godot: { executable: godotExecutable, binaryDigest: sha("d"), version: payload.requiredGodotVersion },
    signedJob,
  };
}

function result(): PhysicalRunnerExecutionOutput {
  return {
    exportDigest: sha("1"),
    logsDigest: sha("2"),
    junitDigest: sha("3"),
    inputTimelineDigest: sha("4"),
    screenshotManifestDigest: sha("5"),
    videoManifestDigest: sha("6"),
    status: "PASSED",
    createdAt: "2030-01-01T00:00:01.000Z",
  };
}
