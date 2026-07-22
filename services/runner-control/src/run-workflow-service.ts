import { pathToFileURL } from "node:url";
import { runWorkflowDestinationService } from "../../temporal/src/run-destination-service";
import { runnerArtifactPreparationClientFromEnv } from "./artifact-preparation-client";
import { runnerSteamInstallPreparationClientFromEnv } from "./steam-install-preparation-client";
import { postgresRunnerWorkflowFromEnv } from "./postgres-workflow";
import { RunnerControlWorkflowHandler } from "./workflow-handler";

export async function runRunnerControlWorkflowService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  await runWorkflowDestinationService({
    destination: "runner-control",
    env,
    createHandler: async (pool) => {
      const runner = postgresRunnerWorkflowFromEnv(pool, env);
      const artifacts = await runnerArtifactPreparationClientFromEnv(env);
      const steamInstalls = await runnerSteamInstallPreparationClientFromEnv(env);
      return new RunnerControlWorkflowHandler(runner, artifacts, steamInstalls, {
        readiness: [runner, artifacts, steamInstalls],
      });
    },
    createReadinessProbes: ({ handler }) => {
      if (!(handler instanceof RunnerControlWorkflowHandler)) {
        throw new Error("Runner workflow handler readiness binding is invalid");
      }
      return [() => handler.probe()];
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRunnerControlWorkflowService();
}
