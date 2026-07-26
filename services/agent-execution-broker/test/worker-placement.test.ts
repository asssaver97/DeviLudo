import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { PostgresAgentExecutionDispatch } from "../src/postgres-dispatch";
import { AgentExecutionOperationProcessor } from "../src/worker-host";
import {
  agentExecutionWorkerBindingFromEnv,
  assertAgentExecutionWorkerGuestBinding,
  parseAgentExecutionWorkerBinding,
  type AgentExecutionWorkerBinding,
} from "../src/worker-binding";

const tenantId = "11111111-1111-4111-8111-111111111111";
const runId = "33333333-3333-4333-8333-333333333333";

function binding(overrides: Record<string, unknown> = {}): AgentExecutionWorkerBinding {
  return parseAgentExecutionWorkerBinding({
    schemaVersion: "deviludo.agent-execution-worker-binding.v1",
    workerPool: "development-linux-primary",
    installationIds: ["claude-code-installation-2-1-14"],
    agent: "claude-code",
    exactAgentVersion: "2.1.14",
    adapterVersion: "1.3.0",
    workerImageDigest: `sha256:${"c".repeat(64)}`,
    ...overrides,
  });
}

test("Worker placement binding is immutable, sorted and equal to the signed Guest identity", async () => {
  const expected = binding();
  assert.deepEqual(assertAgentExecutionWorkerGuestBinding(expected, {
    agent: expected.agent, exactAgentVersion: expected.exactAgentVersion,
    adapterVersion: expected.adapterVersion, workerImageDigest: expected.workerImageDigest,
  }), expected);
  assert.throws(() => binding({ installationIds: ["installation-z", "installation-a"] }), /binding is invalid/);
  assert.throws(() => binding({ exactAgentVersion: "latest" }), /binding is invalid/);
  assert.throws(() => assertAgentExecutionWorkerGuestBinding(expected, {
    agent: "codex-cli", exactAgentVersion: "0.91.0", adapterVersion: "1.2.2",
    workerImageDigest: expected.workerImageDigest,
  }), /binding is invalid/);

  const root = await mkdtemp(join(tmpdir(), "deviludo-worker-binding-"));
  const path = join(root, "worker-binding.json");
  const bytes = Buffer.from(`${JSON.stringify(expected)}\n`);
  await writeFile(path, bytes, { mode: 0o400 });
  const env = {
    DEVILUDO_AGENT_EXECUTION_WORKER_BINDING_FILE: path,
    DEVILUDO_AGENT_EXECUTION_WORKER_BINDING_DIGEST: createHash("sha256").update(bytes).digest("hex"),
  };
  assert.deepEqual(await agentExecutionWorkerBindingFromEnv(env), expected);
  await chmod(path, 0o620);
  await assert.rejects(agentExecutionWorkerBindingFromEnv(env), /binding is invalid/);
});

test("PostgreSQL dispatch selects only the effective primary or failover placement", async () => {
  const expected = binding();
  let selectedSql = ""; let selectedParameters: readonly unknown[] = [];
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) {
      if (sql.includes("FROM deviludo.agent_execution_operations operation")) {
        selectedSql = sql; selectedParameters = parameters ?? [];
        return { rowCount: 1, rows: [{
          tenant_id: tenantId, run_id: runId,
          effective_installation_id: expected.installationIds[0], effective_worker_pool: expected.workerPool,
          effective_image_digest: expected.workerImageDigest, effective_agent_version: expected.exactAgentVersion,
          effective_adapter_version: expected.adapterVersion, effective_agent: expected.agent,
        } as unknown as Row] };
      }
      return { rowCount: 0, rows: [] as Row[] };
    },
    release() {},
  };
  const source = new PostgresAgentExecutionDispatch({ async connect() { return client; } });
  assert.deepEqual(await source.next(tenantId, expected), { tenantId, runId });
  assert.match(selectedSql, /LEFT JOIN deviludo\.agent_run_provider_failovers failover/);
  assert.match(selectedSql, /configuration_lock->'fallback'->>'installationId'/);
  assert.match(selectedSql, /effective_agent/);
  assert.match(selectedSql, /FOR UPDATE SKIP LOCKED LIMIT 1/);
  assert.deepEqual(selectedParameters, [tenantId, expected.installationIds, expected.workerPool,
    expected.workerImageDigest, expected.exactAgentVersion, expected.adapterVersion, expected.agent]);
});

test("dispatch and processor fail closed if the database or source returns another Installation", async () => {
  const expected = binding();
  const client: PostgresWorkflowClient = {
    async query<Row extends Record<string, unknown>>(sql: string) {
      if (sql.includes("FROM deviludo.agent_execution_operations operation")) return { rowCount: 1, rows: [{
        tenant_id: tenantId, run_id: runId, effective_installation_id: "codex-installation-0-91-0",
        effective_worker_pool: expected.workerPool, effective_image_digest: expected.workerImageDigest,
        effective_agent_version: expected.exactAgentVersion, effective_adapter_version: expected.adapterVersion,
        effective_agent: expected.agent,
      } as unknown as Row] };
      return { rowCount: 0, rows: [] as Row[] };
    },
    release() {},
  };
  await assert.rejects(new PostgresAgentExecutionDispatch({ async connect() { return client; } }).next(tenantId, expected),
    /dispatch is invalid/);

  let executed = false; let observed: AgentExecutionWorkerBinding | null = null;
  const processor = new AgentExecutionOperationProcessor({
    async next(_tenantId, placement) { observed = placement; return null; }, async probe() {},
  }, {
    async execute() { executed = true; return null; }, async probe() {},
  }, expected);
  assert.equal(await processor.processOne(tenantId), "IDLE");
  assert.deepEqual(observed, expected); assert.equal(executed, false);
});
