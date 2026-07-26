#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyAgentMicrovmCredentialIssuerReleaseAuthorization } from "./agent-microvm-credential-issuer-release-authorization.mjs";
import { validateAgentMicrovmCredentialIssuerImageReceipt } from "./build-agent-microvm-credential-issuer-image.mjs";
import {
  inspectAgentMicrovmCredentialIssuerRuntimeResources,
  validateAgentMicrovmCredentialIssuerRuntimeLock,
  verifyAgentMicrovmCredentialIssuerRuntimeLock,
} from "./lock-agent-microvm-credential-issuer-runtime.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RELEASE_SCHEMA = "deviludo.kubernetes-agent-microvm-credential-issuer-release.v1";
const MAX_JSON_BYTES = 1024 * 1024;
const SERVICE_PORT = 4_673;

export function parseAgentMicrovmCredentialIssuerDeploymentArguments(argv) {
  if (!Array.isArray(argv)) invalidArguments();
  const flags = new Set(); const values = new Map();
  const flagNames = new Set(["--apply", "--render"]);
  const valueNames = new Set([
    "--authorization", "--context", "--namespace", "--receipt", "--replicas", "--runtime-lock",
    "--timeout-seconds", "--trust-policy", "--trust-policy-digest",
  ]);
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (flagNames.has(name)) { if (flags.has(name)) invalidArguments(); flags.add(name); index += 1; continue; }
    const value = argv[index + 1];
    if (!valueNames.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) {
      invalidArguments();
    }
    values.set(name, value); index += 2;
  }
  if (flags.has("--apply") && flags.has("--render")) invalidArguments();
  const mode = flags.has("--apply") ? "apply" : "render";
  const receiptPath = values.get("--receipt");
  const runtimeLockPath = values.get("--runtime-lock");
  const authorizationPath = values.get("--authorization");
  const trustPolicyPath = values.get("--trust-policy");
  const trustPolicyDigest = values.get("--trust-policy-digest");
  const context = values.get("--context");
  const namespace = values.get("--namespace") ?? "deviludo-agent-credentials";
  const replicas = exactInteger(values.get("--replicas") ?? "1", 1, 3);
  const timeoutSeconds = exactInteger(values.get("--timeout-seconds") ?? "900", 60, 3_600);
  if (!absolutePath(receiptPath) || !absolutePath(runtimeLockPath) || !validNamespace(namespace)
    || (mode === "apply" && (typeof context !== "string" || !CONTEXT.test(context)))
    || (mode === "apply" && (!absolutePath(authorizationPath) || !absolutePath(trustPolicyPath)
      || typeof trustPolicyDigest !== "string" || !SHA256.test(trustPolicyDigest)))
    || (mode === "render" && [context, authorizationPath, trustPolicyPath, trustPolicyDigest]
      .some((value) => value !== undefined))) invalidArguments();
  return Object.freeze({
    authorizationPath, context, mode, namespace, receiptPath, replicas, runtimeLockPath,
    timeoutSeconds, trustPolicyDigest, trustPolicyPath,
  });
}

