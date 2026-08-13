import assert from "node:assert/strict";
import test from "node:test";
import type { JobProtocolV4 } from "@/services/core/src/contracts";
import { classifyE2eInfrastructureFailure } from "@/lib/runtime/e2e-failure";
import { loadE2eNodeConfig, type E2eNodeConfig } from "@/services/e2e-node/src/config";
import type { CoreE2eClient } from "@/services/e2e-node/src/core-client";
import { executeE2eJob, validateExecutionReceipt } from "@/services/e2e-node/src/executor";
import type { IsolationController } from "@/services/e2e-node/src/isolation";
import { e2eExecutableInvocation } from "@/services/e2e-node/src/tool-path";

const baseJob: JobProtocolV4 = Object.freeze({
  schemaVersion: "deviludo.job.v4",
  jobId: "20000000-0000-4000-8000-000000000001",
  workflowId: "20000000-0000-4000-8000-000000000002",
  workspaceId: "20000000-0000-4000-8000-000000000003",
  projectId: "20000000-0000-4000-8000-000000000004",
  poolKind: "E2E_MACOS",
  jobKind: "E2E_TEST",
  targetOperatingSystem: "macos",
  requiredCapabilities: Object.freeze(["GAME_RUNTIME", "TRUSTED_REIMAGE"]),
  exclusive: true,
  isolationGeneration: 7,
  runtimeImage: `sha256:${"b".repeat(64)}`,
  workflowProfile: "VALIDATE",
  inputObjects: Object.freeze([]),
  outputContract: Object.freeze({ kinds: Object.freeze(["E2E_REPORT"]), maxBytes: 1_048_576 }),
  budget: Object.freeze({ cpuMillis: 900_000, memoryBytes: 4_294_967_296, networkBytes: 1_073_741_824 }),
  timeoutSeconds: 1800,
  payload: Object.freeze({ artifact: "workspace/project/build.zip" }),
  lease: Object.freeze({
    token: "lease_token_abcdefghijklmnopqrstuvwxyz",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    fencingToken: 11,
  }),
});

const config: E2eNodeConfig = Object.freeze({
  nodeId: "20000000-0000-4000-8000-000000000005",
  poolKind: "E2E_MACOS",
  operatingSystem: "macos",
  coreUrl: new URL("http://127.0.0.1:8080"),
  developmentToken: "development-token",
  certificateFile: null,
  keyFile: null,
  caFile: null,
  identityKeyFile: "/tmp/deviludo-test-ed25519.pem",
  pollMilliseconds: 250,
});

test("JavaScript E2E executors use the running Node binary instead of a PATH-dependent shebang", () => {
  assert.deepEqual(
    e2eExecutableInvocation("/opt/deviludo/e2e-job.mjs", ["test"], "/fixed/node"),
    { executable: "/fixed/node", arguments: ["/opt/deviludo/e2e-job.mjs", "test"] },
  );
  assert.deepEqual(
    e2eExecutableInvocation("/opt/deviludo/e2e-job", ["test"], "/fixed/node"),
    { executable: "/opt/deviludo/e2e-job", arguments: ["test"] },
  );
});

test("E2E infrastructure failures retain the underlying node, VM, runtime, or network domain", () => {
  assert.equal(classifyE2eInfrastructureFailure(new Error("executor binary is missing")).domain, "NODE");
  assert.equal(classifyE2eInfrastructureFailure(new Error("golden VM reimage failed")).domain, "VM");
  assert.equal(classifyE2eInfrastructureFailure(new Error("Godot guest runner returned invalid JSON")).domain, "GODOT_RUNTIME");
  assert.equal(classifyE2eInfrastructureFailure(new Error("Artifact download returned 503")).domain, "NETWORK");
  assert.deepEqual(
    classifyE2eInfrastructureFailure(new AggregateError([
      new Error("Artifact download returned 503"),
      new Error("cleanup proof missing after VM teardown"),
    ])).domain,
    "VM",
  );
});

