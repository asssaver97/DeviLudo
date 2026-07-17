import { pathToFileURL } from "node:url";
import { runWorkflowDestinationService } from "../../temporal/src/run-destination-service";
import { steamWorkflowBrokerFromEnv } from "./workflow-broker";
import { SteamPublisherWorkflowHandler } from "./workflow-handler";

export async function runSteamPublisherWorkflowService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const broker = await steamWorkflowBrokerFromEnv(env);
  await runWorkflowDestinationService({
    destination: "steam-publisher",
    env,
    createHandler: () => new SteamPublisherWorkflowHandler(broker, broker),
    probes: [() => broker.probe()],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSteamPublisherWorkflowService();
}