export function renderAgentMicrovmCredentialIssuerRelease(receipt, options = {}) {
  receipt = validateAgentMicrovmCredentialIssuerImageReceipt(receipt, {
    platformVersion: receipt?.platformVersion, dockerfileDigest: receipt?.dockerfileDigest,
    packageLockDigest: receipt?.packageLockDigest, nodeBaseImage: receipt?.nodeBaseImage,
    toolchainBaseImage: receipt?.toolchainBaseImage, sourceRevision: receipt?.sourceRevision,
    platform: receipt?.platform,
  });
  const namespace = options.namespace ?? "deviludo-agent-credentials";
  const replicas = options.replicas ?? 1;
  const timeoutSeconds = options.timeoutSeconds ?? 900;
  if (!validNamespace(namespace) || !Number.isSafeInteger(replicas) || replicas < 1 || replicas > 3
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 3_600) invalidArguments();
  const runtimeLock = validateAgentMicrovmCredentialIssuerRuntimeLock(options.runtimeLock, { namespace });
  const common = commonLabels(receipt);
  const selector = { "app.kubernetes.io/name": "deviludo", "app.kubernetes.io/component": "agent-microvm-credential-issuer" };
  const annotations = receiptAnnotations(receipt);
  const namespaceResource = {
    apiVersion: "v1", kind: "Namespace",
    metadata: { name: namespace, labels: { ...common,
      "pod-security.kubernetes.io/audit": "restricted", "pod-security.kubernetes.io/enforce": "restricted",
      "pod-security.kubernetes.io/warn": "restricted" }, annotations },
  };
  const serviceAccount = {
    apiVersion: "v1", kind: "ServiceAccount",
    metadata: { name: "deviludo-agent-microvm-credential-issuer", namespace, labels: common },
    automountServiceAccountToken: false,
    imagePullSecrets: [{ name: runtimeLock.registrySecret.name }],
  };
  const networkPolicy = {
    apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
    metadata: { name: "deviludo-agent-microvm-credential-issuer-default-deny", namespace, labels: common },
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  };
  const service = {
    apiVersion: "v1", kind: "Service",
    metadata: { name: "deviludo-agent-microvm-credential-issuer", namespace, labels: { ...common, ...selector } },
    spec: { type: "ClusterIP", selector,
      ports: [{ name: "mtls", port: SERVICE_PORT, targetPort: "mtls", protocol: "TCP" }] },
  };
  const deployment = {
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name: "deviludo-agent-microvm-credential-issuer", namespace,
      labels: { ...common, ...selector }, annotations },
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
            "deviludo.io/workload": "agent-microvm-credential-issuer",
          },
          serviceAccountName: "deviludo-agent-microvm-credential-issuer",
          terminationGracePeriodSeconds: 60,
          securityContext: podSecurityContext(),
          containers: [{
            name: "issuer",
            image: receipt.imageReference,
            imagePullPolicy: "IfNotPresent",
            env: fixedEnvironment(receipt),
            envFrom: [
              { configMapRef: { name: runtimeLock.configMap.name, optional: false } },
              { secretRef: { name: runtimeLock.environmentSecret.name, optional: false } },
            ],
            ports: [{ name: "mtls", containerPort: SERVICE_PORT, protocol: "TCP" }],
            startupProbe: { tcpSocket: { port: "mtls" }, failureThreshold: 60, periodSeconds: 5, timeoutSeconds: 2 },
            readinessProbe: { tcpSocket: { port: "mtls" }, failureThreshold: 3, periodSeconds: 10, timeoutSeconds: 2 },
            livenessProbe: { tcpSocket: { port: "mtls" }, failureThreshold: 3, periodSeconds: 20, timeoutSeconds: 2 },
            resources: {
              requests: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "128Mi" },
              limits: { cpu: "2", memory: "2Gi", "ephemeral-storage": "512Mi" },
            },
            securityContext: containerSecurityContext(),
            volumeMounts: [
              { name: "temporary", mountPath: "/tmp" },
              { name: "credential-images", mountPath: "/run/deviludo-credential-images" },
              { name: "service-files", mountPath: "/run/secrets/guest-credential-issuer", readOnly: true },
            ],
          }],
          volumes: [
            { name: "temporary", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
            { name: "credential-images", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
            { name: "service-files", secret: { secretName: runtimeLock.filesSecret.name, defaultMode: 288 } },
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
      Object.freeze({ name: "workload", resources: Object.freeze([service, deployment]) }),
    ]),
  });
}

