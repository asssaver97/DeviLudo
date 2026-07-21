#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { CONTROL_PLANE_CONTAINER_SERVICES } from "./run-control-service.mjs";

const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REVISION = /^[a-f0-9]{12}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KUBERNETES_UID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RESOURCE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCK_KEYS = Object.freeze([
  "clusterContext", "configurationRevision", "createdAt", "lockId", "migrationSecret", "namespace",
  "registrySecret", "schemaVersion", "services",
]);
const SERVICE_KEYS = Object.freeze(["configMap", "environmentSecret", "filesSecret", "service"]);
const RESOURCE_KEYS = Object.freeze(["kind", "name", "resourceVersion", "uid"]);
const OBSERVED_KEYS = Object.freeze(["immutable", ...RESOURCE_KEYS]);
const OUTPUT_COLUMNS = "custom-columns=KIND:.kind,NAME:.metadata.name,UID:.metadata.uid,RESOURCE_VERSION:.metadata.resourceVersion,IMMUTABLE:.immutable";
const MAX_OUTPUT_BYTES = 1024 * 1024;

export function parseControlRuntimeLockArguments(argv) {
  if (!Array.isArray(argv)) invalidInput();
  const values = new Map();
  const allowed = new Set([
    "--configuration-revision", "--context", "--lock-id", "--namespace", "--services",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalidInput();
    values.set(name, value);
  }
  const clusterContext = values.get("--context");
  const configurationRevision = values.get("--configuration-revision");
  const namespace = values.get("--namespace") ?? "deviludo-system";
  const lockId = values.get("--lock-id");
  if (typeof clusterContext !== "string" || !CONTEXT.test(clusterContext)
    || typeof configurationRevision !== "string" || !REVISION.test(configurationRevision)
    || !validNamespace(namespace) || (lockId !== undefined && !UUID_V4.test(lockId))) invalidInput();
  return Object.freeze({
    clusterContext,
    configurationRevision,
    lockId,
    namespace,
    services: parseServices(values.get("--services")),
  });
}

export async function createControlRuntimeLock({
  clusterContext,
  configurationRevision,
  createdAt = new Date(),
  lockId = randomUUID(),
  namespace = "deviludo-system",
  services = CONTROL_PLANE_CONTAINER_SERVICES,
} = {}, inspect = inspectControlRuntimeResources) {
  const skeleton = runtimeLockSkeleton({
    clusterContext, configurationRevision, createdAt, lockId, namespace, services,
  });
  const expected = runtimeLockResources(skeleton);
  const observed = normalizeObservedResources(await inspect(Object.freeze({
    clusterContext: skeleton.clusterContext,
    namespace: skeleton.namespace,
    resources: expected,
  })), expected);
  const byName = new Map(observed.map((resource) => [`${resource.kind}/${resource.name}`, resource]));
  return validateControlRuntimeLock({
    ...skeleton,
    registrySecret: lockedResource(byName, skeleton.registrySecret),
    migrationSecret: lockedResource(byName, skeleton.migrationSecret),
    services: skeleton.services.map((entry) => ({
      service: entry.service,
      configMap: lockedResource(byName, entry.configMap),
      environmentSecret: lockedResource(byName, entry.environmentSecret),
      filesSecret: lockedResource(byName, entry.filesSecret),
    })),
  });
}

export function validateControlRuntimeLock(lock, expected = {}) {
  if (!plainRecord(lock) || !exactKeys(lock, LOCK_KEYS)
    || lock.schemaVersion !== "deviludo.control-runtime-lock.v1"
    || typeof lock.lockId !== "string" || !UUID_V4.test(lock.lockId)
    || typeof lock.clusterContext !== "string" || !CONTEXT.test(lock.clusterContext)
    || typeof lock.configurationRevision !== "string" || !REVISION.test(lock.configurationRevision)
    || !validNamespace(lock.namespace) || !canonicalTimestamp(lock.createdAt)
    || !Array.isArray(lock.services) || lock.services.length < 1
    || lock.services.length > CONTROL_PLANE_CONTAINER_SERVICES.length) invalidLock();
  const serviceNames = [];
  for (const entry of lock.services) {
    if (!plainRecord(entry) || !exactKeys(entry, SERVICE_KEYS)
      || typeof entry.service !== "string" || !CONTROL_PLANE_CONTAINER_SERVICES.includes(entry.service)) invalidLock();
    serviceNames.push(entry.service);
    validateLockedResource(entry.configMap, "ConfigMap", runtimeResourceName(entry.service, "config", lock.configurationRevision));
    validateLockedResource(entry.environmentSecret, "Secret", runtimeResourceName(entry.service, "environment", lock.configurationRevision));
    validateLockedResource(entry.filesSecret, "Secret", runtimeResourceName(entry.service, "files", lock.configurationRevision));
  }
  if (new Set(serviceNames).size !== serviceNames.length
    || JSON.stringify(serviceNames) !== JSON.stringify([...serviceNames].sort())) invalidLock();
  validateLockedResource(lock.registrySecret, "Secret", `deviludo-control-registry-${lock.configurationRevision}`);
  validateLockedResource(lock.migrationSecret, "Secret", `deviludo-schema-migrator-files-${lock.configurationRevision}`);
  const resources = runtimeLockResources(lock);
  if (new Set(resources.map((resource) => `${resource.kind}/${resource.name}`)).size !== resources.length
    || new Set(resources.map((resource) => resource.uid)).size !== resources.length) invalidLock();
  if (expected.clusterContext !== undefined && expected.clusterContext !== lock.clusterContext) invalidLock();
  if (expected.namespace !== undefined && expected.namespace !== lock.namespace) invalidLock();
  if (expected.services !== undefined && JSON.stringify([...expected.services].sort()) !== JSON.stringify(serviceNames)) invalidLock();
  return freezeLock(lock);
}

export async function verifyControlRuntimeLock(lock, expected, inspect = inspectControlRuntimeResources) {
  const trusted = validateControlRuntimeLock(lock, expected);
  const resources = runtimeLockResources(trusted);
  const observed = normalizeObservedResources(await inspect(Object.freeze({
    clusterContext: trusted.clusterContext,
    namespace: trusted.namespace,
    resources,
  })), resources);
  const observedByName = new Map(observed.map((resource) => [`${resource.kind}/${resource.name}`, resource]));
  for (const resource of resources) {
    const actual = observedByName.get(`${resource.kind}/${resource.name}`);
    if (!actual || actual.uid !== resource.uid || actual.resourceVersion !== resource.resourceVersion) invalidLock();
  }
  return Object.freeze({
    lockId: trusted.lockId,
    configurationRevision: trusted.configurationRevision,
    runtimeLockDigest: controlRuntimeLockDigest(trusted),
    resourceCount: resources.length,
  });
}

export function controlRuntimeLockDigest(lock) {
  return `sha256:${createHash("sha256").update(canonicalJson(validateControlRuntimeLock(lock))).digest("hex")}`;
}

export function runtimeLockResources(lock) {
  const resources = [lock.registrySecret, lock.migrationSecret];
  for (const entry of lock.services) resources.push(entry.configMap, entry.environmentSecret, entry.filesSecret);
  return Object.freeze(resources.map((resource) => Object.freeze({ ...resource })));
}

export async function inspectControlRuntimeResources(request, execute = executeKubectlCapture) {
  if (!plainRecord(request) || typeof request.clusterContext !== "string" || !CONTEXT.test(request.clusterContext)
    || !validNamespace(request.namespace) || !Array.isArray(request.resources) || request.resources.length < 1) invalidInput();
  const resources = [...request.resources].map((resource) => {
    if (!plainRecord(resource) || !new Set(["ConfigMap", "Secret"]).has(resource.kind)
      || typeof resource.name !== "string" || !validResourceName(resource.name)) invalidInput();
    return Object.freeze({ kind: resource.kind, name: resource.name });
  }).sort((left, right) => `${left.kind}/${left.name}`.localeCompare(`${right.kind}/${right.name}`));
  if (new Set(resources.map((resource) => `${resource.kind}/${resource.name}`)).size !== resources.length) invalidInput();
  const output = await execute(Object.freeze({
    command: "kubectl",
    args: Object.freeze([
      "--context", request.clusterContext,
      "--namespace", request.namespace,
      "get",
      ...resources.map((resource) => `${resource.kind.toLowerCase()}/${resource.name}`),
      `--output=${OUTPUT_COLUMNS}`,
      "--no-headers",
    ]),
  }));
  return parseRuntimeMetadataOutput(output);
}

export function parseRuntimeMetadataOutput(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) < 1 || Buffer.byteLength(output) > MAX_OUTPUT_BYTES) invalidLock();
  const rows = output.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/));
  if (rows.some((fields) => fields.length !== 5)) invalidLock();
  return Object.freeze(rows.map(([kind, name, uid, resourceVersion, immutable]) => {
    const value = { kind, name, uid, resourceVersion, immutable: immutable === "true" };
    validateObservedResource(value);
    return Object.freeze(value);
  }));
}

