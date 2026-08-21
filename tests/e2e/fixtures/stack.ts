import { execFile } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  expect,
  test as base,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import type { ServerOperatingSystem, ServerPoolKind } from "../../../lib/runtime/server-pools";
import type { ProductJob, ProductProjectDetail } from "../../../lib/product/contracts";
import { loadE2eNodeConfig } from "../../../services/e2e-node/src/config";
import { runE2eNode } from "../../../services/e2e-node/src/runner";

const execute = promisify(execFile);
const root = process.cwd();
const webToken = process.env.DEVILUDO_WEB_CORE_TOKEN ?? "local-web-to-core-token-0000000000000001";
const nodeToken = process.env.DEVILUDO_E2E_NODE_TOKEN ?? "local-e2e-node-token";

export type ProjectDetail = ProductProjectDetail & Readonly<{ workspaceId: string }>;

export type JobRecord = ProductJob;

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
  { poolKind: "WEB", operatingSystem: "linux", capabilities: ["SELF_HOSTED_WEB", "STREAMING_BFF"] },
  {
    poolKind: "CORE",
    operatingSystem: "linux",
    capabilities: [
      "AUTOMATION_API", "WORKFLOW_SCHEDULER", "AGENT_GENERATION", "ARTIFACT_BUILD", "STEAM_PUBLISH",
      "RESTRICTED_CONTAINER", "NETWORK_POLICY",
    ],
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
    const runtimeImages = configuredRuntimeImages();
    await retryDatabaseReset(() => this.executeSql(`
      BEGIN;
      SET LOCAL lock_timeout = '5s';
      TRUNCATE TABLE
        deviludo.workspace_claim_fairness,
        deviludo.project_creation_receipts,
        deviludo.project_source_revisions,
        deviludo.instance_agent_settings,
        deviludo.operation_receipts,
        deviludo.external_signals,
        deviludo.jobs,
        deviludo.workflow_events,
        deviludo.workflow_instances,
        deviludo.agent_installations,
        deviludo.conversation_messages,
        deviludo.project_conversations,
        deviludo.projects,
        deviludo.workspaces,
        deviludo.server_nodes
      RESTART IDENTITY CASCADE;
      DELETE FROM deviludo.pool_capacity_intents WHERE reason <> 'P0_BASELINE';
      DELETE FROM deviludo.runtime_images;
      INSERT INTO deviludo.runtime_images(runtime_key, image_reference, release_version, verified_at)
      VALUES ${runtimeImages.map(([key, image]) => `('${key}', '${image}', 'e2e', clock_timestamp())`).join(",\n             ")};
      COMMIT;
    `));
    const publicKeyFile = process.env.DEVILUDO_CORE_EXECUTOR_PUBLIC_KEY_FILE ?? "";
    const publicKeyBase64 = Buffer.from(await readFile(publicKeyFile, "utf8")).toString("base64");
    await this.executeSql(`
      INSERT INTO deviludo.executor_identities(executor_id, identity_kind, public_key_pem)
      VALUES ('local-core-executor', 'CORE', convert_from(decode('${publicKeyBase64}', 'base64'), 'UTF8'))
      ON CONFLICT (executor_id) DO UPDATE SET public_key_pem = EXCLUDED.public_key_pem,
        enabled = true, updated_at = clock_timestamp();
    `);
    const instance = await this.web("/api/instance");
    expect(instance.ok(), await instance.text()).toBeTruthy();
    expect(await instance.json()).toMatchObject({ instance: { mode: "SELF_HOSTED", workspace: { name: "Local workspace" } } });
  }

  async web(path: string, options: FetchOptions = {}): Promise<APIResponse> {
    return await this.request.fetch(new URL(path, this.webUrl).href, options);
  }

  async coreWeb(path: string, options: FetchOptions = {}): Promise<APIResponse> {
    const storageState = await this.request.storageState();
    const csrfToken = storageState.cookies.find(cookie => cookie.name === "deviludo_csrf")?.value;
    return await this.request.fetch(new URL(path, this.coreUrl).href, {
      ...options,
      headers: {
        "x-deviludo-web-auth": webToken,
        "x-deviludo-origin-verified": "1",
        ...(csrfToken ? { "x-deviludo-csrf": csrfToken } : {}),
        ...options.headers,
      },
    });
  }

  async coreNode(path: string, options: FetchOptions = {}): Promise<APIResponse> {
    return await this.request.fetch(new URL(path, this.coreUrl).href, {
      ...options,
      headers: { "x-deviludo-node-auth": nodeToken, ...options.headers },
    });
  }

  async createProject(input: Readonly<{ name?: string; concept: string }>): Promise<ProjectDetail> {
    const name = input.name ?? input.concept.split(/[。！？.!?\n]/, 1)[0].trim().slice(0, 40);
    const response = await this.web("/api/projects", {
      method: "POST",
      data: { ...input, name },
      headers: { "idempotency-key": `e2e-project:${crypto.randomUUID()}` },
    });
    expect(response.status()).toBe(201);
    const body = await response.json() as { workspace: { id: string }; project: Omit<ProjectDetail, "workspaceId"> };
    return Object.freeze({ ...body.project, workspaceId: body.workspace.id });
  }

  async configureAgent(): Promise<void> {
    const response = await this.web("/api/settings/agent", {
      method: "PUT",
      data: {
        agentRuntime: "CLAUDE_CODE",
        baseUrl: "https://api.example.com",
        apiKey: "sk-e2e-instance-secret",
        primaryModel: "claude-primary",
        modelOverrides: { design: null, development: null, test: null },
        imageModel: null,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  async readProject(projectId: string): Promise<ProjectDetail> {
    const response = await this.web(`/api/projects/${projectId}`);
    expect(response.ok()).toBeTruthy();
    return (await response.json() as { project: ProjectDetail }).project;
  }

  async selectWorkspace(workspaceId: string): Promise<void> {
    const instance=await this.web("/api/instance");
    const body=await instance.json() as {instance:{workspace:{id:string}}};
    expect(body.instance.workspace.id).toBe(workspaceId);
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
      const created = await this.coreWeb("/v1/runtime/server-nodes", { method: "POST", data: definition });
      expect(created.status(), created.status() === 201 ? undefined : await created.text()).toBe(201);
      const node = (await created.json() as { node: NodeRecord }).node;
      const activated = await this.coreWeb(`/v1/runtime/server-nodes/${node.id}/activate`, {
        method: "POST",
        data: {},
      });
      expect(activated.ok()).toBeTruthy();
      nodes.push((await activated.json() as { node: NodeRecord }).node);
    }
    const identityKeyFile = process.env.DEVILUDO_E2E_IDENTITY_KEY_FILE ?? "";
    const publicKey = createPublicKey(await readFile(identityKeyFile, "utf8"))
      .export({ format: "pem", type: "spki" }).toString();
    const publicKeyBase64 = Buffer.from(publicKey).toString("base64");
    for (const node of nodes.filter(candidate => candidate.poolKind.startsWith("E2E_"))) {
      assertUuid(node.id);
      await this.executeSql(`
        INSERT INTO deviludo.executor_identities(executor_id, identity_kind, node_id, public_key_pem)
        VALUES ('${node.id}', 'E2E', '${node.id}'::uuid, convert_from(decode('${publicKeyBase64}', 'base64'), 'UTF8'))
        ON CONFLICT (executor_id) DO UPDATE SET public_key_pem = EXCLUDED.public_key_pem,
          node_id = EXCLUDED.node_id, enabled = true, updated_at = clock_timestamp();
      `);
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
        DEVILUDO_E2E_IDENTITY_KEY_FILE: process.env.DEVILUDO_E2E_IDENTITY_KEY_FILE,
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
  stack: async ({ request, context }, provide) => {
    const harness = new StackHarness(request);
    await harness.reset();
    const storageState = await request.storageState();
    await context.addCookies([
      ...storageState.cookies.filter(cookie => cookie.name !== "deviludo_locale"),
      // Browser journeys intentionally start in Chinese and verify the explicit
      // switch to English separately; never depend on a developer's locale.
      { name: "deviludo_locale", value: "zh", domain: harness.webUrl.hostname, path: "/", sameSite: "Lax" },
    ]);
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

async function retryDatabaseReset(operation: () => Promise<unknown>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try { await operation(); return; }
    catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/deadlock detected|lock timeout/i.test(message) || attempt === 5) throw error;
      await delay(attempt * 200);
    }
  }
  throw lastError;
}

function configuredRuntimeImages(): readonly (readonly [string, string])[] {
  const value: unknown = JSON.parse(process.env.DEVILUDO_RUNTIME_IMAGES_JSON ?? "null");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DEVILUDO_RUNTIME_IMAGES_JSON is required by the E2E harness");
  }
  const keys = [
    "AGENT_CLAUDE", "AGENT_CODEX", "GODOT_BUILDER", "STEAM_PUBLISHER",
    "E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS",
  ] as const;
  return Object.freeze(keys.map(key => {
    const image = (value as Record<string, unknown>)[key];
    if (typeof image !== "string" || !/^sha256:[0-9a-f]{64}$/.test(image)) {
      throw new Error(`Invalid E2E runtime image for ${key}`);
    }
    return Object.freeze([key, image] as const);
  }));
}
