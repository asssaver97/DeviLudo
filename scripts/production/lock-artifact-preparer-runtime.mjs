#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REVISION = /^[a-f0-9]{12}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KUBERNETES_UID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RESOURCE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCK_KEYS = Object.freeze([
  "clusterContext", "configurationRevision", "configMap", "createdAt", "environmentSecret", "filesSecret",
  "lockId", "namespace", "registrySecret", "schemaVersion",
]);
const RESOURCE_KEYS = Object.freeze(["kind", "name", "resourceVersion", "uid"]);
const OBSERVED_KEYS = Object.freeze(["immutable", ...RESOURCE_KEYS]);
const OUTPUT_COLUMNS = "custom-columns=KIND:.kind,NAME:.metadata.name,UID:.metadata.uid,RESOURCE_VERSION:.metadata.resourceVersion,IMMUTABLE:.immutable";
const MAX_OUTPUT_BYTES = 256 * 1024;

export function parseArtifactPreparerRuntimeLockArguments(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) invalidInput();
  const values = new Map();
  const allowed = new Set(["--configuration-revision", "--context", "--lock-id", "--namespace"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalidInput();
    values.set(name, value);
  }
  const clusterContext = values.get("--context");
  const configurationRevision = values.get("--configuration-revision");
  const namespace = values.get("--namespace") ?? "deviludo-runner-inputs";
  const lockId = values.get("--lock-id");
  if (typeof clusterContext !== "string" || !CONTEXT.test(clusterContext)
    || typeof configurationRevision !== "string" || !REVISION.test(configurationRevision)
    || !validNamespace(namespace) || (lockId !== undefined && !UUID_V4.test(lockId))) invalidInput();
  return Object.freeze({ clusterContext, configurationRevision, lockId, namespace });
}

export async function createArtifactPreparerRuntimeLock({
  clusterContext,
  configurationRevision,
  createdAt = new Date(),
  lockId = randomUUID(),
  namespace = "deviludo-runner-inputs",
} = {}, inspect = inspectArtifactPreparerRuntimeResources) {
  const skeleton = runtimeLockSkeleton({ clusterContext, configurationRevision, createdAt, lockId, namespace });
  const expected = artifactPreparerRuntimeLockResources(skeleton);
  const observed = normalizeObservedResources(await inspect(Object.freeze({
    clusterContext: skeleton.clusterContext, namespace: skeleton.namespace, resources: expected,
  })), expected);
  const byName = new Map(observed.map((resource) => [`${resource.kind}/${resource.name}`, resource]));
  return validateArtifactPreparerRuntimeLock({
    ...skeleton,
    registrySecret: lockedResource(byName, skeleton.registrySecret),
    configMap: lockedResource(byName, skeleton.configMap),
    environmentSecret: lockedResource(byName, skeleton.environmentSecret),
    filesSecret: lockedResource(byName, skeleton.filesSecret),
  });
}

export function validateArtifactPreparerRuntimeLock(lock, expected = {}) {
  if (!plainRecord(lock) || !exactKeys(lock, LOCK_KEYS)
    || lock.schemaVersion !== "deviludo.artifact-preparer-runtime-lock.v1"
    || typeof lock.lockId !== "string" || !UUID_V4.test(lock.lockId)
    || typeof lock.clusterContext !== "string" || !CONTEXT.test(lock.clusterContext)
    || typeof lock.configurationRevision !== "string" || !REVISION.test(lock.configurationRevision)
    || !validNamespace(lock.namespace) || !canonicalTimestamp(lock.createdAt)) invalidLock();
  const revision = lock.configurationRevision;
  validateLockedResource(lock.registrySecret, "Secret", `deviludo-artifact-preparer-registry-${revision}`);
  validateLockedResource(lock.configMap, "ConfigMap", `deviludo-artifact-preparer-config-${revision}`);
  validateLockedResource(lock.environmentSecret, "Secret", `deviludo-artifact-preparer-environment-${revision}`);
  validateLockedResource(lock.filesSecret, "Secret", `deviludo-artifact-preparer-files-${revision}`);
  const resources = artifactPreparerRuntimeLockResources(lock);
  if (new Set(resources.map((resource) => `${resource.kind}/${resource.name}`)).size !== resources.length
    || new Set(resources.map((resource) => resource.uid)).size !== resources.length) invalidLock();
  if (expected.clusterContext !== undefined && expected.clusterContext !== lock.clusterContext) invalidLock();
  if (expected.namespace !== undefined && expected.namespace !== lock.namespace) invalidLock();
  if (expected.configurationRevision !== undefined
    && expected.configurationRevision !== lock.configurationRevision) invalidLock();
  return freezeLock(lock);
}

