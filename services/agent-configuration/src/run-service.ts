import { pathToFileURL } from "node:url";
import { PostgresWorkflowActionCompletionStore } from "../../control-plane/src/workflow-action-completion-postgres";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { workflowAssignmentSourceFromEnv } from "../../temporal/src/tenant-assignments";
import { PostgresAgentConfigurationStore } from "./postgres-store";
import { AgentConfigurationService } from "./service";
import { sourceBaselineClientFromEnv } from "./source-baseline-client";
import { AgentConfigurationWorker } from "./worker";

export async function agentConfigurationRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "agent-configuration" });
  try {
    const baselines = await sourceBaselineClientFromEnv(env);
    const store = new PostgresAgentConfigurationStore(pool);
    const service = new AgentConfigurationService(
      store,
      baselines,
      new PostgresWorkflowActionCompletionStore(pool),
    );
    const assignments = workflowAssignmentSourceFromEnv(env);
    const worker = new AgentConfigurationWorker(
      service,
      assignments,
      integer(env.DEVILUDO_AGENT_CONFIGURATION_POLL_INTERVAL_MS, 1_000, 100, 60_000),
      (diagnostic) => process.stderr.write(`${JSON.stringify(diagnostic)}\n`),
    );
    return Object.freeze({ pool, baselines, store, service, assignments, worker });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runAgentConfigurationService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await agentConfigurationRuntimeFromEnv(env);
  try {
    await Promise.all([
      runtime.pool.probe(),
      runtime.service.probe(),
      runtime.assignments.listTenantIds("control-plane").then(() => undefined),
    ]);
    runtime.worker.start();
    console.log("[agent-configuration] READY");
    await waitForShutdown();
  } finally {
    await runtime.worker.stop().catch(() => undefined);
    await runtime.pool.close().catch(() => undefined);
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const close = () => resolve();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const selected = Number.parseInt(value, 10);
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum || String(selected) !== value) {
    throw new Error("Agent configuration numeric setting is invalid");
  }
  return selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAgentConfigurationService();
}
