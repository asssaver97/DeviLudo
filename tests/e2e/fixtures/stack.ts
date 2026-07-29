import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  expect,
  test as base,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import type { ServerOperatingSystem, ServerPoolKind } from "../../../lib/runtime/server-pools";
import { loadE2eNodeConfig } from "../../../services/e2e-node/src/config";
import { runE2eNode } from "../../../services/e2e-node/src/runner";

const execute = promisify(execFile);
const root = process.cwd();
const webToken = process.env.DEVILUDO_WEB_CORE_TOKEN ?? "local-web-to-core-token-0000000000000001";
const nodeToken = process.env.DEVILUDO_E2E_NODE_TOKEN ?? "local-e2e-node-token";

export type ProjectDetail = Readonly<{
  id: string;
  name: string;
  concept: string;
  workflowId: string;
  workflowState: string;
  specification: Readonly<Record<string, unknown>>;
  jobs: readonly JobRecord[];
  events: readonly Readonly<{ id: string; kind: string; data: Readonly<Record<string, unknown>> }>[];
}>;

export type JobRecord = Readonly<{
  id: string;
  kind: string;
  poolKind: string;
  targetOperatingSystem: string | null;
  state: string;
  attempt: number;
  lastError: string | null;
}>;

export type NodeRecord = Readonly<{
  id: string;
  poolKind: ServerPoolKind;
  operatingSystem: ServerOperatingSystem;
  state: string;
  capabilities: readonly string[];
}>;

type FetchOptions = NonNullable<Parameters<APIRequestContext["fetch"]>[1]>;

const NODE_DEFINITIONS: readonly Readonly<{
  poolKind: ServerPoolKind;
  operatingSystem: ServerOperatingSystem;
  capabilities: readonly string[];
}>[] = Object.freeze([
  { poolKind: "WEB", operatingSystem: "linux", capabilities: ["CUSTOMER_WEB", "STREAMING_BFF"] },
  {
    poolKind: "CORE",
    operatingSystem: "linux",
    capabilities: ["BUSINESS_API", "WORKFLOW_SCHEDULER", "AGENT_GENERATION", "ARTIFACT_BUILD", "STEAM_PUBLISH"],
  },
  { poolKind: "E2E_LINUX", operatingSystem: "linux", capabilities: ["E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL"] },
  { poolKind: "E2E_WINDOWS", operatingSystem: "windows", capabilities: ["E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL"] },
  { poolKind: "E2E_MACOS", operatingSystem: "macos", capabilities: ["E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL"] },
]);

export class StackHarness {
  readonly webUrl = requiredUrl("DEVILUDO_E2E_WEB_URL");
  readonly coreUrl = requiredUrl("DEVILUDO_E2E_CORE_URL");
  readonly projectName = requiredProjectName();
  private readonly nodeControllers: AbortController[] = [];
  private readonly nodeRuns: Promise<void>[] = [];

  constructor(private readonly request: APIRequestContext) {}

  get apiRequest(): APIRequestContext {
    return this.request;
  }

  async reset(): Promise<void> {
    await this.stopLogicalNodes();
    await this.executeSql(`
      SET lock_timeout = '5s';
      TRUNCATE TABLE
        deviludo.tenant_claim_fairness,
        deviludo.operation_receipts,
        deviludo.external_signals,
        deviludo.jobs,
        deviludo.workflow_events,
        deviludo.workflow_instances,
        deviludo.agent_installations,
        deviludo.conversation_messages,
        deviludo.project_conversations,
        deviludo.projects,
        deviludo.tenants,
        deviludo.server_nodes
      RESTART IDENTITY CASCADE;
      DELETE FROM deviludo.pool_capacity_intents WHERE reason <> 'P0_BASELINE';
    `);
  }

  async web(path: string, options: FetchOptions = {}): Promise<APIResponse> {
    return await this.request.fetch(new URL(path, this.webUrl).href, options);
  }

  async coreWeb(path: string, options: FetchOptions = {}): Promise<APIResponse> {
    return await this.request.fetch(new URL(path, this.coreUrl).href, {
      ...options,
      headers: { "x-deviludo-web-auth": webToken, ...options.headers },
    });
  }

  async coreNode(path: string, options: FetchOptions = {}): Promise<APIResponse> {
    return await this.request.fetch(new URL(path, this.coreUrl).href, {
      ...options,
      headers: { "x-deviludo-node-auth": nodeToken, ...options.headers },
    });
  }

  async createProject(input: Readonly<{ name?: string; concept: string }>): Promise<ProjectDetail> {
    const response = await this.web("/api/projects", { method: "POST", data: input });
    expect(response.status()).toBe(201);
    return (await response.json() as { project: ProjectDetail }).project;
  }

  async readProject(projectId: string): Promise<ProjectDetail> {
    const response = await this.web(`/api/projects/${projectId}`);
    expect(response.ok()).toBeTruthy();
    return (await response.json() as { project: ProjectDetail }).project;
  }

