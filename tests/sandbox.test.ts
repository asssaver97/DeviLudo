import assert from "node:assert/strict";
import test from "node:test";
import type { JobProtocolV4 } from "@/services/core/src/contracts";
import { parseExecutorStderrLine, ProcessSandboxBackend, sandboxPlan } from "@/services/core/src/sandbox";

const baseJob: JobProtocolV4 = Object.freeze({
  schemaVersion: "deviludo.job.v4",
  jobId: "30000000-0000-4000-8000-000000000001",
  workflowId: "30000000-0000-4000-8000-000000000002",
  workspaceId: "30000000-0000-4000-8000-000000000003",
  projectId: "30000000-0000-4000-8000-000000000004",
  poolKind: "CORE",
  jobKind: "BUILD",
  targetOperatingSystem: null,
  requiredCapabilities: Object.freeze(["MICROVM", "NETWORK_POLICY"]),
  exclusive: false,
  isolationGeneration: 1,
  runtimeImage: `sha256:${"a".repeat(64)}`,
  workflowProfile: "VALIDATE",
  inputObjects: Object.freeze([]),
  outputContract: Object.freeze({ kinds: Object.freeze(["SPECIFICATION"]), maxBytes: 1_073_741_824 }),
  budget: Object.freeze({ cpuMillis: 900_000, memoryBytes: 4_294_967_296, networkBytes: 1_073_741_824 }),
  timeoutSeconds: 1800,
  payload: Object.freeze({}),
  lease: Object.freeze({
    token: "lease_token_abcdefghijklmnopqrstuvwxyz",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    fencingToken: 1,
  }),
});

test("sandbox plans isolate controlled build and Steam jobs", () => {
  const build = sandboxPlan(baseJob);
  assert.equal(build.mode, "RESTRICTED_CONTAINER");
  assert.equal(build.networkPolicy, "BUILD_EGRESS_DENY");
  assert.match(build.workspace, new RegExp(`${baseJob.workspaceId}.+${baseJob.jobId}`));

  const publish = sandboxPlan(Object.freeze({
    ...baseJob,
    jobKind: "STEAM_PUBLISH",
    requiredCapabilities: Object.freeze(["RESTRICTED_CONTAINER", "STEAMCMD"]),
  }));
  assert.equal(publish.networkPolicy, "STEAM_ONLY");
  assert.throws(() => sandboxPlan(Object.freeze({ ...baseJob, exclusive: true })));
});

test("disposable sandbox rejects Agent turns because they require the persistent Runtime", () => {
  assert.throws(() => sandboxPlan(Object.freeze({
    ...baseJob,
    jobKind: "AGENT_TURN",
  })), /persistent Project Runtime/);
});

test("production sandbox execution fails closed without a trusted backend", async () => {
  const backend = new ProcessSandboxBackend("");
  await assert.rejects(() => backend.execute(
    sandboxPlan(baseJob),
    new AbortController().signal,
  ), /trusted sandbox executor/i);
});

test("executor progress is separated from failure diagnostics", () => {
  assert.deepEqual(
    parseExecutorStderrLine('DEVILUDO_PROGRESS:{"kind":"AGENT_OUTPUT","content":"building\\nproject"}'),
    {
      progress: { kind: "AGENT_OUTPUT", content: "building\nproject" },
      diagnostic: null,
    },
  );
  assert.deepEqual(parseExecutorStderrLine("claude exited 1: provider unavailable"), {
    progress: null,
    diagnostic: "claude exited 1: provider unavailable",
  });
  assert.deepEqual(parseExecutorStderrLine("DEVILUDO_PROGRESS:not-json"), {
    progress: null,
    diagnostic: "Executor emitted a malformed progress event",
  });
});
