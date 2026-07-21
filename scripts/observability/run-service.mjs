import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startObservability } from "../../lib/observability/register.mjs";

export const SERVICE_ENTRYPOINTS = Object.freeze({
  "web": Object.freeze({ entry: "node_modules/vinext/dist/cli.js", fixedArgs: Object.freeze(["start"]) }),
  "control-plane": Object.freeze({ entry: "services/control-plane/src/main.ts" }),
  "agent-supply-chain": Object.freeze({ entry: "services/agent-supply-chain/src/run-service.ts" }),
  "agent-supply-chain-native": Object.freeze({ entry: "services/agent-supply-chain/src/run-native-policy.ts" }),
  "control-plane-workflow": Object.freeze({ entry: "services/control-plane/src/run-workflow-service.ts" }),
  "agent-worker-workflow": Object.freeze({ entry: "services/agent-worker/src/run-workflow-service.ts" }),
  "agent-configuration": Object.freeze({ entry: "services/agent-configuration/src/run-service.ts" }),
  "agent-execution-broker": Object.freeze({ entry: "services/agent-execution-broker/src/run-broker-service.ts" }),
  "agent-execution-worker": Object.freeze({ entry: "services/agent-execution-broker/src/run-native-worker-service.ts" }),
  "agent-microvm-guest": Object.freeze({ entry: "services/agent-execution-broker/src/run-native-microvm-guest-service.ts" }),
  "inference-gateway": Object.freeze({ entry: "services/inference-gateway/src/run-service.ts" }),
  "secret-broker": Object.freeze({ entry: "services/secret-broker/src/run-service.ts" }),
  "spec-dialogue": Object.freeze({ entry: "services/spec-dialogue/src/run-service.ts" }),
  "spec-workflow-bridge": Object.freeze({ entry: "services/spec-workflow-bridge/src/run-service.ts" }),
  "user-acceptance": Object.freeze({ entry: "services/user-acceptance/src/run-service.ts" }),
  "runner-control-workflow": Object.freeze({ entry: "services/runner-control/src/run-workflow-service.ts" }),
  "runner-ingress": Object.freeze({ entry: "services/runner-control/src/run-ingress-service.ts" }),
  "evidence-archive": Object.freeze({ entry: "services/evidence-archive/src/run-service.ts" }),
  "physical-runner": Object.freeze({ entry: "services/runner-control/src/run-physical-runner.ts" }),
  "godot-testkit": Object.freeze({ entry: "services/godot-testkit/src/run-cli.ts" }),
  "scm-proxy-workflow": Object.freeze({ entry: "services/scm-proxy/src/run-workflow-service.ts" }),
  "scm-candidate-broker": Object.freeze({ entry: "services/scm-proxy/src/run-candidate-publication-service.ts" }),
  "scm-merge-broker": Object.freeze({ entry: "services/scm-proxy/src/run-merge-service.ts" }),
  "github-authorization": Object.freeze({ entry: "services/scm-proxy/src/run-github-authorization-service.ts" }),
  "identity": Object.freeze({ entry: "services/identity/src/run-service.ts" }),
  "project-repository": Object.freeze({ entry: "services/scm-proxy/src/run-project-repository-service.ts" }),
  "source-snapshot": Object.freeze({ entry: "services/scm-proxy/src/run-source-snapshot-service.ts" }),
  "artifact-preparer": Object.freeze({ entry: "services/artifact-preparer/src/run-service.ts" }),
  "steam-publisher-workflow": Object.freeze({ entry: "services/steam-publisher/src/run-workflow-service.ts" }),
  "steam-approval-monitor": Object.freeze({ entry: "services/steam-approval-monitor/src/run-service.ts" }),
  "steam-access": Object.freeze({ entry: "services/steam-publisher/src/run-access-service.ts" }),
  "steam-secure-ui": Object.freeze({ entry: "services/steam-publisher/src/run-secure-ui-service.ts" }),
  "steam-workflow-broker": Object.freeze({ entry: "services/steam-publisher/src/run-workflow-broker-service.ts" }),
  "steam-workflow-executor": Object.freeze({ entry: "services/steam-publisher/src/run-workflow-executor-service.ts" }),
  "steam-client-connector": Object.freeze({ entry: "services/steam-client-connector/src/run-service.ts" }),
  "steam-install-services": Object.freeze({ entry: "services/steam-publisher/src/run-clean-install-services.ts" }),
  "temporal-worker": Object.freeze({ entry: "services/temporal/src/run-worker.ts" }),
  "delivery-projection": Object.freeze({ entry: "services/delivery-projection/src/run-service.ts" }),
  "local-runtime": Object.freeze({ entry: "services/local-runtime/src/server.ts" }),
  "local-agent-runtime": Object.freeze({ entry: "services/local-agent-runtime/src/server.ts" }),
  "local-spec-runtime": Object.freeze({ entry: "services/local-spec-runtime/src/server.ts" }),
});

export async function runObservedService(argv = process.argv.slice(2), env = process.env) {
  const [service, ...targetArgs] = argv;
  const descriptor = service ? SERVICE_ENTRYPOINTS[service] : undefined;
  if (!descriptor) throw new Error("Observed service name is invalid");
  if (targetArgs.some((value) => value.length > 4_096 || /[\0\r\n]/.test(value))) {
    throw new Error("Observed service argument is invalid");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const entry = resolve(root, descriptor.entry);
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string") throw new Error("Platform version is invalid");
  const originalArgv = process.argv;
  process.argv = [process.execPath, entry, ...(descriptor.fixedArgs ?? []), ...targetArgs];
  const telemetry = await startObservability(service, packageJson.version, env);
  const lifecycle = installTelemetryLifecycle(telemetry);
  try { await import(pathToFileURL(entry).href); }
  catch (error) {
    await lifecycle.shutdownNow();
    throw error;
  }
  finally {
    process.argv = originalArgv;
  }
}

export function installTelemetryLifecycle(telemetry, target = process) {
  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ??= telemetry.shutdown().catch(() => {
      target.exitCode = 1;
      console.error("[observability] shutdown failed");
    });
    return shutdownPromise;
  };
  const beforeExit = () => { void shutdown(); };
  target.once("beforeExit", beforeExit);
  return Object.freeze({
    async shutdownNow() {
      target.removeListener("beforeExit", beforeExit);
      await shutdown();
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runObservedService();
}