  async waitForProject(
    projectId: string,
    predicate: (project: ProjectDetail) => boolean,
    timeoutMilliseconds = 30_000,
  ): Promise<ProjectDetail> {
    const deadline = Date.now() + timeoutMilliseconds;
    let latest: ProjectDetail | null = null;
    while (Date.now() < deadline) {
      latest = await this.readProject(projectId);
      if (predicate(latest)) return latest;
      await delay(100);
    }
    throw new Error(`Timed out waiting for project ${projectId}: ${JSON.stringify(latest)}`);
  }

  async registerFixedNodes(): Promise<readonly NodeRecord[]> {
    const nodes: NodeRecord[] = [];
    for (const definition of NODE_DEFINITIONS) {
      const created = await this.coreWeb("/v1/admin/server-nodes", { method: "POST", data: definition });
      expect(created.status()).toBe(201);
      const node = (await created.json() as { node: NodeRecord }).node;
      const activated = await this.coreWeb(`/v1/admin/server-nodes/${node.id}/activate`, {
        method: "POST",
        data: {},
      });
      expect(activated.ok()).toBeTruthy();
      nodes.push((await activated.json() as { node: NodeRecord }).node);
    }
    return Object.freeze(nodes);
  }

  async startLogicalNodes(nodes: readonly NodeRecord[]): Promise<void> {
    for (const node of nodes.filter(candidate => candidate.poolKind.startsWith("E2E_"))) {
      const controller = new AbortController();
      const config = loadE2eNodeConfig({
        NODE_ENV: "test",
        DEVILUDO_E2E_NODE_ID: node.id,
        DEVILUDO_E2E_POOL_KIND: node.poolKind,
        DEVILUDO_E2E_OPERATING_SYSTEM_OVERRIDE: node.operatingSystem,
        DEVILUDO_CORE_API_URL: this.coreUrl.href,
        DEVILUDO_E2E_NODE_TOKEN: nodeToken,
        DEVILUDO_E2E_POLL_MS: "100",
      });
      this.nodeControllers.push(controller);
      this.nodeRuns.push(runE2eNode(config, controller.signal));
    }
    await delay(50);
  }

  async stopLogicalNodes(): Promise<void> {
    for (const controller of this.nodeControllers.splice(0)) controller.abort();
    const runs = this.nodeRuns.splice(0);
    if (!runs.length) return;
    await Promise.race([
      Promise.allSettled(runs),
      delay(12_000).then(() => { throw new Error("Logical E2E nodes did not stop"); }),
    ]);
  }

  async executeSql(statement: string): Promise<string> {
    const result = await execute("docker", [
      ...this.composeArgs(),
      "exec", "-T", "postgres",
      "psql", "-v", "ON_ERROR_STOP=1", "-U", "deviludo", "-d", "deviludo",
      "-c", statement,
    ], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    return result.stdout;
  }

  async queryRows<T>(selectStatement: string): Promise<readonly T[]> {
    if (!/^\s*SELECT\b/i.test(selectStatement)) throw new Error("E2E queryRows only accepts SELECT statements");
    const wrapped = `SELECT coalesce(json_agg(row_to_json(result)), '[]'::json) FROM (${selectStatement}) result;`;
    const result = await execute("docker", [
      ...this.composeArgs(),
      "exec", "-T", "postgres",
      "psql", "-v", "ON_ERROR_STOP=1", "-At", "-U", "deviludo", "-d", "deviludo",
      "-c", wrapped,
    ], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(result.stdout.trim() || "[]") as T[];
  }

  async updateJob(jobId: string, assignment: "expire" | "available" | "two-attempts"): Promise<void> {
    assertUuid(jobId);
    const update = assignment === "expire"
      ? "lease_expires_at = clock_timestamp() - interval '1 second'"
      : assignment === "available"
        ? "available_at = clock_timestamp()"
        : "max_attempts = 2";
    await this.executeSql(`UPDATE deviludo.jobs SET ${update} WHERE id = '${jobId}'::uuid;`);
  }

  async service(action: "start" | "stop", service: "core-api"): Promise<void> {
    await execute("docker", [...this.composeArgs(), action, service], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (action === "start") await this.waitForCore();
  }

  async waitForCore(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(new URL("/health/live", this.coreUrl), {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return;
      } catch { /* still starting */ }
      await delay(200);
    }
    throw new Error("Core API did not become healthy");
  }

  private composeArgs(): string[] {
    return [
      "compose", "--project-name", this.projectName,
      "-f", "infra/docker-compose.yml",
      "-f", "infra/docker-compose.e2e.yml",
    ];
  }
}

export const test = base.extend<{ stack: StackHarness }>({
  stack: async ({ request }, provide) => {
    const harness = new StackHarness(request);
    await harness.reset();
    try {
      await provide(harness);
    } finally {
      await harness.stopLogicalNodes();
    }
  },
});

export { expect };

function requiredUrl(name: "DEVILUDO_E2E_WEB_URL" | "DEVILUDO_E2E_CORE_URL"): URL {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run E2E through npm run test:e2e`);
  return new URL(value);
}

function requiredProjectName(): string {
  const value = process.env.DEVILUDO_E2E_PROJECT_NAME ?? "";
  if (!/^deviludo-e2e-[a-z0-9-]+$/.test(value)) {
    throw new Error("Refusing to control a Compose project outside the isolated E2E namespace");
  }
  return value;
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) throw new Error("Unsafe job identifier");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
