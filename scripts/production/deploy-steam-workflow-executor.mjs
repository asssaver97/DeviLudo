#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifySteamWorkflowExecutorReleaseAuthorization } from "./steam-workflow-executor-release-authorization.mjs";
import { validateSteamWorkflowExecutorImageReceipt } from "./build-steam-workflow-executor-image.mjs";
import {
  inspectSteamWorkflowExecutorRuntimeResources,
  validateSteamWorkflowExecutorRuntimeLock,
  verifySteamWorkflowExecutorRuntimeLock,
} from "./lock-steam-workflow-executor-runtime.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RELEASE_SCHEMA = "deviludo.kubernetes-steam-workflow-executor-release.v1";
const MAX_JSON_BYTES = 1024 * 1024;

export function parseSteamWorkflowExecutorDeploymentArguments(argv) {
  if (!Array.isArray(argv)) invalid();
  const flags = new Set(); const values = new Map();
  const flagNames = new Set(["--apply", "--render"]);
  const valueNames = new Set([
    "--authorization", "--context", "--namespace", "--receipt", "--replicas", "--runtime-lock",
    "--timeout-seconds", "--trust-policy", "--trust-policy-digest",
  ]);
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (flagNames.has(name)) { if (flags.has(name)) invalid(); flags.add(name); index += 1; continue; }
    const value = argv[index + 1];
    if (!valueNames.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value); index += 2;
  }
  if (flags.has("--apply") && flags.has("--render")) invalid();
  const mode = flags.has("--apply") ? "apply" : "render";
  const receiptPath = values.get("--receipt"); const runtimeLockPath = values.get("--runtime-lock");
  const authorizationPath = values.get("--authorization"); const trustPolicyPath = values.get("--trust-policy");
  const trustPolicyDigest = values.get("--trust-policy-digest"); const context = values.get("--context");
  const namespace = values.get("--namespace") ?? "deviludo-steam-release";
  const replicas = integer(values.get("--replicas") ?? "1", 1, 10);
  const timeoutSeconds = integer(values.get("--timeout-seconds") ?? "900", 60, 3_600);
  if (!absolute(receiptPath) || !absolute(runtimeLockPath) || !validNamespace(namespace)
    || mode === "apply" && (typeof context !== "string" || !CONTEXT.test(context)
      || !absolute(authorizationPath) || !absolute(trustPolicyPath) || !SHA256.test(trustPolicyDigest))
    || mode === "render" && [context, authorizationPath, trustPolicyPath, trustPolicyDigest].some((value) => value !== undefined)) invalid();
  return Object.freeze({
    authorizationPath, context, mode, namespace, receiptPath, replicas, runtimeLockPath,
    timeoutSeconds, trustPolicyDigest, trustPolicyPath,
  });
}

export function renderSteamWorkflowExecutorRelease(receipt, options = {}) {
  receipt = validateSteamWorkflowExecutorImageReceipt(receipt, {
    platformVersion: receipt?.platformVersion, dockerfileDigest: receipt?.dockerfileDigest,
    packageLockDigest: receipt?.packageLockDigest, nodeBaseImage: receipt?.nodeBaseImage,
    nativePublisherImage: receipt?.nativePublisherImage,
    sourceRevision: receipt?.sourceRevision, platform: receipt?.platform,
  });
  const namespace = options.namespace ?? "deviludo-steam-release";
  const replicas = options.replicas ?? 1; const timeoutSeconds = options.timeoutSeconds ?? 900;
  if (!validNamespace(namespace) || !Number.isSafeInteger(replicas) || replicas < 1 || replicas > 10
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 3_600) invalid();
  const runtimeLock = validateSteamWorkflowExecutorRuntimeLock(options.runtimeLock, { namespace });
  const common = commonLabels(receipt);
  const selector = { "app.kubernetes.io/name": "deviludo", "app.kubernetes.io/component": "steam-workflow-executor" };
  const annotations = receiptAnnotations(receipt);
  const namespaceResource = {
    apiVersion: "v1", kind: "Namespace",
    metadata: { name: namespace, labels: { ...common,
      "pod-security.kubernetes.io/audit": "restricted", "pod-security.kubernetes.io/enforce": "restricted",
      "pod-security.kubernetes.io/warn": "restricted" }, annotations },
  };
  const serviceAccount = {
    apiVersion: "v1", kind: "ServiceAccount",
    metadata: { name: "deviludo-steam-workflow-executor", namespace, labels: common },
    automountServiceAccountToken: false,
    imagePullSecrets: [{ name: runtimeLock.registrySecret.name }],
  };
  const networkPolicy = {
    apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
    metadata: { name: "deviludo-steam-workflow-executor-default-deny", namespace, labels: common },
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  };
  const deployment = {
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name: "deviludo-steam-workflow-executor", namespace, labels: { ...common, ...selector }, annotations },
    spec: {
      replicas, minReadySeconds: 10, progressDeadlineSeconds: timeoutSeconds, revisionHistoryLimit: 3,
      selector: { matchLabels: selector },
      strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      template: {
        metadata: { labels: { ...common, ...selector }, annotations },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          nodeSelector: {
            "kubernetes.io/os": "linux",
            "kubernetes.io/arch": receipt.platform.slice("linux/".length),
            "deviludo.io/workload": "steam-workflow-executor",
          },
          serviceAccountName: "deviludo-steam-workflow-executor",
          terminationGracePeriodSeconds: 120,
          securityContext: podSecurityContext(),
          containers: [{
            name: "executor", image: receipt.imageReference, imagePullPolicy: "IfNotPresent",
            env: fixedEnvironment(receipt),
            envFrom: [
              { configMapRef: { name: runtimeLock.configMap.name, optional: false } },
              { secretRef: { name: runtimeLock.environmentSecret.name, optional: false } },
            ],
            resources: {
              requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "4Gi" },
              limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "72Gi" },
            },
            startupProbe: { exec: { command: ["/usr/local/bin/node", "-e",
              "require('node:fs').accessSync('/tmp/deviludo-steam-executor-ready')"] },
              failureThreshold: 120, periodSeconds: 5, timeoutSeconds: 2 },
            readinessProbe: { exec: { command: ["/usr/local/bin/node", "-e",
              "require('node:fs').accessSync('/tmp/deviludo-steam-executor-ready')"] },
              failureThreshold: 2, periodSeconds: 10, timeoutSeconds: 2 },
            securityContext: containerSecurityContext(),
            volumeMounts: [
              { name: "temporary", mountPath: "/tmp" },
              { name: "work", mountPath: "/var/lib/deviludo/steam-publisher" },
              { name: "service-files", mountPath: "/run/secrets/deviludo", readOnly: true },
            ],
          }],
          volumes: [
            { name: "temporary", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
            { name: "work", emptyDir: { sizeLimit: "64Gi" } },
            { name: "service-files", secret: { secretName: runtimeLock.filesSecret.name, defaultMode: 256 } },
          ],
        },
      },
    },
  };
  return Object.freeze({
    schemaVersion: RELEASE_SCHEMA, namespace, receipt, replicas, runtimeLock, timeoutSeconds,
    stages: Object.freeze([
      Object.freeze({ name: "namespace", resources: Object.freeze([namespaceResource]) }),
      Object.freeze({ name: "security", resources: Object.freeze([serviceAccount, networkPolicy]) }),
      Object.freeze({ name: "workload", resources: Object.freeze([deployment]) }),
    ]),
  });
}

