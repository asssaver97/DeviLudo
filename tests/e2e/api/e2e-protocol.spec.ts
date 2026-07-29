import { randomUUID } from "node:crypto";
import type { APIResponse } from "@playwright/test";
import type { JobProtocolV3 } from "../../../services/core/src/contracts";
import {
  StackHarness,
  test,
  expect,
  type NodeRecord,
  type ProjectDetail,
} from "../fixtures/stack";

test("claim, heartbeat, proof validation and lease fencing protect exclusive E2E jobs", async ({ stack }) => {
  const { project, nodes } = await prepareE2eStage(stack);
  const mac = requiredNode(nodes, "E2E_MACOS");

  const unauthorized = await stack.apiRequest.post(new URL("/v1/e2e/jobs/claim", stack.coreUrl).href, {
    data: { nodeId: mac.id, poolKind: mac.poolKind },
  });
  expect(unauthorized.status()).toBe(401);

  const wrongPool = await stack.coreNode("/v1/e2e/jobs/claim", {
    method: "POST",
    data: { nodeId: mac.id, poolKind: "E2E_WINDOWS" },
  });
  expect(wrongPool.status()).toBe(409);

  await stack.coreWeb(`/v1/admin/server-nodes/${mac.id}/drain`, { method: "POST", data: {} });
  const drained = await claimResponse(stack, mac);
  expect(drained.status()).toBe(409);
  await stack.coreWeb(`/v1/admin/server-nodes/${mac.id}/activate`, { method: "POST", data: {} });

  const job = await claim(stack, mac);
  expect(job.jobKind).toBe("E2E_TEST");
  expect(job.exclusive).toBeTruthy();
  expect(job.targetOperatingSystem).toBe("macos");

  const duplicateClaim = await claimResponse(stack, mac);
  expect(duplicateClaim.ok()).toBeTruthy();
  expect((await duplicateClaim.json() as { job: unknown }).job).toBeNull();

  const badHeartbeat = await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/heartbeat`, {
    method: "POST",
    data: { tenantId: job.tenantId, leaseToken: randomUUID() },
  });
  expect(badHeartbeat.status()).toBe(400);
  const heartbeat = await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/heartbeat`, {
    method: "POST",
    data: identity(job),
  });
  expect(await heartbeat.json()).toEqual({ accepted: true });

  const forbiddenGrant = await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/signing-grant`, {
    method: "POST",
    data: { ...identity(job), beforeReimageProof: proof("before") },
  });
  expect(forbiddenGrant.status()).toBe(403);

  const missingProofs = await completeResponse(stack, job, {
    beforeReimageProof: undefined,
    cleanupProof: undefined,
    afterReimageProof: undefined,
  });
  expect(missingProofs.status()).toBe(400);

  const wrongGeneration = await completeResponse(stack, job, {
    isolationGeneration: job.isolationGeneration + 1,
  });
  expect(wrongGeneration.status()).toBe(400);

  const completed = await completeResponse(stack, job);
  expect(completed.ok()).toBeTruthy();
  expect(await completed.json()).toEqual({ accepted: true });

  const replay = await completeResponse(stack, job);
  expect(replay.status()).toBe(400);
  const stored = await stack.waitForProject(project.id, value => value.jobs.some(item => item.id === job.jobId && item.state === "SUCCEEDED"));
  expect(stored.jobs.find(item => item.id === job.jobId)?.attempt).toBe(1);
});

test("signing grants are short-lived, proof-gated and do not persist wrapped authority", async ({ stack }) => {
  const { project, nodes } = await prepareE2eStage(stack);
  for (const poolKind of ["E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS"] as const) {
    const job = await claim(stack, requiredNode(nodes, poolKind));
    expect(job.jobKind).toBe("E2E_TEST");
    expect((await completeResponse(stack, job)).ok()).toBeTruthy();
  }
  await stack.waitForProject(project.id, value => value.workflowState === "SIGNING");

  const signingJob = await claim(stack, requiredNode(nodes, "E2E_MACOS"));
  expect(signingJob.jobKind).toBe("ARTIFACT_SIGN");

  const proofRequired = await stack.coreNode(`/v1/e2e/jobs/${signingJob.jobId}/signing-grant`, {
    method: "POST",
    data: { ...identity(signingJob), beforeReimageProof: "short" },
  });
  expect(proofRequired.status()).toBe(409);

  const grantResponse = await stack.coreNode(`/v1/e2e/jobs/${signingJob.jobId}/signing-grant`, {
    method: "POST",
    data: { ...identity(signingJob), beforeReimageProof: proof("before") },
  });
  expect(grantResponse.ok()).toBeTruthy();
  const grant = await grantResponse.json() as {
    grantId: string;
    wrappedToken: string;
    expiresAt: string;
    operationId: string;
  };
  expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());
  expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  expect(grant.wrappedToken.length).toBeGreaterThan(20);

  const completed = await completeResponse(stack, signingJob, {
    receipt: { grantId: grant.grantId, operationId: grant.operationId, signed: true },
  });
  expect(completed.ok()).toBeTruthy();

  const operations = await stack.queryRows<{ state: string; receipt: unknown }>(`
    SELECT state::text, receipt
      FROM deviludo.operation_receipts
     WHERE job_id = '${signingJob.jobId}'::uuid
  `);
  expect(operations).toHaveLength(1);
  expect(operations[0].state).toBe("RECEIPTED");
  expect(JSON.stringify(operations)).not.toContain(grant.wrappedToken);
});

test("job failure retries with a new fence and eventually fails the workflow", async ({ stack }) => {
  const { project, nodes } = await prepareE2eStage(stack);
  const queued = projectJob(await stack.readProject(project.id), "E2E_TEST", "macos");
  await stack.updateJob(queued.id, "two-attempts");

  const first = await claim(stack, requiredNode(nodes, "E2E_MACOS"));
  const firstFailure = await fail(stack, first, "deterministic executor failure");
  expect(firstFailure.ok()).toBeTruthy();
  await stack.waitForProject(project.id, value => value.jobs.some(job => job.id === first.jobId && job.state === "RETRY"));

  await stack.updateJob(first.jobId, "available");
  const second = await claim(stack, requiredNode(nodes, "E2E_MACOS"));
  expect(second.jobId).toBe(first.jobId);
  expect(second.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
  const terminalFailure = await fail(stack, second, "deterministic executor failure again");
  expect(terminalFailure.ok()).toBeTruthy();

  const failed = await stack.waitForProject(project.id, value => value.workflowState === "FAILED");
  const failedJob = failed.jobs.find(job => job.id === first.jobId);
  expect(failedJob).toMatchObject({ state: "FAILED", attempt: 2 });
  expect(failedJob?.lastError).toContain("again");

  const staleCompletion = await completeResponse(stack, first);
  expect(staleCompletion.status()).toBe(400);
});

test("the scheduler recovers an expired lease and increments fencing on the next claim", async ({ stack }) => {
  const { project, nodes } = await prepareE2eStage(stack);
  const mac = requiredNode(nodes, "E2E_MACOS");
  const first = await claim(stack, mac);
  await stack.updateJob(first.jobId, "expire");

  const recovered = await stack.waitForProject(project.id, value => value.jobs.some(job => (
    job.id === first.jobId && job.state === "RETRY" && job.lastError === "lease expired"
  )));
  expect(projectJob(recovered, "E2E_TEST", "macos").attempt).toBe(1);

  await stack.updateJob(first.jobId, "available");
  const reclaimed = await claim(stack, mac);
  expect(reclaimed.jobId).toBe(first.jobId);
  expect(reclaimed.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
  expect((await completeResponse(stack, reclaimed)).ok()).toBeTruthy();
});

test("development smoke routes verify tenant isolation and persist trusted macOS proofs", async ({ stack }) => {
  const nodes = await stack.registerFixedNodes();
  const isolation = await stack.coreWeb("/v1/dev/smoke/tenant-isolation", { method: "POST", data: {} });
  expect(isolation.ok()).toBeTruthy();
  expect(await isolation.json()).toMatchObject({
    passed: true,
    checks: {
      ownRead: true,
      crossTenantHidden: true,
      missingContextHidden: true,
      crossTenantWriteRejected: true,
    },
  });

  const ids = {
    tenantId: randomUUID(),
    projectId: randomUUID(),
    workflowId: randomUUID(),
    jobId: randomUUID(),
  };
  const invalid = await stack.coreWeb("/v1/dev/smoke/mac-e2e", {
    method: "POST",
    data: { ...ids, jobKind: "UNKNOWN" },
  });
  expect(invalid.status()).toBe(400);

  const created = await stack.coreWeb("/v1/dev/smoke/mac-e2e", {
    method: "POST",
    data: { ...ids, jobKind: "STEAM_CLEAN_INSTALL" },
  });
  expect(created.status()).toBe(201);
  const job = await claim(stack, requiredNode(nodes, "E2E_MACOS"));
  expect(job.jobId).toBe(ids.jobId);
  expect((await completeResponse(stack, job)).ok()).toBeTruthy();

  const status = await stack.coreWeb(`/v1/dev/smoke/mac-e2e/${ids.tenantId}/${ids.jobId}`);
  expect(status.ok()).toBeTruthy();
  expect(await status.json()).toMatchObject({
    job: {
      state: "SUCCEEDED",
      beforeReimageProof: proof("before"),
      cleanupProof: proof("cleanup"),
      afterReimageProof: proof("after"),
    },
  });
  const missing = await stack.coreWeb(`/v1/dev/smoke/mac-e2e/${ids.tenantId}/${randomUUID()}`);
  expect(missing.status()).toBe(404);
});

async function prepareE2eStage(stack: StackHarness): Promise<Readonly<{
  project: ProjectDetail;
  nodes: readonly NodeRecord[];
}>> {
  const nodes = await stack.registerFixedNodes();
  const project = await stack.createProject({
    name: "协议验证项目",
    concept: "用于验证三平台作业协议、租约和隔离证明的完整测试游戏。",
  });
  const approved = await stack.web(`/api/projects/${project.id}/approve`, { method: "POST", data: {} });
  expect(approved.status()).toBe(202);
  const staged = await stack.waitForProject(project.id, value => value.workflowState === "E2E_TESTING");
  return Object.freeze({ project: staged, nodes });
}

async function claimResponse(stack: StackHarness, node: NodeRecord): Promise<APIResponse> {
  return await stack.coreNode("/v1/e2e/jobs/claim", {
    method: "POST",
    data: { nodeId: node.id, poolKind: node.poolKind },
  });
}

async function claim(stack: StackHarness, node: NodeRecord): Promise<JobProtocolV3> {
  const response = await claimResponse(stack, node);
  expect(response.ok()).toBeTruthy();
  const job = (await response.json() as { job: JobProtocolV3 | null }).job;
  expect(job).not.toBeNull();
  return job as JobProtocolV3;
}

async function completeResponse(
  stack: StackHarness,
  job: JobProtocolV3,
  overrides: Readonly<{
    isolationGeneration?: number;
    receipt?: Readonly<Record<string, unknown>>;
    beforeReimageProof?: string;
    cleanupProof?: string;
    afterReimageProof?: string;
  }> = {},
): Promise<APIResponse> {
  return await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/complete`, {
    method: "POST",
    data: {
      ...identity(job),
      fencingToken: job.lease.fencingToken,
      isolationGeneration: overrides.isolationGeneration ?? job.isolationGeneration,
      receipt: overrides.receipt ?? { executor: "playwright-protocol-driver", succeeded: true },
      beforeReimageProof: Object.prototype.hasOwnProperty.call(overrides, "beforeReimageProof")
        ? overrides.beforeReimageProof
        : proof("before"),
      cleanupProof: Object.prototype.hasOwnProperty.call(overrides, "cleanupProof")
        ? overrides.cleanupProof
        : proof("cleanup"),
      afterReimageProof: Object.prototype.hasOwnProperty.call(overrides, "afterReimageProof")
        ? overrides.afterReimageProof
        : proof("after"),
    },
  });
}

async function fail(stack: StackHarness, job: JobProtocolV3, reason: string): Promise<APIResponse> {
  return await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/fail`, {
    method: "POST",
    data: { ...identity(job), reason },
  });
}

function identity(job: JobProtocolV3): Readonly<{ tenantId: string; leaseToken: string }> {
  return Object.freeze({ tenantId: job.tenantId, leaseToken: job.lease.token });
}

function proof(stage: string): string {
  return `playwright-trusted-${stage}-proof`;
}

function requiredNode(nodes: readonly NodeRecord[], poolKind: NodeRecord["poolKind"]): NodeRecord {
  const node = nodes.find(candidate => candidate.poolKind === poolKind);
  if (!node) throw new Error(`Missing ${poolKind} node`);
  return node;
}

function projectJob(project: ProjectDetail, kind: string, operatingSystem: string) {
  const job = project.jobs.find(candidate => candidate.kind === kind && candidate.targetOperatingSystem === operatingSystem);
  if (!job) throw new Error(`Missing ${kind}/${operatingSystem} job`);
  return job;
}
