import assert from "node:assert/strict";
import test from "node:test";
import type { JobProtocolV3 } from "@/services/core/src/contracts";
import { ProcessSandboxBackend, sandboxPlan } from "@/services/core/src/sandbox";

const baseJob: JobProtocolV3 = Object.freeze({
  schemaVersion: "deviludo.job.v3",
  jobId: "30000000-0000-4000-8000-000000000001",
  workflowId: "30000000-0000-4000-8000-000000000002",
  tenantId: "30000000-0000-4000-8000-000000000003",
  projectId: "30000000-0000-4000-8000-000000000004",
  poolKind: "CORE",
  jobKind: "AGENT_GENERATION",
  targetOperatingSystem: null,
  requiredCapabilities: Object.freeze(["MICROVM", "NETWORK_POLICY"]),
  exclusive: false,
  isolationGeneration: 1,
  payload: Object.freeze({}),
  lease: Object.freeze({
    token: "lease_token_abcdefghijklmnopqrstuvwxyz",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    fencingToken: 1,
  }),
});

test("sandbox plans isolate each Core job and select the fixed execution policy", () => {
  const agent = sandboxPlan(baseJob);
  assert.equal(agent.mode, "MICROVM");
  assert.equal(agent.networkPolicy, "AGENT_EGRESS_ALLOWLIST");
  assert.match(agent.workspace, new RegExp(`${baseJob.tenantId}.+${baseJob.jobId}`));

  const build = sandboxPlan(Object.freeze({
    ...baseJob,
    jobKind: "ARTIFACT_BUILD",
    requiredCapabilities: Object.freeze(["RESTRICTED_CONTAINER", "BUILD_TOOLCHAIN"]),
  }));
  assert.equal(build.mode, "RESTRICTED_CONTAINER");
  assert.equal(build.networkPolicy, "BUILD_EGRESS_DENY");

  const publish = sandboxPlan(Object.freeze({
    ...baseJob,
    jobKind: "STEAM_PUBLISH",
    requiredCapabilities: Object.freeze(["RESTRICTED_CONTAINER", "STEAMCMD"]),
  }));
  assert.equal(publish.networkPolicy, "STEAM_ONLY");
  assert.throws(() => sandboxPlan(Object.freeze({ ...baseJob, exclusive: true })));
});

test("production sandbox execution fails closed without a trusted backend", async () => {
  const backend = new ProcessSandboxBackend("", true);
  await assert.rejects(() => backend.execute(
    sandboxPlan(baseJob),
    new AbortController().signal,
  ), /trusted sandbox executor/i);
});
