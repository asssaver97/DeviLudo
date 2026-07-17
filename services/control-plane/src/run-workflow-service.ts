import { pathToFileURL } from "node:url";
import { runWorkflowDestinationService } from "../../temporal/src/run-destination-service";
import { PostgresControlPlaneWorkflowActionStore } from "./workflow-action-postgres";
import { ControlPlaneWorkflowHandler } from "./workflow-handler";
import { PostgresWorkflowSignalOutbox, WorkflowSignalOutboxProcessor } from "./workflow-signal-outbox";
import {
  authorizeWorkflowActionCompletionTls,
  registerWorkflowActionCompletionRoute,
  workflowCompletionSourceMapFromEnv,
} from "./workflow-action-completion-http";
import { PostgresWorkflowActionCompletionStore } from "./workflow-action-completion-postgres";

export async function runControlPlaneWorkflowService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  await runWorkflowDestinationService({
    destination: "control-plane",
    env,
    createHandler: (pool) => new ControlPlaneWorkflowHandler(
      new PostgresControlPlaneWorkflowActionStore(pool),
    ),
    configureServer: (server, pool, serviceEnv) => {
      const sources = workflowCompletionSourceMapFromEnv(serviceEnv);
      registerWorkflowActionCompletionRoute(server, {
        store: new PostgresWorkflowActionCompletionStore(pool),
        authorize: (request) => authorizeWorkflowActionCompletionTls(request, sources),
      });
    },
    createAuxiliaryProcessors: (pool, signals, workerId) => [
      new WorkflowSignalOutboxProcessor(
        new PostgresWorkflowSignalOutbox(pool),
        signals,
        `${workerId}:signal-outbox`,
      ),
    ],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runControlPlaneWorkflowService();
}