test("a trusted failed guest report is a product outcome instead of an E2E node failure", () => {
  const digest = `sha256:${"a".repeat(64)}` as const;
  const job: JobProtocolV4 = Object.freeze({
    ...baseJob,
    inputObjects: Object.freeze([Object.freeze({
      kind: "BUILD",
      targetPlatform: "macos",
      bucket: "deviludo-artifacts",
      key: `workspaces/${baseJob.workspaceId}/projects/${baseJob.projectId}/jobs/build/build-macos.tar.gz`,
      sha256: digest,
      sizeBytes: 1024,
    })]),
  });
  assert.doesNotThrow(() => validateExecutionReceipt(job, Object.freeze({
    schema: "deviludo.godot-guest-report",
    action: "test",
    jobId: job.jobId,
    inputDigest: digest,
    outcome: "FAILED",
    failureDomain: "PRODUCT",
    summary: "The exported game crashed while entering the first level",
    guest: Object.freeze({ exitCode: 1 }),
    evidence: Object.freeze({ schema: "deviludo.e2e-evidence", result: "FAILED", headlessCheckCount: 2,
      interactiveJourneyCount: 0, deterministicInputCount: 0, realInputCount: 0, keyboardMouseInputCount: 0,
      gamepadInputCount: 0, adaptiveRolloutCount: 0, adaptiveSuccessCount: 0, adaptiveDecisionCount: 0,
      coveredPlayerRequirementCount: 0, playerRequirementCount: 1, screenshotCount: 1,
      visualBaselineCount: 0, videoCount: 1, hasVisualDiff: false,
      regressionTraceDigest: null, regressionInputProfile: null, regressionEstimatedDurationMs: null,
      packageLaunchMode: "MACOS_LAUNCH_SERVICES" }),
    outputPath: "/tmp/deviludo-e2e/evidence.zip",
    outputSha256: `sha256:${"c".repeat(64)}`,
    outputSizeBytes: 1024,
  })));
  assert.throws(() => validateExecutionReceipt(job, Object.freeze({
    schema: "deviludo.godot-guest-report",
    action: "test",
    jobId: job.jobId,
    inputDigest: digest,
    outcome: "FAILED",
    failureDomain: "NETWORK",
    summary: "network unavailable",
    guest: Object.freeze({ exitCode: 1 }),
    evidence: Object.freeze({ schema: "deviludo.e2e-evidence", result: "FAILED", headlessCheckCount: 2,
      interactiveJourneyCount: 0, deterministicInputCount: 0, realInputCount: 0, keyboardMouseInputCount: 0,
      gamepadInputCount: 0, adaptiveRolloutCount: 0, adaptiveSuccessCount: 0, adaptiveDecisionCount: 0,
      coveredPlayerRequirementCount: 0, playerRequirementCount: 1, screenshotCount: 1,
      visualBaselineCount: 0, videoCount: 1, hasVisualDiff: false,
      regressionTraceDigest: null, regressionInputProfile: null, regressionEstimatedDurationMs: null,
      packageLaunchMode: "MACOS_LAUNCH_SERVICES" }),
    outputPath: "/tmp/deviludo-e2e/evidence.zip",
    outputSha256: `sha256:${"c".repeat(64)}`,
    outputSizeBytes: 1024,
  })));
});

test("ordinary E2E tests never receive signing authority", async () => {
  const client = {
    async authorizeObjects() { return []; },
  } as unknown as CoreE2eClient;
  const calls: string[] = [];
  const isolation = fakeIsolation(calls);
  await assert.rejects(() => executeE2eJob(baseJob, config, client, isolation, new AbortController().signal), AggregateError);
  assert.deepEqual(calls, ["agent-absent", "reimage-before", "cleanup", "reimage-after"]);
});

test("retired signing jobs are rejected before isolation", async () => {
  const job: JobProtocolV4 = Object.freeze({
    ...baseJob,
    jobKind: "ARTIFACT_SIGN",
    requiredCapabilities: Object.freeze(["SIGNING", "HSM", "TRUSTED_REIMAGE"]),
  });
  const calls: string[] = [];
  await assert.rejects(() => executeE2eJob(
    job,
    config,
    {} as CoreE2eClient,
    fakeIsolation(calls),
    new AbortController().signal,
  ), /retired historical job kind/);
  assert.deepEqual(calls, []);
});

test("logical operating-system overrides are restricted to test mode and still pool matched", () => {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DEVILUDO_E2E_NODE_ID: config.nodeId,
    DEVILUDO_E2E_POOL_KIND: "E2E_WINDOWS",
    DEVILUDO_E2E_OPERATING_SYSTEM_OVERRIDE: "windows",
    DEVILUDO_CORE_API_URL: "http://127.0.0.1:8080",
    DEVILUDO_E2E_NODE_TOKEN: "local-e2e-node-token",
    DEVILUDO_E2E_IDENTITY_KEY_FILE: "/tmp/deviludo-test-ed25519.pem",
  };
  const logical = loadE2eNodeConfig(environment);
  assert.equal(logical.operatingSystem, "windows");
  assert.equal(logical.poolKind, "E2E_WINDOWS");
  assert.throws(() => loadE2eNodeConfig({ ...environment, NODE_ENV: "development" }));
  assert.throws(() => loadE2eNodeConfig({
    ...environment,
    DEVILUDO_E2E_POOL_KIND: "E2E_MACOS",
  }));
});

test("execution failures still attempt cleanup and the final trusted reimage", async () => {
  const client = {
    async authorizeObjects() { throw new Error("artifact authorization unavailable"); },
  } as unknown as CoreE2eClient;
  const calls: string[] = [];
  await assert.rejects(() => executeE2eJob(
    baseJob,
    config,
    client,
    fakeIsolation(calls),
    new AbortController().signal,
  ), AggregateError);
  assert.deepEqual(calls, ["agent-absent", "reimage-before", "cleanup", "reimage-after"]);
});

test("cleanup failures fail the job even when execution itself succeeds", async () => {
  const calls: string[] = [];
  const isolation: IsolationController = {
    async assertAgentAbsent() { calls.push("agent-absent"); },
    async reimage(_job, stage) {
      calls.push(`reimage-${stage}`);
      return `trusted-reimage-${stage}-proof`;
    },
    async cleanup() {
      calls.push("cleanup");
      throw new Error("cleanup failed");
    },
  };
  await assert.rejects(() => executeE2eJob(
    baseJob,
    config,
    { authorizeObjects: async () => [] } as unknown as CoreE2eClient,
    isolation,
    new AbortController().signal,
  ), AggregateError);
  assert.deepEqual(calls, ["agent-absent", "reimage-before", "cleanup", "reimage-after"]);
});

function fakeIsolation(calls: string[]): IsolationController {
  return {
    async assertAgentAbsent() {
      calls.push("agent-absent");
    },
    async reimage(_job, stage) {
      calls.push(`reimage-${stage}`);
      return `trusted-reimage-${stage}-proof`;
    },
    async cleanup() {
      calls.push("cleanup");
      return "trusted-workspace-cleanup-proof";
    },
  };
}
