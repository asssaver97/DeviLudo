import { createHash, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { APIResponse } from "@playwright/test";
import {
  executorReceiptSigningPayload,
  type JobCompletion,
  type JobProtocolV4,
} from "../../../services/core/src/contracts";
import {
  StackHarness,
  test,
  expect,
  type NodeRecord,
  type ProjectDetail,
} from "../fixtures/stack";

test.describe.configure({ timeout: 180_000 });

const claimedExecutorIds = new Map<string, string>();
const cachedExecutorReceipts = new Map<string, JobCompletion["executorReceipt"]>();

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

  await stack.coreWeb(`/v1/runtime/server-nodes/${mac.id}/drain`, { method: "POST", data: {} });
  const drained = await claimResponse(stack, mac);
  expect(drained.status()).toBe(409);
  await stack.coreWeb(`/v1/runtime/server-nodes/${mac.id}/activate`, { method: "POST", data: {} });

  const job = await claim(stack, mac);
  expect(job.jobKind).toBe("E2E_PLATFORM_RUN");
  expect(job.exclusive).toBeTruthy();
  expect(job.targetOperatingSystem).toBe("macos");

  const duplicateClaim = await claimResponse(stack, mac);
  expect(duplicateClaim.ok()).toBeTruthy();
  expect((await duplicateClaim.json() as { job: unknown }).job).toBeNull();

  const badHeartbeat = await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/heartbeat`, {
    method: "POST",
    data: { workspaceId: job.workspaceId, leaseToken: randomUUID() },
  });
  expect(badHeartbeat.status()).toBe(400);
  const heartbeat = await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/heartbeat`, {
    method: "POST",
    data: identity(job),
  });
  expect(await heartbeat.json()).toEqual({ accepted: true });

  const retiredGrant = await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/signing-grant`, {
    method: "POST",
    data: identity(job),
  });
  expect(retiredGrant.status()).toBe(404);

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
  expect(completed.status(), await completed.text()).toBe(200);
  expect(await completed.json()).toEqual({ accepted: true });

  const replay = await completeResponse(stack, job);
  expect(replay.status()).toBe(400);
  const stored = await stack.waitForProject(project.id, value => value.jobs.some(item => item.id === job.jobId && item.state === "SUCCEEDED"));
  expect(stored.jobs.find(item => item.id === job.jobId)?.attempt).toBe(1);
});

test("validated E2E completion reaches release review without scheduling Steam publishing authority", async ({ stack }) => {
  const { project, nodes } = await prepareE2eStage(stack);
  for (const poolKind of ["E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS"] as const) {
    const job = await claim(stack, requiredNode(nodes, poolKind));
    expect(job.jobKind).toBe("E2E_PLATFORM_RUN");
    expect((await completeResponse(stack, job)).ok()).toBeTruthy();
  }
  await stack.waitForProject(project.id, value => value.workflowState === "RELEASE_APPROVAL_PENDING");

  const authorityRows = await stack.queryRows<{ publishing_jobs: number; operations: number }>(`
    SELECT
      (SELECT count(*)::int FROM deviludo.jobs
        WHERE workflow_id = '${project.workflowId}'::uuid AND kind = 'STEAM_PUBLISH') AS publishing_jobs,
      (SELECT count(*)::int FROM deviludo.operation_receipts
        WHERE workflow_id = '${project.workflowId}'::uuid) AS operations
  `);
  expect(authorityRows).toEqual([{ publishing_jobs: 0, operations: 0 }]);
  expect(JSON.stringify(await stack.readProject(project.id))).not.toContain("wrappedToken");
});

test("recoverable E2E infrastructure failure keeps retrying without sending product work to Development", async ({ stack }) => {
  const { project, nodes } = await prepareE2eStage(stack);
  const queued = projectJob(await stack.readProject(project.id), "E2E_PLATFORM_RUN", "macos");
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

  const waiting = await stack.waitForProject(project.id, value => value.jobs.some(job => (
    job.id === first.jobId && job.state === "RETRY" && job.attempt === 2
  )));
  expect(waiting.workflowState).toBe("TESTING");
  const retryingJob = waiting.jobs.find(job => job.id === first.jobId);
  expect(retryingJob).toMatchObject({ state: "RETRY", attempt: 2 });
  expect(retryingJob?.lastError).toContain("again");

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
  expect(projectJob(recovered, "E2E_PLATFORM_RUN", "macos").attempt).toBe(1);

  await stack.updateJob(first.jobId, "available");
  const reclaimed = await claim(stack, mac);
  expect(reclaimed.jobId).toBe(first.jobId);
  expect(reclaimed.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
  expect((await completeResponse(stack, reclaimed)).ok()).toBeTruthy();
});

async function prepareE2eStage(stack: StackHarness): Promise<Readonly<{
  project: ProjectDetail;
  nodes: readonly NodeRecord[];
}>> {
  await stack.configureAgent();
  const nodes = await stack.registerFixedNodes();
  const project = await stack.createProject({
    name: "协议验证项目",
    concept: "用于验证三平台作业协议、租约和隔离证明的完整测试游戏。",
  });
  const approved = await stack.web(`/api/projects/${project.id}/approve`, { method: "POST", data: {} });
  expect(approved.status()).toBe(202);
  const staged = await stack.waitForProject(project.id, value => value.workflowState === "TESTING", 120_000);
  return Object.freeze({ project: staged, nodes });
}

async function claimResponse(stack: StackHarness, node: NodeRecord): Promise<APIResponse> {
  return await stack.coreNode("/v1/e2e/jobs/claim", {
    method: "POST",
    data: { nodeId: node.id, poolKind: node.poolKind },
  });
}

async function claim(stack: StackHarness, node: NodeRecord): Promise<JobProtocolV4> {
  const response = await claimResponse(stack, node);
  expect(response.ok()).toBeTruthy();
  const job = (await response.json() as { job: JobProtocolV4 | null }).job;
  expect(job).not.toBeNull();
  claimedExecutorIds.set((job as JobProtocolV4).jobId, node.id);
  return job as JobProtocolV4;
}

async function completeResponse(
  stack: StackHarness,
  job: JobProtocolV4,
  overrides: Readonly<{
    isolationGeneration?: number;
    receipt?: Readonly<Record<string, unknown>>;
    beforeReimageProof?: string;
    cleanupProof?: string;
    afterReimageProof?: string;
  }> = {},
): Promise<APIResponse> {
  const executorId = claimedExecutorIds.get(job.jobId);
  if (!executorId) throw new Error(`Missing claimed executor identity for ${job.jobId}`);
  const identityKey = await readFile(process.env.DEVILUDO_E2E_IDENTITY_KEY_FILE ?? "", "utf8");
  let executorReceipt = cachedExecutorReceipts.get(job.jobId);
  if (!executorReceipt) {
    const regressionContractDigest = `sha256:${"c".repeat(64)}`;
    const outputDefinitions = job.jobKind === "E2E_PLATFORM_RUN" ? [
      {
        kind: "E2E_REPORT",
        content: Buffer.from(JSON.stringify({
          schemaVersion: "deviludo.playwright-protocol-output.v1",
          jobId: job.jobId,
          kind: "E2E_REPORT",
        })),
      },
      {
        kind: "E2E_REGRESSION",
        content: Buffer.from(JSON.stringify({
          schema: "deviludo.e2e-regression",
          contractDigest: regressionContractDigest,
          inputProfile: "KEYBOARD_MOUSE",
          estimatedDurationMs: 5_000,
          goal: "Complete the protocol fixture journey",
          actions: [{ type: "key_tap", key: "SPACE" }],
          successAssertions: [{ source: "PROGRESS", key: "turn", operator: "CHANGED" }],
        })),
      },
    ] : [{
      kind: job.jobKind === "BUILD" ? "SIGNED_BUILD" : "CLEAN_INSTALL_REPORT",
      content: Buffer.from(JSON.stringify({
        schemaVersion: "deviludo.playwright-protocol-output.v1",
        jobId: job.jobId,
        kind: job.jobKind,
      })),
    }];
    const outputObjects: JobProtocolV4["inputObjects"][number][] = [];
    for (const output of outputDefinitions) {
      const sha256 = `sha256:${createHash("sha256").update(output.content).digest("hex")}`;
      const authorization = await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/outputs`, {
        method: "POST",
        data: {
          ...identity(job),
          kind: output.kind,
          sha256,
          sizeBytes: output.content.length,
        },
      });
      if (!authorization.ok()) return authorization;
      const upload = await authorization.json() as {
        uploadUrl: string;
        requiredHeaders: Record<string, string>;
        object: JobProtocolV4["inputObjects"][number];
      };
      const uploaded = await fetch(upload.uploadUrl, {
        method: "PUT",
        body: new Uint8Array(output.content),
        headers: upload.requiredHeaders,
        signal: AbortSignal.timeout(120_000),
      });
      expect(uploaded.ok).toBeTruthy();
      outputObjects.push(Object.freeze({
        ...upload.object,
        ...(output.kind === "E2E_REGRESSION" ? {
          metadata: Object.freeze({
            e2eRegression: Object.freeze({
              regressionContractDigest,
              regressionInputProfile: "KEYBOARD_MOUSE",
              regressionEstimatedDurationMs: 5_000,
            }),
          }),
        } : {}),
      }));
    }
    const now = new Date().toISOString();
    const unsignedExecutorReceipt = {
      schemaVersion: "deviludo.executor-receipt.v2" as const,
      executorId,
      startedAt: now,
      finishedAt: now,
      exitCode: 0,
      simulated: false as const,
      outputObjects,
    };
    executorReceipt = {
      ...unsignedExecutorReceipt,
      signature: sign(null, executorReceiptSigningPayload(unsignedExecutorReceipt), identityKey).toString("base64url"),
    };
    // Invalid proof/fencing probes are rejected before object verification.
    // Do not reuse their uncommitted uploads for the later valid completion.
    if (Object.keys(overrides).length === 0) cachedExecutorReceipts.set(job.jobId, executorReceipt);
  }
  return await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/complete`, {
    method: "POST",
    data: {
      ...identity(job),
      fencingToken: job.lease.fencingToken,
      isolationGeneration: overrides.isolationGeneration ?? job.isolationGeneration,
      receipt: overrides.receipt ?? {
        executor: "playwright-protocol-driver",
        execution: {
          outcome: "PASSED",
          failureDomain: null,
          summary: "Playwright protocol completion passed",
          ...(job.jobKind === "E2E_PLATFORM_RUN" ? {
            evidence: {
              testManifestDigest: `sha256:${"d".repeat(64)}`,
              regressionContractDigest: `sha256:${"c".repeat(64)}`,
            },
          } : {}),
        },
      },
      executorReceipt,
      beforeReimageProof: Object.prototype.hasOwnProperty.call(overrides, "beforeReimageProof")
        ? overrides.beforeReimageProof
        : signedIsolationProof(job, "reimage", "before", identityKey),
      cleanupProof: Object.prototype.hasOwnProperty.call(overrides, "cleanupProof")
        ? overrides.cleanupProof
        : signedIsolationProof(job, "cleanup", "after", identityKey),
      afterReimageProof: Object.prototype.hasOwnProperty.call(overrides, "afterReimageProof")
        ? overrides.afterReimageProof
        : signedIsolationProof(job, "reimage", "after", identityKey),
    },
  });
}

async function fail(stack: StackHarness, job: JobProtocolV4, reason: string): Promise<APIResponse> {
  return await stack.coreNode(`/v1/e2e/jobs/${job.jobId}/fail`, {
    method: "POST",
    data: { ...identity(job), classification: "INFRASTRUCTURE", domain: "NODE", reason },
  });
}

function identity(job: JobProtocolV4): Readonly<{ workspaceId: string; leaseToken: string }> {
  return Object.freeze({ workspaceId: job.workspaceId, leaseToken: job.lease.token });
}

function signedIsolationProof(
  job: JobProtocolV4,
  action: "reimage" | "cleanup",
  stage: "before" | "after",
  identityKey: string,
): string {
  const evidence = `playwright-protocol:${action}:${stage}:${job.jobId}`;
  const payload = {
    schemaVersion: "deviludo.isolation-proof.v1",
    action,
    stage,
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    isolationGeneration: job.isolationGeneration,
    fencingToken: job.lease.fencingToken,
    evidenceSha256: `sha256:${createHash("sha256").update(evidence).digest("hex")}`,
  };
  const raw = Buffer.from(JSON.stringify(payload));
  return `${raw.toString("base64url")}.${sign(null, raw, identityKey).toString("base64url")}`;
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
