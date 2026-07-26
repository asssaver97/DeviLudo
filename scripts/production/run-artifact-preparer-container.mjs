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
  DEVILUDO_CONTAINER_KIND: "artifact-preparer",
  DEVILUDO_ARTIFACT_PREPARER_WORK_ROOT: "/var/lib/deviludo/artifact-preparer-work",
});

export function validateArtifactPreparerContainerEnvironment(env = process.env) {
  for (const [name, value] of Object.entries(FIXED_ENVIRONMENT)) {
    if (env[name] !== value) throw new Error("Artifact Preparer container process environment is not fixed");
  }
  if (env.DEVILUDO_LOCAL_TEST_MODE !== undefined
    || env.DEVILUDO_LOCAL_DETERMINISTIC_WORKER_ATTESTATION !== undefined
    || env.DEVILUDO_LOCAL_AGENT_EXECUTION !== undefined) {
    throw new Error("Local test authority is forbidden in an Artifact Preparer container");
  }
  return Object.freeze({ ...env });
}

export async function runArtifactPreparerContainer({
  argv = process.argv.slice(2),
  env = process.env,
  launch = runObservedService,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error("Artifact Preparer container arguments are forbidden");
  const trusted = validateArtifactPreparerContainerEnvironment(env);
  await launch(["artifact-preparer"], trusted);
  return "artifact-preparer";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runArtifactPreparerContainer().catch(() => {
    process.stderr.write("[artifact-preparer-container] service startup failed\n");
    process.exitCode = 1;
  });
}
