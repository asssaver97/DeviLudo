import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  artifactPreparerRuntimeLockDigest,
  createArtifactPreparerRuntimeLock,
  inspectArtifactPreparerRuntimeResources,
  parseArtifactPreparerRuntimeLockArguments,
  parseArtifactPreparerRuntimeMetadataOutput,
  validateArtifactPreparerRuntimeLock,
  verifyArtifactPreparerRuntimeLock,
} from "../scripts/production/lock-artifact-preparer-runtime.mjs";

const configurationRevision = "abcdef123456";

function makeRuntimeLock({
  clusterContext = "prod-runner/admin",
  namespace = "deviludo-runner-inputs",
} = {}) {
  let resourceIndex = 1;
  const resource = (kind, name) => Object.freeze({
    kind,
    name,
    uid: `30000000-0000-4000-8000-${String(resourceIndex++).padStart(12, "0")}`,
    resourceVersion: String(40_000 + resourceIndex),
  });
  return Object.freeze({
    schemaVersion: "deviludo.artifact-preparer-runtime-lock.v1",
    lockId: "66666666-6666-4666-8666-666666666666",
    clusterContext,
    namespace,
    configurationRevision,
    createdAt: "2026-07-26T00:00:00.000Z",
    registrySecret: resource("Secret", `deviludo-artifact-preparer-registry-${configurationRevision}`),
    configMap: resource("ConfigMap", `deviludo-artifact-preparer-config-${configurationRevision}`),
    environmentSecret: resource("Secret", `deviludo-artifact-preparer-environment-${configurationRevision}`),
    filesSecret: resource("Secret", `deviludo-artifact-preparer-files-${configurationRevision}`),
  });
}

function observedRuntimeResources(lock) {
  return [lock.registrySecret, lock.configMap, lock.environmentSecret, lock.filesSecret]
    .map((resource) => Object.freeze({ ...resource, immutable: true }));
}

test("Artifact Preparer runtime lock binds four immutable Kubernetes resources", async () => {
  const expected = makeRuntimeLock();
  assert.deepEqual(parseArtifactPreparerRuntimeLockArguments([
    "--context", expected.clusterContext,
    "--configuration-revision", configurationRevision,
  ]), {
    clusterContext: expected.clusterContext,
    configurationRevision,
    lockId: undefined,
    namespace: "deviludo-runner-inputs",
  });
  const lock = await createArtifactPreparerRuntimeLock({
    clusterContext: expected.clusterContext,
    namespace: expected.namespace,
    configurationRevision,
    createdAt: new Date(expected.createdAt),
    lockId: expected.lockId,
  }, async (request) => {
    assert.equal(request.clusterContext, expected.clusterContext);
    assert.equal(request.namespace, expected.namespace);
    return observedRuntimeResources(expected);
  });
  assert.deepEqual(lock, expected);
  assert.match(artifactPreparerRuntimeLockDigest(lock), /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => validateArtifactPreparerRuntimeLock({ ...lock, unexpected: true }), /lock is invalid/);
  assert.throws(() => validateArtifactPreparerRuntimeLock(lock, { configurationRevision: "000000000000" }),
    /lock is invalid/);
  assert.throws(() => parseArtifactPreparerRuntimeLockArguments([
    "--context", "prod", "--configuration-revision", "latest",
  ]), /input is invalid/);
});

test("Artifact Preparer runtime inspection reads metadata only and rejects mutable resources", async () => {
  const lock = makeRuntimeLock();
  const output = observedRuntimeResources(lock)
    .map((resource) => `${resource.kind} ${resource.name} ${resource.uid} ${resource.resourceVersion} true`).join("\n");
  assert.equal(parseArtifactPreparerRuntimeMetadataOutput(output).length, 4);
  assert.throws(() => parseArtifactPreparerRuntimeMetadataOutput(output.replace(" true", " false")), /lock is invalid/);
  const calls = [];
  const observed = await inspectArtifactPreparerRuntimeResources({
    clusterContext: lock.clusterContext,
    namespace: lock.namespace,
    resources: [lock.filesSecret, lock.registrySecret, lock.configMap, lock.environmentSecret],
  }, async (invocation) => { calls.push(invocation); return output; });
  assert.equal(observed.length, 4);
  assert.deepEqual(calls[0].args.slice(0, 5), [
    "--context", lock.clusterContext, "--namespace", lock.namespace, "get",
  ]);
  assert.ok(calls[0].args.some((argument) => argument.startsWith("--output=custom-columns=")));
  assert.ok(!calls[0].args.includes("--output=json"));
});

test("Artifact Preparer runtime verification fails closed on late identity drift", async () => {
  const lock = makeRuntimeLock();
  const verified = await verifyArtifactPreparerRuntimeLock(lock, {
    clusterContext: lock.clusterContext,
    namespace: lock.namespace,
    configurationRevision,
  }, async () => observedRuntimeResources(lock));
  assert.equal(verified.resourceCount, 4);
  assert.equal(verified.runtimeLockDigest, artifactPreparerRuntimeLockDigest(lock));
  await assert.rejects(verifyArtifactPreparerRuntimeLock(lock, {
    clusterContext: lock.clusterContext,
    namespace: lock.namespace,
  }, async () => observedRuntimeResources(lock).map((resource, index) => index === 0
    ? { ...resource, resourceVersion: "999" } : resource)), /lock is invalid/);
  await assert.rejects(verifyArtifactPreparerRuntimeLock(lock, {
    clusterContext: lock.clusterContext,
    namespace: lock.namespace,
  }, async () => observedRuntimeResources(lock).map((resource, index) => index === 0
    ? { ...resource, immutable: false } : resource)), /lock is invalid/);
});

test("Artifact Preparer runtime lock CLI remains an explicit production operation", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["lock:artifact-preparer-runtime"],
    "node scripts/production/lock-artifact-preparer-runtime.mjs");
  assert.throws(() => parseArtifactPreparerRuntimeLockArguments([
    "--context", "prod", "--context", "other", "--configuration-revision", configurationRevision,
  ]), /input is invalid/);
});