export async function applyAgentMicrovmCredentialIssuerRelease(bundle, context, security, execute = executeKubectl) {
  if (!plainRecord(bundle) || bundle.schemaVersion !== RELEASE_SCHEMA || typeof context !== "string" || !CONTEXT.test(context)
    || !validNamespace(bundle.namespace) || !Number.isSafeInteger(bundle.timeoutSeconds) || !Array.isArray(bundle.stages)
    || bundle.stages.map((stage) => stage.name).join(",") !== "namespace,security,workload") invalidArguments();
  const canonical = renderAgentMicrovmCredentialIssuerRelease(bundle.receipt, {
    namespace: bundle.namespace, replicas: bundle.replicas,
    runtimeLock: bundle.runtimeLock, timeoutSeconds: bundle.timeoutSeconds,
  });
  if (JSON.stringify(bundle) !== JSON.stringify(canonical) || !plainRecord(security)
    || typeof security.trustPolicyDigest !== "string" || !SHA256.test(security.trustPolicyDigest)
    || typeof security.inspectRuntimeResources !== "function") invalidArguments();
  const authorizeStage = async () => {
    const authorization = verifyAgentMicrovmCredentialIssuerReleaseAuthorization(
      security.authorization,
      typeof security.loadTrustPolicy === "function" ? await security.loadTrustPolicy() : security.trustPolicy,
      security.trustPolicyDigest,
      { bundle, clusterContext: context,
        now: typeof security.clock === "function" ? security.clock() : security.now ?? new Date() },
    );
    const runtime = await verifyAgentMicrovmCredentialIssuerRuntimeLock(bundle.runtimeLock, {
      clusterContext: context, namespace: bundle.namespace,
    }, security.inspectRuntimeResources);
    return Object.freeze({ authorization, runtime });
  };
  let evidence;
  for (const stage of bundle.stages) {
    evidence = await authorizeStage();
    await execute(kubectlApply(context, stage.name === "namespace" ? undefined : bundle.namespace), manifestList(stage.resources));
  }
  await execute({ command: "kubectl", args: [
    "--context", context, "--namespace", bundle.namespace,
    "wait", "--for=condition=Available", `--timeout=${bundle.timeoutSeconds}s`,
    "deployment/deviludo-agent-microvm-credential-issuer",
  ] });
  return Object.freeze({
    schemaVersion: "deviludo.kubernetes-agent-microvm-credential-issuer-release-result.v1",
    context, namespace: bundle.namespace, imageReference: bundle.receipt.imageReference,
    sourceRevision: bundle.receipt.sourceRevision, replicas: bundle.replicas,
    authorization: evidence.authorization, runtimeConfiguration: evidence.runtime,
  });
}

function fixedEnvironment(receipt) {
  return [
    { name: "NODE_ENV", value: "production" },
    { name: "NODE_OPTIONS", value: "--enable-source-maps" },
    { name: "NODE_PATH", value: "" },
    { name: "HOME", value: "/nonexistent" },
    { name: "PATH", value: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
    { name: "LD_LIBRARY_PATH", value: "" },
    { name: "LD_PRELOAD", value: "" },
    { name: "DEVILUDO_CONTAINER_KIND", value: "agent-microvm-credential-issuer" },
    { name: "DEVILUDO_PLATFORM_VERSION", value: receipt.platformVersion },
    { name: "DEVILUDO_SOURCE_REVISION", value: receipt.sourceRevision },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_HOST", value: "0.0.0.0" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_PORT", value: String(SERVICE_PORT) },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_WORK_ROOT", value: "/run/deviludo-credential-images" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_MKE2FS_EXECUTABLE", value: "/usr/sbin/mke2fs" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_SERVER_TLS_KEY_FILE", value: "/run/secrets/guest-credential-issuer/server.key" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_SERVER_TLS_CERT_FILE", value: "/run/secrets/guest-credential-issuer/server.crt" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_CLIENT_CA_FILE", value: "/run/secrets/guest-credential-issuer/agent-worker-ca.crt" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_ATTESTATION_PRIVATE_KEY_FILE", value: "/run/secrets/guest-credential-issuer/attestation-private.pem" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_RELAY_TLS_KEY_FILE", value: "/run/secrets/guest-credential-issuer/relay-server.key" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_RELAY_TLS_CERT_FILE", value: "/run/secrets/guest-credential-issuer/relay-server.crt" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_GATEWAY_TLS_KEY_FILE", value: "/run/secrets/guest-credential-issuer/inference-gateway-client.key" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_GATEWAY_TLS_CERT_FILE", value: "/run/secrets/guest-credential-issuer/inference-gateway-client.crt" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_GATEWAY_CA_FILE", value: "/run/secrets/guest-credential-issuer/inference-gateway-ca.crt" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_EPHEMERAL_SECRET_TLS_KEY_FILE", value: "/run/secrets/guest-credential-issuer/ephemeral-secret-client.key" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_EPHEMERAL_SECRET_TLS_CERT_FILE", value: "/run/secrets/guest-credential-issuer/ephemeral-secret-client.crt" },
    { name: "DEVILUDO_GUEST_CREDENTIAL_ISSUER_EPHEMERAL_SECRET_CA_FILE", value: "/run/secrets/guest-credential-issuer/ephemeral-secret-ca.crt" },
    { name: "TMPDIR", value: "/tmp" },
    { name: "DISABLE_UPDATES", value: "1" },
  ];
}
function podSecurityContext() { return { runAsNonRoot: true, runAsUser: 1_000, runAsGroup: 1_000, fsGroup: 1_000,
  fsGroupChangePolicy: "OnRootMismatch", seccompProfile: { type: "RuntimeDefault" } }; }