function runtimeLockSkeleton({ clusterContext, configurationRevision, createdAt, lockId, namespace, services }) {
  if (typeof clusterContext !== "string" || !CONTEXT.test(clusterContext)
    || typeof configurationRevision !== "string" || !REVISION.test(configurationRevision)
    || !(createdAt instanceof Date) || !Number.isFinite(createdAt.valueOf())
    || typeof lockId !== "string" || !UUID_V4.test(lockId) || !validNamespace(namespace)) invalidInput();
  const selected = validateServices(services);
  return {
    schemaVersion: "deviludo.control-runtime-lock.v1",
    lockId,
    clusterContext,
    namespace,
    configurationRevision,
    createdAt: createdAt.toISOString(),
    registrySecret: { kind: "Secret", name: `deviludo-control-registry-${configurationRevision}` },
    migrationSecret: { kind: "Secret", name: `deviludo-schema-migrator-files-${configurationRevision}` },
    services: selected.map((service) => ({
      service,
      configMap: { kind: "ConfigMap", name: runtimeResourceName(service, "config", configurationRevision) },
      environmentSecret: { kind: "Secret", name: runtimeResourceName(service, "environment", configurationRevision) },
      filesSecret: { kind: "Secret", name: runtimeResourceName(service, "files", configurationRevision) },
    })),
  };
}

