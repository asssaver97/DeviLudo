import { pathToFileURL } from "node:url";
import { runWorkflowDestinationService } from "../../temporal/src/run-destination-service";
import { postgresRunnerWorkflowFromEnv } from "./postgres-workflow";
import { RunnerControlWorkflowHandler } from "./workflow-handler";

export async function runRunnerControlWorkflowService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  await runWorkflowDestinationService({
    destination: "runner-control",
    env,
    createHandler: (pool) => new RunnerControlWorkflowHandler(postgresRunnerWorkflowFromEnv(pool, env)),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRunnerControlWorkflowService();
}
