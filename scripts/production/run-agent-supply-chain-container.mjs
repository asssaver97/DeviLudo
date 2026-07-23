#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runObservedService } from "../observability/run-service.mjs";

export function validateAgentSupplyChainContainerEnvironment(env = process.env) {
  if (env.NODE_ENV !== "production" || env.DEVILUDO_CONTAINER_KIND !== "agent-supply-chain") {
    throw new Error("Agent supply-chain container requires its production image identity");
  }
  if (env.DEVILUDO_LOCAL_TEST_MODE !== undefined
    || env.DEVILUDO_LOCAL_DETERMINISTIC_WORKER_ATTESTATION !== undefined
    || env.DEVILUDO_LOCAL_AGENT_EXECUTION !== undefined) {
    throw new Error("Local test authority is forbidden in an Agent supply-chain container");
  }
  if (env.NODE_OPTIONS !== "--enable-source-maps" || env.NODE_PATH !== "" || env.HOME !== "/nonexistent"
    || env.PATH !== "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    || env.LD_LIBRARY_PATH !== "" || env.LD_PRELOAD !== "") {
    throw new Error("Agent supply-chain container process environment is not fixed");
  }
  return Object.freeze({ ...env });
}

export async function runAgentSupplyChainContainer({
  argv = process.argv.slice(2),
  env = process.env,
  launch = runObservedService,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error("Agent supply-chain container arguments are forbidden");
  const trusted = validateAgentSupplyChainContainerEnvironment(env);
  await launch(["agent-supply-chain"], trusted);
  return "agent-supply-chain";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentSupplyChainContainer().catch(() => {
    process.stderr.write("[agent-supply-chain-container] service startup failed\n");
    process.exitCode = 1;
  });
}