function runtimeResourceName(service, type, revision) {
  return `deviludo-${service}-${type}-${revision}`;
}

function lockedResource(byName, resource) {
  const observed = byName.get(`${resource.kind}/${resource.name}`);
  if (!observed) invalidLock();
  return { kind: observed.kind, name: observed.name, uid: observed.uid, resourceVersion: observed.resourceVersion };
}

function normalizeObservedResources(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length) invalidLock();
  const resources = value.map((resource) => validateObservedResource(resource));
  const expectedNames = [...expected].map((resource) => `${resource.kind}/${resource.name}`).sort();
  const actualNames = resources.map((resource) => `${resource.kind}/${resource.name}`).sort();
  if (new Set(actualNames).size !== actualNames.length || JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) invalidLock();
  return resources;
}

function validateObservedResource(resource) {
  if (!plainRecord(resource) || !exactKeys(resource, OBSERVED_KEYS) || resource.immutable !== true
    || !new Set(["ConfigMap", "Secret"]).has(resource.kind) || !validResourceName(resource.name)
    || typeof resource.uid !== "string" || !KUBERNETES_UID.test(resource.uid)
    || typeof resource.resourceVersion !== "string" || !RESOURCE_VERSION.test(resource.resourceVersion)) invalidLock();
  return Object.freeze({ ...resource });
}

function validateLockedResource(resource, kind, name) {
  if (!plainRecord(resource) || !exactKeys(resource, RESOURCE_KEYS) || resource.kind !== kind || resource.name !== name
    || typeof resource.uid !== "string" || !KUBERNETES_UID.test(resource.uid)
    || typeof resource.resourceVersion !== "string" || !RESOURCE_VERSION.test(resource.resourceVersion)) invalidLock();
}

function freezeLock(lock) {
  return Object.freeze({
    ...lock,
    registrySecret: Object.freeze({ ...lock.registrySecret }),
    migrationSecret: Object.freeze({ ...lock.migrationSecret }),
    services: Object.freeze(lock.services.map((entry) => Object.freeze({
      ...entry,
      configMap: Object.freeze({ ...entry.configMap }),
      environmentSecret: Object.freeze({ ...entry.environmentSecret }),
      filesSecret: Object.freeze({ ...entry.filesSecret }),
    }))),
  });
}

function validateServices(services) {
  if (!Array.isArray(services) || services.length < 1 || services.length > CONTROL_PLANE_CONTAINER_SERVICES.length
    || services.some((service) => typeof service !== "string" || !CONTROL_PLANE_CONTAINER_SERVICES.includes(service))
    || new Set(services).size !== services.length) invalidInput();
  return [...services].sort();
}

function parseServices(value) {
  return validateServices(value === undefined ? CONTROL_PLANE_CONTAINER_SERVICES : value.split(","));
}

function validNamespace(value) {
  return typeof value === "string" && value.length <= 63 && NAMESPACE.test(value);
}

function validResourceName(value) {
  return typeof value === "string" && value.length <= 253 && NAMESPACE.test(value);
}

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function canonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") invalidLock();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidLock();
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  if (typeof value === "number" && (!Number.isFinite(value) || !Number.isSafeInteger(value))) invalidLock();
  return value;
}

async function executeKubectlCapture(invocation) {
  return new Promise((accept, reject) => {
    const child = spawn(invocation.command, invocation.args, { shell: false, stdio: ["ignore", "pipe", "inherit"] });
    const chunks = [];
    let length = 0;
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null && length <= MAX_OUTPUT_BYTES) accept(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error("Kubernetes runtime metadata probe failed"));
    });
  });
}

function invalidInput() {
  throw new Error("Control runtime lock input is invalid");
}

function invalidLock() {
  throw new Error("Control runtime lock is invalid");
}

async function main() {
  if (process.env.NODE_ENV !== "production") invalidInput();
  const lock = await createControlRuntimeLock(parseControlRuntimeLockArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(lock)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[lock:control-runtime] lock creation failed\n");
    process.exitCode = 1;
  });
}
