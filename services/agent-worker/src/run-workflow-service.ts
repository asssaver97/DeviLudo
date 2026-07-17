import { pathToFileURL } from "node:url";
import { runWorkflowDestinationService } from "../../temporal/src/run-destination-service";
import { agentExecutionBrokerFromEnv } from "./execution-broker";
import { AgentWorkerWorkflowHandler } from "./workflow-handler";

export async function runAgentWorkerWorkflowService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const broker = await agentExecutionBrokerFromEnv(env);
  await runWorkflowDestinationService({
    destination: "agent-worker",
    env,
    createHandler: () => new AgentWorkerWorkflowHandler(broker),
    probes: [() => broker.probe()],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAgentWorkerWorkflowService();
}
