#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runObservedService, SERVICE_ENTRYPOINTS } from "../observability/run-service.mjs";

// The shared control-plane image deliberately excludes every workload that
// executes an Agent, handles native game builds, touches host signing material,
// drives a Steam client, or exists only for localhost testing. Adding a new
// service requires an explicit classification and therefore cannot silently
// widen this image's authority.
export const CONTROL_PLANE_CONTAINER_SERVICES = Object.freeze([
  "agent-configuration",
  "agent-execution-broker",
  "agent-worker-workflow",
  "control-plane",
  "control-plane-workflow",
  "delivery-projection",
  "evidence-archive",
  "github-authorization",
  "identity",
  "inference-gateway",
  "project-repository",
  "provider-monitor",
  "p0-runtime-readiness",
  "runner-control-workflow",
  "runner-capacity-controller",
  "runner-ingress",
  "runner-toolchain-publisher",
  "scm-candidate-broker",
  "scm-merge-broker",
  "scm-proxy-workflow",
  "secret-broker",
  "source-snapshot",
  "spec-dialogue",
  "spec-model-broker",
  "spec-workflow-bridge",
  "steam-access",
  "steam-approval-monitor",
  "steam-depot-finalizer-host-activation",
  "steam-publisher-workflow",
  "steam-secure-ui",
  "steam-workflow-broker",
  "temporal-worker",
  "user-acceptance",
]);

export const EXTERNAL_WORKLOAD_SERVICES = Object.freeze([
  "agent-execution-worker",
  "agent-microvm-credential-issuer",
  "agent-microvm-guest",
  "agent-supply-chain",
  "agent-supply-chain-native",
  "artifact-preparer",
  "godot-testkit",
  "local-agent-runtime",
  "local-runtime",
  "local-spec-runtime",
  "physical-runner",
  "steam-client-connector",
  "steam-depot-finalizer",
  "steam-install-services",
  "steam-workflow-executor",
  "web",
]);

const CONTROL_SERVICES = new Set(CONTROL_PLANE_CONTAINER_SERVICES);

export function assertContainerServiceClassification(entrypoints = SERVICE_ENTRYPOINTS) {
  const classified = [...CONTROL_PLANE_CONTAINER_SERVICES, ...EXTERNAL_WORKLOAD_SERVICES];
  const duplicate = classified.find((service, index) => classified.indexOf(service) !== index);
  const configured = Object.keys(entrypoints).sort();
  const declared = [...classified].sort();
  if (duplicate || JSON.stringify(configured) !== JSON.stringify(declared)) {
    throw new Error("Production service container classification is incomplete");
  }
  return Object.freeze({ control: CONTROL_PLANE_CONTAINER_SERVICES, external: EXTERNAL_WORKLOAD_SERVICES });
}

export function resolveControlPlaneContainerService(env = process.env) {
  assertContainerServiceClassification();
  if (env.NODE_ENV !== "production") throw new Error("Control-plane containers require production mode");
  if (env.DEVILUDO_LOCAL_TEST_MODE !== undefined || env.DEVILUDO_LOCAL_DETERMINISTIC_WORKER_ATTESTATION !== undefined) {
    throw new Error("Local test authority is forbidden in a control-plane container");
  }
  const service = env.DEVILUDO_SERVICE;
  if (typeof service !== "string" || !CONTROL_SERVICES.has(service)) {
    throw new Error("Control-plane container service is not allow-listed");
  }
  return service;
}

export async function runControlPlaneContainer({
  argv = process.argv.slice(2),
  env = process.env,
  launch = runObservedService,
} = {}) {
  if (argv.length !== 0) throw new Error("Control-plane container arguments are forbidden");
  const service = resolveControlPlaneContainerService(env);
  await launch([service], env);
  return service;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runControlPlaneContainer().catch(() => {
    process.stderr.write("[control-container] service startup failed\n");
    process.exitCode = 1;
  });
}
