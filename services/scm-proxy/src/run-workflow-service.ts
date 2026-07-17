import { pathToFileURL } from "node:url";
import { runWorkflowDestinationService } from "../../temporal/src/run-destination-service";
import { scmMergeBrokerFromEnv } from "./merge-broker";
import { ScmProxyWorkflowHandler } from "./workflow-handler";

export async function runScmProxyWorkflowService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const broker = await scmMergeBrokerFromEnv(env);
  await runWorkflowDestinationService({
    destination: "scm-proxy",
    env,
    createHandler: () => new ScmProxyWorkflowHandler(broker),
    probes: [() => broker.probe()],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runScmProxyWorkflowService();
}
