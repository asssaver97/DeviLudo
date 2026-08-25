import { createLocalHostServices, type CoreHostServices } from "./access";
import { runApi } from "./api";
import { loadCoreConfig, type CoreConfig } from "./config";
import { createDatabase } from "./database";
import { CoreRepository } from "./repository";
import { runSandbox } from "./sandbox";
import { runScheduler } from "./scheduler";

export type StartCoreOptions = Readonly<{
  config?: CoreConfig;
  signal?: AbortSignal;
}>;

/** Public composition root used by both the local executable and managed hosts. */
export async function startCore(
  hostServices: CoreHostServices = createLocalHostServices(),
  options: StartCoreOptions = {},
): Promise<void> {
  const config = options.config ?? loadCoreConfig();
  const database = createDatabase(config);
  const repository = new CoreRepository(database);
  const localController = options.signal ? null : new AbortController();
  const signal = options.signal ?? localController!.signal;
  const stop = () => localController?.abort();
  if (localController) {
    for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, stop);
  }
  try {
    if (config.role === "api") {
      await runApi(repository, database, config, signal, undefined, undefined, hostServices);
    } else if (config.role === "scheduler") {
      await runScheduler(repository, config, signal, hostServices);
    } else {
      const baseWorkerId = process.env.DEVILUDO_SANDBOX_ID ?? `sandbox-${process.pid}`;
      await Promise.all(Array.from({ length: config.sandboxConcurrency }, (_, index) => (
        runSandbox(repository, config, signal, undefined, `${baseWorkerId}-${index + 1}`, hostServices)
      )));
    }
  } finally {
    if (localController) {
      for (const event of ["SIGINT", "SIGTERM"] as const) process.removeListener(event, stop);
    }
    await database.close();
  }
}