export async function verifyArtifactPreparerRuntimeLock(lock, expected,
  inspect = inspectArtifactPreparerRuntimeResources) {
  const trusted = validateArtifactPreparerRuntimeLock(lock, expected);
  const resources = artifactPreparerRuntimeLockResources(trusted);
  const observed = normalizeObservedResources(await inspect(Object.freeze({
    clusterContext: trusted.clusterContext, namespace: trusted.namespace, resources,
  })), resources);
  const byName = new Map(observed.map((resource) => [`${resource.kind}/${resource.name}`, resource]));
  for (const resource of resources) {
    const actual = byName.get(`${resource.kind}/${resource.name}`);
    if (!actual || actual.uid !== resource.uid || actual.resourceVersion !== resource.resourceVersion) invalidLock();
  }
  return Object.freeze({
    lockId: trusted.lockId,
    configurationRevision: trusted.configurationRevision,
    runtimeLockDigest: artifactPreparerRuntimeLockDigest(trusted),
    resourceCount: resources.length,
  });
}

export function artifactPreparerRuntimeLockDigest(lock) {
  return `sha256:${createHash("sha256").update(canonicalJson(validateArtifactPreparerRuntimeLock(lock))).digest("hex")}`;
}

export function artifactPreparerRuntimeLockResources(lock) {
  return Object.freeze([lock.registrySecret, lock.configMap, lock.environmentSecret, lock.filesSecret]
    .map((resource) => Object.freeze({ ...resource })));
}

export async function inspectArtifactPreparerRuntimeResources(request, execute = executeKubectlCapture) {
  if (!plainRecord(request) || typeof request.clusterContext !== "string" || !CONTEXT.test(request.clusterContext)
    || !validNamespace(request.namespace) || !Array.isArray(request.resources) || request.resources.length !== 4) invalidInput();
  const resources = request.resources.map((resource) => {
    if (!plainRecord(resource) || !new Set(["ConfigMap", "Secret"]).has(resource.kind)
      || !validResourceName(resource.name)) invalidInput();
    return Object.freeze({ kind: resource.kind, name: resource.name });
  }).sort((left, right) => `${left.kind}/${left.name}`.localeCompare(`${right.kind}/${right.name}`));
  if (new Set(resources.map((resource) => `${resource.kind}/${resource.name}`)).size !== resources.length) invalidInput();
  const output = await execute(Object.freeze({ command: "kubectl", args: Object.freeze([
    "--context", request.clusterContext, "--namespace", request.namespace, "get",
    ...resources.map((resource) => `${resource.kind.toLowerCase()}/${resource.name}`),
    `--output=${OUTPUT_COLUMNS}`, "--no-headers",
  ]) }));
  return parseArtifactPreparerRuntimeMetadataOutput(output);
}

export function parseArtifactPreparerRuntimeMetadataOutput(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) < 1 || Buffer.byteLength(output) > MAX_OUTPUT_BYTES) invalidLock();
  const rows = output.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/));
  if (rows.some((fields) => fields.length !== 5)) invalidLock();
  return Object.freeze(rows.map(([kind, name, uid, resourceVersion, immutable]) => validateObservedResource({
    kind, name, uid, resourceVersion, immutable: immutable === "true" ? true : false,
  })));
}