export async function applySteamWorkflowExecutorRelease(bundle, context, security, execute = executeKubectl) {
  if (!plainRecord(bundle) || bundle.schemaVersion !== RELEASE_SCHEMA || typeof context !== "string" || !CONTEXT.test(context)
    || !validNamespace(bundle.namespace) || !Number.isSafeInteger(bundle.timeoutSeconds) || !Array.isArray(bundle.stages)
    || bundle.stages.map((stage) => stage.name).join(",") !== "namespace,security,workload") invalid();
  const canonical = renderSteamWorkflowExecutorRelease(bundle.receipt, {
    namespace: bundle.namespace, replicas: bundle.replicas, runtimeLock: bundle.runtimeLock,
    timeoutSeconds: bundle.timeoutSeconds,
  });
  if (JSON.stringify(bundle) !== JSON.stringify(canonical) || !plainRecord(security)
    || !SHA256.test(security.trustPolicyDigest) || typeof security.inspectRuntimeResources !== "function") invalid();
  const authorize = async () => {
    const authorization = verifySteamWorkflowExecutorReleaseAuthorization(
      security.authorization,
      typeof security.loadTrustPolicy === "function" ? await security.loadTrustPolicy() : security.trustPolicy,
      security.trustPolicyDigest,
      { bundle, clusterContext: context, now: typeof security.clock === "function" ? security.clock() : security.now ?? new Date() },
    );
    const runtime = await verifySteamWorkflowExecutorRuntimeLock(bundle.runtimeLock, {
      clusterContext: context, namespace: bundle.namespace,
    }, security.inspectRuntimeResources);
    return Object.freeze({ authorization, runtime });
  };
  let evidence;
  for (const stage of bundle.stages) {
    evidence = await authorize();
    await execute(kubectlApply(context, stage.name === "namespace" ? undefined : bundle.namespace), manifestList(stage.resources));
  }
  await execute({ command: "kubectl", args: [
    "--context", context, "--namespace", bundle.namespace, "wait", "--for=condition=Available",
    `--timeout=${bundle.timeoutSeconds}s`, "deployment/deviludo-steam-workflow-executor",
  ] });
  return Object.freeze({
    schemaVersion: "deviludo.kubernetes-steam-workflow-executor-release-result.v1",
    context, namespace: bundle.namespace, imageReference: bundle.receipt.imageReference,
    sourceRevision: bundle.receipt.sourceRevision, replicas: bundle.replicas,
    authorization: evidence.authorization, runtimeConfiguration: evidence.runtime,
  });
}

