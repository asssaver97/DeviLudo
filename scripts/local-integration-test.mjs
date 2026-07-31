import { randomUUID } from "node:crypto";

const webUrl = new URL(process.env.DEVILUDO_WEB_URL ?? "http://127.0.0.1:3100");
const coreUrl = new URL(process.env.DEVILUDO_CORE_API_URL ?? "http://127.0.0.1:8080");
await json(new URL("/api/health/live", webUrl));
await json(new URL("/health/live", coreUrl));
const current = await request("/api/session");
if (!current.session?.authenticated || current.session.authMode !== "STANDALONE"
  || !current.session.user?.instanceAdmin || current.session.canLogout !== false) {
  throw new Error("Local integration requires standalone anonymous administrator access");
}

const agent = await request("/api/settings/agent");
if (!agent.settings?.apiKeyConfigured) {
  const apiKey = process.env.DEVILUDO_LOCAL_TEST_API_KEY ?? "";
  const baseUrl = process.env.DEVILUDO_LOCAL_TEST_BASE_URL ?? "";
  const runtime = process.env.DEVILUDO_LOCAL_TEST_AGENT_RUNTIME ?? "CLAUDE_CODE";
  const model = process.env.DEVILUDO_LOCAL_TEST_MODEL ?? "";
  if (!apiKey || !baseUrl || (runtime === "CLAUDE_CODE" && !model)) {
    throw new Error("Configure Agent in Settings, or provide DEVILUDO_LOCAL_TEST_API_KEY, BASE_URL, AGENT_RUNTIME and MODEL");
  }
  await request("/api/settings/agent", { method: "PUT", body: {
    agentRuntime: runtime, baseUrl, apiKey,
    models: runtime === "CLAUDE_CODE" ? { primary: model, opus: model, sonnet: model, haiku: model, subagent: model } : null,
  } });
}

const pools = await request("/api/admin/server-pools");
if (pools.pools?.length !== 5 || !pools.pools.some(pool => pool.kind === "E2E_MACOS" && pool.readiness === "READY")) {
  throw new Error("Five fixed pools or the native macOS node are not ready");
}
const created = await request("/api/projects", {
  method: "POST", headers: { "idempotency-key": `local-real:${randomUUID()}` },
  body: { name: `本地真实链路 ${new Date().toISOString()}`, concept: "创建一个可无界面运行的 Godot 小游戏，通过确定性的输入完成一局并自动退出。" },
});
await request(`/api/projects/${created.project.id}/approve`, { method: "POST", body: {} });
const project = await waitForProject(created.project.id, 20 * 60_000);
for (const kind of ["AGENT_GENERATION", "ARTIFACT_BUILD", "E2E_TEST"]) {
  const job = project.jobs.find(candidate => candidate.kind === kind);
  if (!job || job.state !== "SUCCEEDED") throw new Error(`Real ${kind} stage did not succeed: ${JSON.stringify(project.jobs)}`);
}
console.log(JSON.stringify({ tested: true, projectId: project.id, workspaceId: created.workspace.id, workflowState: project.workflowState, stages: ["AGENT_GENERATION", "ARTIFACT_BUILD", "E2E_TEST"] }));

async function waitForProject(projectId, timeout) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = (await request(`/api/projects/${projectId}`)).project;
    if (latest.workflowState === "SUCCEEDED") return latest;
    if (["FAILED", "CANCELLED"].includes(latest.workflowState)) throw new Error(`Workflow stopped in ${latest.workflowState}: ${JSON.stringify(latest.jobs)}`);
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for real workflow: ${JSON.stringify(latest)}`);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", webUrl.origin);
  const response = await fetch(new URL(path, webUrl), {
    method: options.method ?? "GET", headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(70_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}