function runtimeLockSkeleton({ clusterContext, configurationRevision, createdAt, lockId, namespace }) {
  if (typeof clusterContext !== "string" || !CONTEXT.test(clusterContext)
    || typeof configurationRevision !== "string" || !REVISION.test(configurationRevision)
    || !(createdAt instanceof Date) || !Number.isFinite(createdAt.valueOf())
    || typeof lockId !== "string" || !UUID_V4.test(lockId) || !validNamespace(namespace)) invalidInput();
  return {
    schemaVersion: "deviludo.artifact-preparer-runtime-lock.v1",
    lockId, clusterContext, namespace, configurationRevision, createdAt: createdAt.toISOString(),
    registrySecret: { kind: "Secret", name: `deviludo-artifact-preparer-registry-${configurationRevision}` },
    configMap: { kind: "ConfigMap", name: `deviludo-artifact-preparer-config-${configurationRevision}` },
    environmentSecret: { kind: "Secret", name: `deviludo-artifact-preparer-environment-${configurationRevision}` },
    filesSecret: { kind: "Secret", name: `deviludo-artifact-preparer-files-${configurationRevision}` },
  };
}

function lockedResource(byName, resource) {
  const observed = byName.get(`${resource.kind}/${resource.name}`); if (!observed) invalidLock();
  return { kind: observed.kind, name: observed.name, uid: observed.uid, resourceVersion: observed.resourceVersion };
}
function normalizeObservedResources(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length) invalidLock();
  const resources = value.map((resource) => validateObservedResource(resource));
  const expectedNames = expected.map((resource) => `${resource.kind}/${resource.name}`).sort();
  const actualNames = resources.map((resource) => `${resource.kind}/${resource.name}`).sort();
  if (new Set(actualNames).size !== actualNames.length || JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) invalidLock();
  return resources;
}
function validateObservedResource(resource) {
  if (!plainRecord(resource) || !exactKeys(resource, OBSERVED_KEYS)
    || !new Set(["ConfigMap", "Secret"]).has(resource.kind) || !validResourceName(resource.name)
    || typeof resource.uid !== "string" || !KUBERNETES_UID.test(resource.uid)
    || typeof resource.resourceVersion !== "string" || !RESOURCE_VERSION.test(resource.resourceVersion)
    || resource.immutable !== true) invalidLock();
  return Object.freeze({ ...resource });
}
function validateLockedResource(resource, kind, name) {
  if (!plainRecord(resource) || !exactKeys(resource, RESOURCE_KEYS) || resource.kind !== kind || resource.name !== name
    || typeof resource.uid !== "string" || !KUBERNETES_UID.test(resource.uid)
    || typeof resource.resourceVersion !== "string" || !RESOURCE_VERSION.test(resource.resourceVersion)) invalidLock();
}
function freezeLock(lock) { return Object.freeze({ ...lock,
  registrySecret: Object.freeze({ ...lock.registrySecret }), configMap: Object.freeze({ ...lock.configMap }),
  environmentSecret: Object.freeze({ ...lock.environmentSecret }), filesSecret: Object.freeze({ ...lock.filesSecret }),
}); }
function validNamespace(value) { return typeof value === "string" && value.length <= 63 && DNS_LABEL.test(value); }
function validResourceName(value) { return typeof value === "string" && value.length <= 253 && DNS_LABEL.test(value); }
function plainRecord(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function canonicalize(value) { if (value === undefined || typeof value === "bigint" || typeof value === "function"
    || typeof value === "symbol") invalidLock();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") { const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidLock();
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])); }
  if (typeof value === "number" && (!Number.isFinite(value) || !Number.isSafeInteger(value))) invalidLock(); return value; }
async function executeKubectlCapture(invocation) { return new Promise((accept, reject) => {
  const child = spawn(invocation.command, invocation.args, { shell: false, stdio: ["ignore", "pipe", "inherit"] });
  const chunks = []; let length = 0;
  child.stdout.on("data", (chunk) => { length += chunk.length; if (length > MAX_OUTPUT_BYTES) child.kill("SIGKILL"); else chunks.push(chunk); });
  child.once("error", reject); child.once("exit", (code, signal) => code === 0 && signal === null && length <= MAX_OUTPUT_BYTES
    ? accept(Buffer.concat(chunks).toString("utf8"))
    : reject(new Error("Artifact Preparer Kubernetes runtime metadata probe failed")));
}); }
function invalidInput() { throw new Error("Artifact Preparer runtime lock input is invalid"); }
function invalidLock() { throw new Error("Artifact Preparer runtime lock is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalidInput();
  const lock = await createArtifactPreparerRuntimeLock(parseArtifactPreparerRuntimeLockArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(lock)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[lock:artifact-preparer-runtime] lock creation failed\n"); process.exitCode = 1; });
}
