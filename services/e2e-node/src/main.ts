import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadE2eNodeConfig } from "./config";
import { runE2eNode } from "./runner";

async function main(): Promise<void> {
  const config = loadE2eNodeConfig();
  const controller = new AbortController();
  for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => controller.abort());
  await runE2eNode(config, controller.signal);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(JSON.stringify({
      level: "fatal",
      event: "e2e_node_start_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
