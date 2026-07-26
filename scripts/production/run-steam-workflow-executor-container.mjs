#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runObservedService } from "../observability/run-service.mjs";

const FIXED_ENVIRONMENT = Object.freeze({
  NODE_ENV: "production",
  NODE_OPTIONS: "--enable-source-maps",
  NODE_PATH: "",
  HOME: "/nonexistent",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LD_LIBRARY_PATH: "",
  LD_PRELOAD: "",
  DEVILUDO_CONTAINER_KIND: "steam-workflow-executor",
  DEVILUDO_STEAM_EXECUTOR_NATIVE_EXECUTABLE: "/opt/deviludo/bin/native-steam-publisher",
  DEVILUDO_STEAM_EXECUTOR_NATIVE_CONFIG_FILE: "/opt/deviludo/config/native-steam-publisher.json",
  DEVILUDO_STEAM_EXECUTOR_WORK_ROOT: "/var/lib/deviludo/steam-publisher",
});

export function validateSteamWorkflowExecutorContainerEnvironment(env = process.env) {
  for (const [name, value] of Object.entries(FIXED_ENVIRONMENT)) {
    if (env[name] !== value) throw new Error("Steam workflow executor container process environment is not fixed");
  }
  for (const name of [
    "DEVILUDO_LOCAL_TEST_MODE",
    "DEVILUDO_LOCAL_DETERMINISTIC_WORKER_ATTESTATION",
    "DEVILUDO_LOCAL_AGENT_EXECUTION",
    "DEVILUDO_ALLOW_INSECURE_LOCAL_POSTGRES",
  ]) {
    if (env[name] !== undefined) throw new Error("Local authority is forbidden in a Steam workflow executor container");
  }
  return Object.freeze({ ...env });
}

export async function runSteamWorkflowExecutorContainer({
  argv = process.argv.slice(2),
  env = process.env,
  launch = runObservedService,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error("Steam workflow executor container arguments are forbidden");
  const trusted = validateSteamWorkflowExecutorContainerEnvironment(env);
  await launch(["steam-workflow-executor"], trusted);
  return "steam-workflow-executor";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSteamWorkflowExecutorContainer().catch(() => {
    process.stderr.write("[steam-workflow-executor-container] service startup failed\n");
    process.exitCode = 1;
  });
}
