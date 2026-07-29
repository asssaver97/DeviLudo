import assert from "node:assert/strict";
import test from "node:test";
import type { JobProtocolV3 } from "@/services/core/src/contracts";
import type { E2eNodeConfig } from "@/services/e2e-node/src/config";
import type { CoreE2eClient } from "@/services/e2e-node/src/core-client";
import { executeE2eJob } from "@/services/e2e-node/src/executor";
import type { IsolationController } from "@/services/e2e-node/src/isolation";

const baseJob: JobProtocolV3 = Object.freeze({
  schemaVersion: "deviludo.job.v3",
  jobId: "20000000-0000-4000-8000-000000000001",
  workflowId: "20000000-0000-4000-8000-000000000002",
  tenantId: "20000000-0000-4000-8000-000000000003",
  projectId: "20000000-0000-4000-8000-000000000004",
  poolKind: "E2E_MACOS",
  jobKind: "E2E_TEST",
  targetOperatingSystem: "macos",
  requiredCapabilities: Object.freeze(["GAME_RUNTIME", "TRUSTED_REIMAGE"]),
  exclusive: true,
  isolationGeneration: 7,
  payload: Object.freeze({ artifact: "tenant/project/build.zip" }),
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
  pollMilliseconds: 250,
});

test("ordinary E2E tests never receive signing authority", async () => {
  let grantRequests = 0;
  const client = {
    async issueSigningGrant() {
      grantRequests += 1;
      throw new Error("must not be called");
    },
  } as unknown as CoreE2eClient;
  const calls: string[] = [];
  const isolation = fakeIsolation(calls);
  const completion = await executeE2eJob(baseJob, config, client, isolation, new AbortController().signal);
  assert.equal(grantRequests, 0);
  assert.deepEqual(calls, ["agent-absent", "reimage-before", "cleanup", "reimage-after"]);
  assert.equal(completion.isolationGeneration, 7);
  assert.ok(completion.beforeReimageProof);
  assert.ok(completion.afterReimageProof);
});

test("signing is platform matched, exclusive and receives one short-lived grant", async () => {
  let grantRequests = 0;
  const client = {
    async issueSigningGrant() {
      grantRequests += 1;
      return {
        grantId: "grant-1",
        wrappedToken: "wrapped-one-time-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        operationId: "20000000-0000-4000-8000-000000000006",
      };
    },
  } as unknown as CoreE2eClient;
  const job: JobProtocolV3 = Object.freeze({
    ...baseJob,
    jobKind: "ARTIFACT_SIGN",
    requiredCapabilities: Object.freeze(["SIGNING", "HSM", "TRUSTED_REIMAGE"]),
  });
  const completion = await executeE2eJob(
    job,
    config,
    client,
    fakeIsolation([]),
    new AbortController().signal,
  );
  assert.equal(grantRequests, 1);
  assert.equal(completion.receipt.jobKind, "ARTIFACT_SIGN");
  assert.equal(JSON.stringify(completion.receipt).includes("wrapped-one-time-token"), false);
});

test("a signing job for another platform is rejected before isolation", async () => {
  const job: JobProtocolV3 = Object.freeze({
    ...baseJob,
    jobKind: "ARTIFACT_SIGN",
    poolKind: "E2E_WINDOWS",
    targetOperatingSystem: "windows",
    requiredCapabilities: Object.freeze(["SIGNING", "HSM", "TRUSTED_REIMAGE"]),
  });
  const calls: string[] = [];
  await assert.rejects(() => executeE2eJob(
    job,
    config,
    {} as CoreE2eClient,
    fakeIsolation(calls),
    new AbortController().signal,
  ));
  assert.deepEqual(calls, []);
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
