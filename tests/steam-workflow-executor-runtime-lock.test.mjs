import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createSteamWorkflowExecutorRuntimeLock,
  inspectSteamWorkflowExecutorRuntimeResources,
  parseSteamWorkflowExecutorRuntimeLockArguments,
  parseSteamWorkflowExecutorRuntimeMetadataOutput,
  steamWorkflowExecutorRuntimeLockDigest,
  validateSteamWorkflowExecutorRuntimeLock,
  verifySteamWorkflowExecutorRuntimeLock,
} from "../scripts/production/lock-steam-workflow-executor-runtime.mjs";

const configurationRevision = "abcdef123456";

function runtimeLock({ clusterContext = "prod-steam/admin", namespace = "deviludo-steam-release" } = {}) {
  let index = 1;
  const resource = (kind, name) => Object.freeze({
    kind, name,
    uid: `70000000-0000-4000-8000-${String(index++).padStart(12, "0")}`,
    resourceVersion: String(50_000 + index),
  });
  return Object.freeze({
    schemaVersion: "deviludo.steam-workflow-executor-runtime-lock.v1",
    lockId: "77777777-7777-4777-8777-777777777777",
    clusterContext, namespace, configurationRevision, createdAt: "2026-07-26T08:00:00.000Z",
    registrySecret: resource("Secret", `deviludo-steam-workflow-executor-registry-${configurationRevision}`),
    configMap: resource("ConfigMap", `deviludo-steam-workflow-executor-config-${configurationRevision}`),
    environmentSecret: resource("Secret", `deviludo-steam-workflow-executor-environment-${configurationRevision}`),
    filesSecret: resource("Secret", `deviludo-steam-workflow-executor-files-${configurationRevision}`),
  });
}
function observed(lock) {
  return [lock.registrySecret, lock.configMap, lock.environmentSecret, lock.filesSecret]
    .map((resource) => Object.freeze({ ...resource, immutable: true }));
}

test("Steam workflow executor runtime lock binds four immutable resources", async () => {
  const expected = runtimeLock();
  assert.deepEqual(parseSteamWorkflowExecutorRuntimeLockArguments([
    "--context", expected.clusterContext, "--configuration-revision", configurationRevision,
  ]), { clusterContext: expected.clusterContext, configurationRevision, lockId: undefined, namespace: expected.namespace });
  const lock = await createSteamWorkflowExecutorRuntimeLock({
    clusterContext: expected.clusterContext, namespace: expected.namespace, configurationRevision,
    createdAt: new Date(expected.createdAt), lockId: expected.lockId,
  }, async (request) => {
    assert.equal(request.clusterContext, expected.clusterContext);
    assert.equal(request.namespace, expected.namespace);
    return observed(expected);
  });
  assert.deepEqual(lock, expected);
  assert.match(steamWorkflowExecutorRuntimeLockDigest(lock), /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => validateSteamWorkflowExecutorRuntimeLock({ ...lock, unexpected: true }), /lock is invalid/);
  assert.throws(() => validateSteamWorkflowExecutorRuntimeLock(lock, { configurationRevision: "000000000000" }),
    /lock is invalid/);
  assert.throws(() => parseSteamWorkflowExecutorRuntimeLockArguments([
    "--context", "prod", "--configuration-revision", "latest",
  ]), /input is invalid/);
});

test("Steam workflow executor inspection is metadata-only and rejects mutable inputs", async () => {
  const lock = runtimeLock();
  const output = observed(lock)
    .map((resource) => `${resource.kind} ${resource.name} ${resource.uid} ${resource.resourceVersion} true`).join("\n");
  assert.equal(parseSteamWorkflowExecutorRuntimeMetadataOutput(output).length, 4);
  assert.throws(() => parseSteamWorkflowExecutorRuntimeMetadataOutput(output.replace(" true", " false")), /lock is invalid/);
  const calls = [];
  const resources = await inspectSteamWorkflowExecutorRuntimeResources({
    clusterContext: lock.clusterContext, namespace: lock.namespace,
    resources: [lock.filesSecret, lock.registrySecret, lock.configMap, lock.environmentSecret],
  }, async (invocation) => { calls.push(invocation); return output; });
  assert.equal(resources.length, 4);
  assert.deepEqual(calls[0].args.slice(0, 5), ["--context", lock.clusterContext, "--namespace", lock.namespace, "get"]);
  assert.ok(calls[0].args.some((argument) => argument.startsWith("--output=custom-columns=")));
  assert.ok(!calls[0].args.includes("--output=json"));
});

test("Steam workflow executor runtime verification rejects late identity drift", async () => {
  const lock = runtimeLock();
  const result = await verifySteamWorkflowExecutorRuntimeLock(lock, {
    clusterContext: lock.clusterContext, namespace: lock.namespace, configurationRevision,
  }, async () => observed(lock));
  assert.equal(result.resourceCount, 4);
  assert.equal(result.runtimeLockDigest, steamWorkflowExecutorRuntimeLockDigest(lock));
  await assert.rejects(verifySteamWorkflowExecutorRuntimeLock(lock, {
    clusterContext: lock.clusterContext, namespace: lock.namespace,
  }, async () => observed(lock).map((resource, index) => index === 0
    ? { ...resource, resourceVersion: "999" } : resource)), /lock is invalid/);
  await assert.rejects(verifySteamWorkflowExecutorRuntimeLock(lock, {
    clusterContext: lock.clusterContext, namespace: lock.namespace,
  }, async () => observed(lock).map((resource, index) => index === 0
    ? { ...resource, immutable: false } : resource)), /lock is invalid/);
});

test("Steam workflow executor runtime lock CLI requires explicit production context", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["lock:steam-workflow-executor-runtime"],
    "node scripts/production/lock-steam-workflow-executor-runtime.mjs");
  assert.throws(() => parseSteamWorkflowExecutorRuntimeLockArguments([
    "--context", "prod", "--context", "other", "--configuration-revision", configurationRevision,
  ]), /input is invalid/);
});
