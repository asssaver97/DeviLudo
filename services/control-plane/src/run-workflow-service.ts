import { pathToFileURL } from "node:url";
import { runWorkflowDestinationService } from "../../temporal/src/run-destination-service";
import { PostgresControlPlaneWorkflowActionStore } from "./workflow-action-postgres";
import { ControlPlaneWorkflowHandler } from "./workflow-handler";

export async function runControlPlaneWorkflowService(): Promise<void> {
  await runWorkflowDestinationService({
    destination: "control-plane",
    createHandler: (pool) => new ControlPlaneWorkflowHandler(
      new PostgresControlPlaneWorkflowActionStore(pool),
    ),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runControlPlaneWorkflowService();
}
