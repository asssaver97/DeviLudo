import { pathToFileURL } from "node:url";
import { ephemeralRunTokenSecretStoreFromEnv } from "./ephemeral-secret-client";
import { verifyAgentExecutionWorkerNativeRuntime } from "./native-worker-release";
import { nativeAgentExecutionWorkerFromEnv } from "./run-native-worker";

export async function runNativeAgentExecutionWorkerService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  await verifyAgentExecutionWorkerNativeRuntime(env);
  const secrets = await ephemeralRunTokenSecretStoreFromEnv(env);
  const runtime = await nativeAgentExecutionWorkerFromEnv(secrets, env);
  const shutdown = new AbortController(); const stop = () => shutdown.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await runtime.host.run(shutdown.signal); }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await runtime.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runNativeAgentExecutionWorkerService().catch(() => { process.stderr.write(`${JSON.stringify({
    service: "deviludo-agent-execution-worker", event: "FAILED" })}\n`); process.exitCode = 1; });
}
