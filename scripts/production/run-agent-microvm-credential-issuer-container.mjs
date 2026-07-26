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
  DEVILUDO_CONTAINER_KIND: "agent-microvm-credential-issuer",
  DEVILUDO_GUEST_CREDENTIAL_ISSUER_WORK_ROOT: "/run/deviludo-credential-images",
  DEVILUDO_GUEST_CREDENTIAL_ISSUER_MKE2FS_EXECUTABLE: "/usr/sbin/mke2fs",
});

export function validateAgentMicrovmCredentialIssuerContainerEnvironment(env = process.env) {
  for (const [name, expected] of Object.entries(FIXED_ENVIRONMENT)) {
    if (env[name] !== expected) throw new Error("Agent microVM credential issuer container process environment is not fixed");
  }
  if (env.DEVILUDO_LOCAL_TEST_MODE !== undefined
    || env.DEVILUDO_LOCAL_DETERMINISTIC_WORKER_ATTESTATION !== undefined
    || env.DEVILUDO_LOCAL_AGENT_EXECUTION !== undefined) {
    throw new Error("Local test authority is forbidden in an Agent microVM credential issuer container");
  }
  return Object.freeze({ ...env });
}

export async function runAgentMicrovmCredentialIssuerContainer({
  argv = process.argv.slice(2),
  env = process.env,
  launch = runObservedService,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("Agent microVM credential issuer container arguments are forbidden");
  }
  const trusted = validateAgentMicrovmCredentialIssuerContainerEnvironment(env);
  await launch(["agent-microvm-credential-issuer"], trusted);
  return "agent-microvm-credential-issuer";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentMicrovmCredentialIssuerContainer().catch(() => {
    process.stderr.write("[agent-microvm-credential-issuer-container] service startup failed\n");
    process.exitCode = 1;
  });
}