function containerSecurityContext() { return { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] },
  privileged: false, readOnlyRootFilesystem: true, runAsNonRoot: true }; }
function commonLabels(receipt) { return {
  "app.kubernetes.io/name": "deviludo", "app.kubernetes.io/part-of": "deviludo",
  "app.kubernetes.io/managed-by": "deviludo-agent-microvm-credential-issuer-release",
  "app.kubernetes.io/version": receipt.platformVersion, "deviludo.io/source-revision": receipt.sourceRevision,
  "deviludo.io/workload": "agent-microvm-credential-issuer",
}; }
function receiptAnnotations(receipt) { return {
  "deviludo.io/agent-microvm-credential-issuer-image": receipt.imageReference,
  "deviludo.io/toolchain-base-image": receipt.toolchainBaseImage,
  "deviludo.io/dockerfile-digest": receipt.dockerfileDigest,
  "deviludo.io/package-lock-digest": receipt.packageLockDigest,
}; }
function kubectlApply(context, namespace) { return { command: "kubectl", args: [
  "--context", context, ...(namespace ? ["--namespace", namespace] : []),
  "apply", "--server-side", "--validate=strict",
  "--field-manager=deviludo-agent-microvm-credential-issuer-release", "--filename=-",
] }; }
function manifestList(resources) { return `${JSON.stringify({ apiVersion: "v1", kind: "List", items: resources })}\n`; }
function validNamespace(value) { return typeof value === "string" && value.length <= 63 && DNS_LABEL.test(value); }
function absolutePath(value) { return typeof value === "string" && isAbsolute(value); }
function exactInteger(value, minimum, maximum) { const result = Number(value);
  if (!Number.isSafeInteger(result) || String(result) !== value || result < minimum || result > maximum) invalidArguments(); return result; }
function plainRecord(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
async function executeKubectl(invocation, input) { await new Promise((accept, reject) => {
  const child = spawn(invocation.command, invocation.args, {
    shell: false, stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
  });
  child.once("error", reject); child.once("exit", (code, signal) => code === 0 && signal === null
    ? accept() : reject(new Error("Agent microVM credential issuer Kubernetes release command failed")));
  if (input !== undefined) child.stdin.end(input);
}); }
async function digestFile(path) { return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`; }
async function readJson(path) { const source = await readFile(path);
  if (source.length < 2 || source.length > MAX_JSON_BYTES || source.includes(0)) invalidArguments();
  try { return JSON.parse(source.toString("utf8")); } catch { invalidArguments(); } }
function invalidArguments() { throw new Error("Agent microVM credential issuer deployment input is invalid"); }

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const options = parseAgentMicrovmCredentialIssuerDeploymentArguments(process.argv.slice(2));
  const packageJson = await readJson(resolve(root, "package.json"));
  const receipt = validateAgentMicrovmCredentialIssuerImageReceipt(await readJson(options.receiptPath), {
    platformVersion: packageJson.version,
    dockerfileDigest: await digestFile(resolve(root, "Dockerfile.agent-microvm-credential-issuer")),
    packageLockDigest: await digestFile(resolve(root, "package-lock.json")),
  });
  const bundle = renderAgentMicrovmCredentialIssuerRelease(receipt, {
    ...options, runtimeLock: await readJson(options.runtimeLockPath),
  });
  const output = options.mode === "apply"
    ? await applyAgentMicrovmCredentialIssuerRelease(bundle, options.context, {
      authorization: await readJson(options.authorizationPath),
      loadTrustPolicy: () => readJson(options.trustPolicyPath),
      inspectRuntimeResources: inspectAgentMicrovmCredentialIssuerRuntimeResources,
      trustPolicyDigest: options.trustPolicyDigest,
    })
    : bundle;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[deploy:agent-microvm-credential-issuer] release failed\n"); process.exitCode = 1; });
}
