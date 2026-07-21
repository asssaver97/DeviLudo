import assert from "node:assert/strict";
import test from "node:test";

import {
  controlRuntimeLockDigest,
  createControlRuntimeLock,
  inspectControlRuntimeResources,
  parseControlRuntimeLockArguments,
  parseRuntimeMetadataOutput,
  validateControlRuntimeLock,
  verifyControlRuntimeLock,
} from "../scripts/production/lock-control-runtime.mjs";
import {
  makeControlRuntimeLock,
  observedControlRuntimeResources,
  runtimeConfigurationRevision,
} from "./control-runtime-lock-fixture.mjs";

test("runtime lock CLI requires an explicit cluster, exact revision and allow-listed sorted services", () => {
  assert.deepEqual(parseControlRuntimeLockArguments([
    "--context", "production-ap-east-1/platform-admin",
    "--namespace", "deviludo-prod",
    "--configuration-revision", runtimeConfigurationRevision,
    "--services", "control-plane,agent-configuration",
    "--lock-id", "55555555-5555-4555-8555-555555555555",
  ]), {
    clusterContext: "production-ap-east-1/platform-admin",
    configurationRevision: runtimeConfigurationRevision,
    lockId: "55555555-5555-4555-8555-555555555555",
    namespace: "deviludo-prod",
    services: ["agent-configuration", "control-plane"],
  });
  assert.throws(
    () => parseControlRuntimeLockArguments(["--context", "production", "--configuration-revision", "latest"]),
    /input is invalid/,
  );
  assert.throws(
    () => parseControlRuntimeLockArguments([
      "--context", "production", "--configuration-revision", runtimeConfigurationRevision,
      "--services", "control-plane,physical-runner",
    ]),
    /input is invalid/,
  );
});

test("runtime lock creation snapshots only immutable Kubernetes identities and has a canonical digest", async () => {
  const requests = [];
  const lock = await createControlRuntimeLock({
    clusterContext: "production-ap-east-1/platform-admin",
    configurationRevision: runtimeConfigurationRevision,
    createdAt: new Date("2026-07-22T00:00:00.000Z"),
    lockId: "55555555-5555-4555-8555-555555555555",
    namespace: "deviludo-prod",
    services: ["control-plane", "agent-configuration"],
  }, async (request) => {
    requests.push(request);
    return request.resources.map((resource, index) => ({
      ...resource,
      uid: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      resourceVersion: String(200 + index),
      immutable: true,
    }));
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].resources.length, 8);
  assert.deepEqual(lock.services.map((entry) => entry.service), ["agent-configuration", "control-plane"]);
  assert.equal(lock.registrySecret.name, `deviludo-control-registry-${runtimeConfigurationRevision}`);
  assert.equal(lock.services[1].configMap.name,
    `deviludo-control-plane-config-${runtimeConfigurationRevision}`);
  assert.deepEqual(validateControlRuntimeLock(lock, {
    clusterContext: "production-ap-east-1/platform-admin",
    namespace: "deviludo-prod",
    services: ["agent-configuration", "control-plane"],
  }), lock);
  assert.match(controlRuntimeLockDigest(lock), /^sha256:[a-f0-9]{64}$/);

  await assert.rejects(
    createControlRuntimeLock({
      clusterContext: "production", configurationRevision: runtimeConfigurationRevision,
      services: ["control-plane"],
    }, async (request) => request.resources.map((resource, index) => ({
      ...resource,
      uid: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      resourceVersion: String(index + 1),
      immutable: index !== 0,
    }))),
    /runtime lock is invalid/,
  );
});

test("Kubernetes metadata probe asks for custom columns only and never reads Secret data", async () => {
  const lock = makeControlRuntimeLock({
    clusterContext: "production-ap-east-1/platform-admin",
    namespace: "deviludo-prod",
    services: ["control-plane"],
  });
  const observed = observedControlRuntimeResources(lock);
  const calls = [];
  const result = await inspectControlRuntimeResources({
    clusterContext: lock.clusterContext,
    namespace: lock.namespace,
    resources: observed,
  }, async (invocation) => {
    calls.push(invocation);
    return observed.map((resource) => [
      resource.kind, resource.name, resource.uid, resource.resourceVersion, "true",
    ].join(" ")).join("\n");
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "kubectl");
  assert.ok(calls[0].args.includes("--context"));
  assert.ok(calls[0].args.some((argument) => argument.startsWith("--output=custom-columns=")));
  assert.ok(!calls[0].args.includes("-o"));
  assert.ok(!calls[0].args.includes("json"));
  assert.ok(!calls[0].args.some((argument) => /\.data|\.stringData/.test(argument)));
  assert.deepEqual(result, observed);
  assert.throws(
    () => parseRuntimeMetadataOutput(`${observed[0].kind} ${observed[0].name} ${observed[0].uid} 1 false`),
    /runtime lock is invalid/,
  );
});

test("runtime lock verification fails closed on UID, resourceVersion, immutability or scope drift", async () => {
  const lock = makeControlRuntimeLock({ services: ["agent-configuration", "control-plane"] });
  const observed = observedControlRuntimeResources(lock);
  const evidence = await verifyControlRuntimeLock(lock, {
    clusterContext: lock.clusterContext,
    namespace: lock.namespace,
    services: ["agent-configuration", "control-plane"],
  }, async () => observed);
  assert.equal(evidence.lockId, lock.lockId);
  assert.equal(evidence.configurationRevision, runtimeConfigurationRevision);
  assert.equal(evidence.resourceCount, 8);
  assert.equal(evidence.runtimeLockDigest, controlRuntimeLockDigest(lock));

  for (const changed of [
    observed.map((resource, index) => index === 0 ? { ...resource, uid: "99999999-9999-4999-8999-999999999999" } : resource),
    observed.map((resource, index) => index === 1 ? { ...resource, resourceVersion: "999" } : resource),
    observed.map((resource, index) => index === 2 ? { ...resource, immutable: false } : resource),
  ]) {
    await assert.rejects(
      verifyControlRuntimeLock(lock, {
        clusterContext: lock.clusterContext,
        namespace: lock.namespace,
        services: ["agent-configuration", "control-plane"],
      }, async () => changed),
      /runtime lock is invalid/,
    );
  }
  await assert.rejects(
    verifyControlRuntimeLock(lock, {
      clusterContext: "another-cluster/admin",
      namespace: lock.namespace,
      services: ["agent-configuration", "control-plane"],
    }, async () => observed),
    /runtime lock is invalid/,
  );
  assert.throws(
    () => validateControlRuntimeLock({ ...lock, unexpected: true }),
    /runtime lock is invalid/,
  );
});
