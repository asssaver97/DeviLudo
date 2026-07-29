import { randomUUID } from "node:crypto";
import { startLocalE2e } from "./local-e2e-daemon.mjs";

const webUrl = process.env.DEVILUDO_WEB_URL ?? "http://127.0.0.1:3000";
const coreUrl = process.env.DEVILUDO_CORE_API_URL ?? "http://127.0.0.1:8080";
const webToken = process.env.DEVILUDO_WEB_CORE_TOKEN ?? "local-web-to-core-token-0000000000000001";

await assertOk(new URL("/api/health/live", webUrl), "Web liveness");
await assertOk(new URL("/health/live", coreUrl), "Core liveness");
const ready = await assertOk(new URL("/health/ready", coreUrl), "Core readiness");
if (ready.status !== "ready" || ready.pools.E2E_MACOS !== "READY") {
  throw new Error("Core readiness did not include the active macOS pool");
}
const pools = await assertOk(new URL("/api/admin/server-pools", webUrl), "Web BFF");
if (pools.pools.length !== 5) throw new Error("Web BFF did not return exactly five fixed pools");
const isolation = await coreRequest("/v1/dev/smoke/tenant-isolation", { method: "POST", body: "{}" });
if (!isolation.passed) throw new Error(`Tenant isolation smoke failed: ${JSON.stringify(isolation)}`);

await startLocalE2e();
const createdProduct = await webRequest("/api/projects", {
  method: "POST",
  body: JSON.stringify({
    name: "星舰故障夜班",
    concept: "一款双人合作的太空维修游戏，玩家需要在十五分钟内分工处理火灾、电力与导航故障。",
  }),
});
if (createdProduct.project?.workflowState !== "DRAFT") throw new Error("Product project did not start as a draft");
await webRequest(`/api/projects/${createdProduct.project.id}/approve`, { method: "POST", body: "{}" });
const progressedProduct = await waitForProductStage(createdProduct.project.id, 20_000);
if (!progressedProduct.jobs.some(job => job.kind === "AGENT_GENERATION" && job.state === "SUCCEEDED")
  || !progressedProduct.jobs.some(job => job.kind === "ARTIFACT_BUILD" && job.state === "SUCCEEDED")
  || !progressedProduct.jobs.some(job => job.kind === "E2E_TEST"
    && job.targetOperatingSystem === "macos" && job.state === "SUCCEEDED")) {
  throw new Error(`Product delivery did not execute Core and macOS stages: ${JSON.stringify(progressedProduct.jobs)}`);
}
const completedKinds = [];
for (const jobKind of ["E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL"]) {
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const workflowId = randomUUID();
  const jobId = randomUUID();
  await coreRequest("/v1/dev/smoke/mac-e2e", {
    method: "POST",
    body: JSON.stringify({ tenantId, projectId, workflowId, jobId, jobKind }),
  });
  const job = await waitForJob(tenantId, jobId, 20_000);
  if (job.state !== "SUCCEEDED"
    || !job.beforeReimageProof
    || !job.cleanupProof
    || !job.afterReimageProof) {
    throw new Error(`macOS ${jobKind} smoke failed its isolation contract: ${JSON.stringify(job)}`);
  }
  completedKinds.push(jobKind);
}
console.log(JSON.stringify({
  tested: true,
  web: "ok",
  core: "ok",
  fixedPools: 5,
  macJobs: completedKinds,
  productFlow: "PROJECT_TO_MAC_E2E",
  isolationProofs: 3,
  tenantIsolationChecks: 4,
}));

async function assertOk(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  return await response.json();
}

async function coreRequest(path, init = {}) {
  const response = await fetch(new URL(path, coreUrl), {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-deviludo-web-auth": webToken,
      ...init.headers,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Core smoke API returned ${response.status}: ${await response.text()}`);
  return await response.json();
}

async function webRequest(path, init = {}) {
  const response = await fetch(new URL(path, webUrl), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Web product API returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForProductStage(projectId, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await webRequest(`/api/projects/${projectId}`);
    const project = result.project;
    if (project?.jobs.some(job => job.kind === "E2E_TEST"
      && job.targetOperatingSystem === "macos" && job.state === "SUCCEEDED")) return project;
    if (["FAILED", "CANCELLED"].includes(project?.workflowState)) {
      throw new Error(`Product workflow stopped in ${project.workflowState}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the product project to reach macOS E2E");
}

async function waitForJob(tenantId, jobId, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await coreRequest(`/v1/dev/smoke/mac-e2e/${tenantId}/${jobId}`);
    if (["SUCCEEDED", "FAILED"].includes(result.job?.state)) return result.job;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the local macOS E2E smoke job");
}