function fixedEnvironment(receipt) { return [
  { name: "NODE_ENV", value: "production" }, { name: "NODE_OPTIONS", value: "--enable-source-maps" },
  { name: "NODE_PATH", value: "" }, { name: "HOME", value: "/nonexistent" },
  { name: "PATH", value: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
  { name: "LD_LIBRARY_PATH", value: "" }, { name: "LD_PRELOAD", value: "" },
  { name: "DEVILUDO_CONTAINER_KIND", value: "steam-workflow-executor" },
  { name: "DEVILUDO_PLATFORM_VERSION", value: receipt.platformVersion },
  { name: "DEVILUDO_SOURCE_REVISION", value: receipt.sourceRevision },
  { name: "DEVILUDO_STEAM_EXECUTOR_NATIVE_EXECUTABLE", value: "/opt/deviludo/bin/native-steam-publisher" },
  { name: "DEVILUDO_STEAM_EXECUTOR_NATIVE_CONFIG_FILE", value: "/opt/deviludo/config/native-steam-publisher.json" },
  { name: "DEVILUDO_STEAM_EXECUTOR_WORK_ROOT", value: "/var/lib/deviludo/steam-publisher" },
  { name: "DEVILUDO_STEAM_EXECUTOR_READY_FILE", value: "/tmp/deviludo-steam-executor-ready" },
  { name: "TMPDIR", value: "/tmp" },
]; }
function podSecurityContext() { return { runAsNonRoot: true, runAsUser: 1_000, runAsGroup: 1_000, fsGroup: 1_000,
  fsGroupChangePolicy: "OnRootMismatch", seccompProfile: { type: "RuntimeDefault" } }; }
function containerSecurityContext() { return { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] },
  privileged: false, readOnlyRootFilesystem: true, runAsNonRoot: true }; }
function commonLabels(receipt) { return {
  "app.kubernetes.io/name": "deviludo", "app.kubernetes.io/part-of": "deviludo",
  "app.kubernetes.io/managed-by": "deviludo-steam-workflow-executor-release",
  "app.kubernetes.io/version": receipt.platformVersion, "deviludo.io/source-revision": receipt.sourceRevision,
  "deviludo.io/workload": "steam-workflow-executor",
}; }
function receiptAnnotations(receipt) { return {
  "deviludo.io/steam-workflow-executor-image": receipt.imageReference,
  "deviludo.io/node-base-image": receipt.nodeBaseImage,
  "deviludo.io/native-publisher-image": receipt.nativePublisherImage,
  "deviludo.io/dockerfile-digest": receipt.dockerfileDigest,
  "deviludo.io/package-lock-digest": receipt.packageLockDigest,
}; }
function kubectlApply(context, namespace) { return { command: "kubectl", args: [
  "--context", context, ...(namespace ? ["--namespace", namespace] : []), "apply", "--server-side", "--validate=strict",
  "--field-manager=deviludo-steam-workflow-executor-release", "--filename=-",
] }; }
function manifestList(resources) { return `${JSON.stringify({ apiVersion: "v1", kind: "List", items: resources })}\n`; }
function validNamespace(value) { return typeof value === "string" && value.length <= 63 && DNS_LABEL.test(value); }
function absolute(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value; }
function integer(value, minimum, maximum) { const result = Number(value);
  if (!Number.isSafeInteger(result) || String(result) !== value || result < minimum || result > maximum) invalid(); return result; }
function plainRecord(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
async function executeKubectl(invocation, input) { await new Promise((accept, reject) => {
  const child = spawn(invocation.command, invocation.args, { shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"] });
  child.once("error", reject); child.once("exit", (code, signal) => code === 0 && signal === null
    ? accept() : reject(new Error("Steam workflow executor Kubernetes release command failed")));
  if (input !== undefined) child.stdin.end(input);
}); }
async function digestFile(path) { return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`; }
async function readJson(path) { const source = await readFile(path);
  if (source.length < 2 || source.length > MAX_JSON_BYTES || source.includes(0)) invalid();
  try { return JSON.parse(source.toString("utf8")); } catch { invalid(); } }
function invalid() { throw new Error("Steam workflow executor deployment input is invalid"); }

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const options = parseSteamWorkflowExecutorDeploymentArguments(process.argv.slice(2));
  const packageJson = await readJson(resolve(root, "package.json"));
  const receipt = validateSteamWorkflowExecutorImageReceipt(await readJson(options.receiptPath), {
    platformVersion: packageJson.version,
    dockerfileDigest: await digestFile(resolve(root, "Dockerfile.steam-workflow-executor")),
    packageLockDigest: await digestFile(resolve(root, "package-lock.json")),
  });
  const bundle = renderSteamWorkflowExecutorRelease(receipt, {
    namespace: options.namespace, replicas: options.replicas, timeoutSeconds: options.timeoutSeconds,
    runtimeLock: await readJson(options.runtimeLockPath),
  });
  const output = options.mode === "apply" ? await applySteamWorkflowExecutorRelease(bundle, options.context, {
    authorization: await readJson(options.authorizationPath),
    loadTrustPolicy: () => readJson(options.trustPolicyPath),
    inspectRuntimeResources: inspectSteamWorkflowExecutorRuntimeResources,
    trustPolicyDigest: options.trustPolicyDigest,
  }) : bundle;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[deploy:steam-workflow-executor] release failed\n"); process.exitCode = 1; });
}
