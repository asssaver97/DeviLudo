import { loadCoreConfig } from "./config";
import { createDatabase } from "./database";
import { runApi } from "./api";
import { CoreRepository } from "./repository";
import { runSandbox } from "./sandbox";
import { runScheduler } from "./scheduler";

async function main(): Promise<void> {
  const config = loadCoreConfig();
  const database = createDatabase(config);
  const repository = new CoreRepository(database);
  const controller = new AbortController();
  for (const event of ["SIGINT", "SIGTERM"] as const) {
    process.once(event, () => controller.abort());
  }
  if (config.role === "api") return runApi(repository, database, config, controller.signal);
  try {
    if (config.role === "scheduler") await runScheduler(repository, config, controller.signal);
    else await runSandbox(repository, config, controller.signal);
  } finally {
    await database.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    level: "fatal",
    event: "core_start_failed",
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
