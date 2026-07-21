#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CONTROL_PLANE_CONTAINER_SERVICES } from "./run-control-service.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KUBERNETES_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const OCI_REPOSITORY = "[a-z0-9][a-z0-9.-]*(?::[0-9]{2,5})?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+";
const IMAGE_REFERENCE = new RegExp(`^(?<repository>${OCI_REPOSITORY})@(?<digest>sha256:[a-f0-9]{64})$`);
const BASE_IMAGE = new RegExp(`^(?<repository>${OCI_REPOSITORY}):22\\.(?<minor>\\d+)\\.(?<patch>\\d+)-(?:bookworm|trixie)-slim@sha256:(?<digest>[a-f0-9]{64})$`);
const RECEIPT_KEYS = Object.freeze([
  "attestations",
  "baseImage",
  "completedAt",
  "dockerfileDigest",
  "imageDigest",
  "imageReference",
  "packageLockDigest",
  "platform",
  "platformVersion",
  "schemaVersion",
  "sourceRevision",
]);
const RELEASE_SCHEMA = "deviludo.kubernetes-control-release.v1";

// A port is exposed only for a process that owns an authenticated in-cluster
// server. The two absent services are background workers and deliberately get
// neither a Kubernetes Service nor a misleading TCP readiness probe.
export const CONTROL_SERVICE_PORTS = Object.freeze({
  "agent-execution-broker": 4_746,
  "agent-supply-chain": 4_755,
  "agent-worker-workflow": 4_200,
  "control-plane": 4_100,
  "control-plane-workflow": 4_200,
  "delivery-projection": 4_557,
  "evidence-archive": 4_443,
  "github-authorization": 4_558,
  "identity": 4_560,
  "inference-gateway": 4_743,
  "project-repository": 4_559,
  "provider-monitor": 4_551,
  "runner-control-workflow": 4_200,
  "runner-ingress": 4_300,
  "runner-toolchain-publisher": 4_865,
  "scm-candidate-broker": 4_545,
  "scm-merge-broker": 4_546,
  "scm-proxy-workflow": 4_200,
  "secret-broker": 4_762,
  "source-snapshot": 4_543,
  "spec-dialogue": 4_544,
  "spec-model-broker": 4_773,
  "spec-workflow-bridge": 4_555,
  "steam-access": 4_575,
  "steam-approval-monitor": 4_550,
  "steam-publisher-workflow": 4_200,
  "steam-secure-ui": 4_576,
  "steam-workflow-broker": 4_745,
  "user-acceptance": 4_547,
});

const CONTROL_SERVICE_PORT_ENVIRONMENT = Object.freeze({
  "agent-execution-broker": "DEVILUDO_AGENT_EXECUTION_BROKER_SERVER_PORT",
  "agent-supply-chain": "DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_PORT",
  "agent-worker-workflow": "DEVILUDO_WORKFLOW_SERVICE_PORT",
  "control-plane": "DEVILUDO_CONTROL_PLANE_PORT",
  "control-plane-workflow": "DEVILUDO_WORKFLOW_SERVICE_PORT",
  "delivery-projection": "DEVILUDO_DELIVERY_PROJECTION_PORT",
  "evidence-archive": "DEVILUDO_EVIDENCE_ARCHIVE_PORT",
  "github-authorization": "DEVILUDO_GITHUB_AUTH_PORT",
  "identity": "DEVILUDO_IDENTITY_PORT",
  "inference-gateway": "DEVILUDO_INFERENCE_GATEWAY_PORT",
  "project-repository": "DEVILUDO_PROJECT_REPOSITORY_PORT",
  "provider-monitor": "DEVILUDO_PROVIDER_MONITOR_PORT",
  "runner-control-workflow": "DEVILUDO_WORKFLOW_SERVICE_PORT",
  "runner-ingress": "DEVILUDO_RUNNER_INGRESS_PORT",
  "runner-toolchain-publisher": "DEVILUDO_RUNNER_TOOLCHAIN_PORT",
  "scm-candidate-broker": "DEVILUDO_SCM_CANDIDATE_SERVER_PORT",
  "scm-merge-broker": "DEVILUDO_SCM_MERGE_SERVER_PORT",
  "scm-proxy-workflow": "DEVILUDO_WORKFLOW_SERVICE_PORT",
  "secret-broker": "DEVILUDO_SECRET_BROKER_PORT",
  "source-snapshot": "DEVILUDO_SOURCE_SNAPSHOT_PORT",
  "spec-dialogue": "DEVILUDO_SPEC_DIALOGUE_PORT",
  "spec-model-broker": "DEVILUDO_SPEC_MODEL_PORT",
  "spec-workflow-bridge": "DEVILUDO_SPEC_WORKFLOW_PORT",
  "steam-access": "DEVILUDO_STEAM_ACCESS_PORT",
  "steam-approval-monitor": "DEVILUDO_STEAM_APPROVAL_PORT",
  "steam-publisher-workflow": "DEVILUDO_WORKFLOW_SERVICE_PORT",
  "steam-secure-ui": "DEVILUDO_STEAM_SECURE_UI_PORT",
  "steam-workflow-broker": "DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_PORT",
  "user-acceptance": "DEVILUDO_USER_ACCEPTANCE_PORT",
});

export function assertControlServiceDeploymentClassification(
  services = CONTROL_PLANE_CONTAINER_SERVICES,
  ports = CONTROL_SERVICE_PORTS,
) {
  const declared = [...services].sort();
  const networked = Object.keys(ports).sort();
  if (networked.some((service) => !declared.includes(service))
    || JSON.stringify(networked) !== JSON.stringify(Object.keys(CONTROL_SERVICE_PORT_ENVIRONMENT).sort())
    || declared.some((service) => !networked.includes(service) && !new Set(["agent-configuration", "temporal-worker"]).has(service))) {
    throw new Error("Control-plane deployment classification is incomplete");
  }
  return Object.freeze({ networked: Object.freeze(networked), workers: Object.freeze(["agent-configuration", "temporal-worker"]) });
}

export function validateControlPlaneImageReceipt(receipt, expected) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(RECEIPT_KEYS)
    || receipt.schemaVersion !== "deviludo.control-plane-image-receipt.v1"
    || !/^linux\/(?:amd64|arm64)$/.test(receipt.platform)
    || !PACKAGE_VERSION.test(receipt.platformVersion)
    || !SOURCE_REVISION.test(receipt.sourceRevision)
    || !SHA256.test(receipt.imageDigest)
    || !SHA256.test(receipt.dockerfileDigest)
    || !SHA256.test(receipt.packageLockDigest)
    || JSON.stringify(receipt.attestations) !== JSON.stringify(["buildkit-provenance-mode-max", "buildkit-sbom"])) invalidReceipt();
  const image = typeof receipt.imageReference === "string" ? IMAGE_REFERENCE.exec(receipt.imageReference) : null;
  const base = typeof receipt.baseImage === "string" ? BASE_IMAGE.exec(receipt.baseImage) : null;
  if (!image || image.groups?.digest !== receipt.imageDigest || !base
    || !base.groups?.repository.endsWith("/node") || Number(base.groups.minor) < 13
    || typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt))
    || new Date(receipt.completedAt).toISOString() !== receipt.completedAt) invalidReceipt();
  if (!expected || receipt.platformVersion !== expected.platformVersion
    || receipt.dockerfileDigest !== expected.dockerfileDigest
    || receipt.packageLockDigest !== expected.packageLockDigest) invalidReceipt();
  return Object.freeze({ ...receipt, attestations: Object.freeze([...receipt.attestations]) });
}

export function parseControlPlaneDeploymentArguments(argv) {
  if (!Array.isArray(argv)) invalidArguments();
  const flags = new Set();
  const values = new Map();
  const flagNames = new Set(["--apply", "--render"]);
  const valueNames = new Set(["--context", "--namespace", "--receipt", "--replicas", "--services", "--timeout-seconds"]);
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (flagNames.has(name)) {
      if (flags.has(name)) invalidArguments();
      flags.add(name);
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!valueNames.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) {
      invalidArguments();
    }
    values.set(name, value);
    index += 2;
  }
  if (flags.has("--apply") && flags.has("--render")) invalidArguments();
  const mode = flags.has("--apply") ? "apply" : "render";
  const receiptPath = values.get("--receipt");
  const context = values.get("--context");
  const namespace = values.get("--namespace") ?? "deviludo-system";
  const replicas = exactInteger(values.get("--replicas") ?? "1", 1, 10);
  const timeoutSeconds = exactInteger(values.get("--timeout-seconds") ?? "900", 60, 3_600);
  if (typeof receiptPath !== "string" || !isAbsolute(receiptPath) || !validNamespace(namespace)
    || (mode === "apply" && (typeof context !== "string" || !KUBERNETES_CONTEXT.test(context)))
    || (mode === "render" && context !== undefined)) invalidArguments();
  const services = parseServices(values.get("--services"));
  return Object.freeze({ context, mode, namespace, receiptPath, replicas, services, timeoutSeconds });
}

export function renderControlPlaneRelease(receipt, options = {}) {
  assertControlServiceDeploymentClassification();
  receipt = validateControlPlaneImageReceipt(receipt, {
    platformVersion: receipt?.platformVersion,
    dockerfileDigest: receipt?.dockerfileDigest,
    packageLockDigest: receipt?.packageLockDigest,
  });
  const namespace = options.namespace ?? "deviludo-system";
  const replicas = options.replicas ?? 1;
  const timeoutSeconds = options.timeoutSeconds ?? 900;
  const services = options.services ?? CONTROL_PLANE_CONTAINER_SERVICES;
  if (!validNamespace(namespace) || !Number.isSafeInteger(replicas) || replicas < 1 || replicas > 10
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 3_600
    || !Array.isArray(services) || services.length < 1 || new Set(services).size !== services.length
    || services.some((service) => !CONTROL_PLANE_CONTAINER_SERVICES.includes(service))) invalidArguments();
  const selectedServices = [...services].sort();
  const identity = `${receipt.sourceRevision.slice(0, 12)}-${receipt.imageDigest.slice(7, 19)}`;
  const migrationJobName = `deviludo-schema-${identity}`;
  const common = commonLabels(receipt);
  const namespaceResource = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        ...common,
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
      annotations: receiptAnnotations(receipt),
    },
  };
  const serviceAccount = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name: "deviludo-control", namespace, labels: common },
    automountServiceAccountToken: false,
    imagePullSecrets: [{ name: "deviludo-control-registry" }],
  };
  const networkPolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "deviludo-default-deny", namespace, labels: common },
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  };
  const migration = migrationJob(receipt, namespace, migrationJobName, timeoutSeconds, common);
  const workloads = selectedServices.flatMap((service) => {
    const deployment = serviceDeployment(receipt, namespace, service, replicas, common);
    const port = CONTROL_SERVICE_PORTS[service];
    return port === undefined ? [deployment] : [serviceResource(namespace, service, port, common), deployment];
  });
  return Object.freeze({
    schemaVersion: RELEASE_SCHEMA,
    namespace,
    migrationJobName,
    receipt,
    replicas,
    services: Object.freeze(selectedServices),
    timeoutSeconds,
    stages: Object.freeze([
      Object.freeze({ name: "namespace", resources: Object.freeze([namespaceResource]) }),
      Object.freeze({ name: "migration", resources: Object.freeze([serviceAccount, networkPolicy, migration]) }),
      Object.freeze({ name: "workloads", resources: Object.freeze(workloads) }),
    ]),
  });
}

export async function applyControlPlaneRelease(bundle, context, execute = executeKubectl) {
  if (!bundle || bundle.schemaVersion !== RELEASE_SCHEMA || typeof context !== "string"
    || !KUBERNETES_CONTEXT.test(context) || !validNamespace(bundle.namespace)
    || !Number.isSafeInteger(bundle.timeoutSeconds) || !DNS_LABEL.test(bundle.migrationJobName)
    || !Array.isArray(bundle.stages) || bundle.stages.map((stage) => stage.name).join(",") !== "namespace,migration,workloads") {
    invalidArguments();
  }
  const canonical = renderControlPlaneRelease(bundle.receipt, {
    namespace: bundle.namespace,
    replicas: bundle.replicas,
    services: bundle.services,
    timeoutSeconds: bundle.timeoutSeconds,
  });
  if (JSON.stringify(bundle) !== JSON.stringify(canonical)) invalidArguments();
  const [namespaceStage, migrationStage, workloadStage] = bundle.stages;
  await execute(kubectlApply(context, undefined), manifestList(namespaceStage.resources));
  const migrationJob = migrationStage.resources.find((resource) => resource.kind === "Job");
  const migrationPrerequisites = migrationStage.resources.filter((resource) => resource.kind !== "Job");
  if (!migrationJob || migrationPrerequisites.length !== migrationStage.resources.length - 1) invalidArguments();
  await execute(kubectlApply(context, bundle.namespace), manifestList(migrationPrerequisites));
  await execute(kubectlApply(context, bundle.namespace), manifestList([migrationJob]));
  await execute({
    command: "kubectl",
    args: [
      "--context", context,
      "--namespace", bundle.namespace,
      "wait", "--for=condition=complete",
      `--timeout=${bundle.timeoutSeconds}s`,
      `job/${bundle.migrationJobName}`,
    ],
  });
  await execute(kubectlApply(context, bundle.namespace), manifestList(workloadStage.resources));
  await execute({
    command: "kubectl",
    args: [
      "--context", context,
      "--namespace", bundle.namespace,
      "wait", "--for=condition=Available",
      `--timeout=${bundle.timeoutSeconds}s`,
      "deployment",
      "--selector", `app.kubernetes.io/part-of=deviludo,deviludo.io/source-revision=${bundle.receipt.sourceRevision}`,
    ],
  });
  return Object.freeze({
    schemaVersion: "deviludo.kubernetes-control-release-result.v1",
    context,
    namespace: bundle.namespace,
    imageReference: bundle.receipt.imageReference,
    sourceRevision: bundle.receipt.sourceRevision,
    migrationJobName: bundle.migrationJobName,
    deployedServices: Object.freeze([...bundle.services]),
  });
}

function migrationJob(receipt, namespace, name, timeoutSeconds, labels) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace, labels, annotations: receiptAnnotations(receipt) },
    spec: {
      activeDeadlineSeconds: timeoutSeconds,
      backoffLimit: 0,
      ttlSecondsAfterFinished: 86_400,
      template: {
        metadata: { labels: { ...labels, "app.kubernetes.io/component": "schema-migrator" }, annotations: receiptAnnotations(receipt) },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          nodeSelector: platformNodeSelector(receipt),
          restartPolicy: "Never",
          serviceAccountName: "deviludo-control",
          securityContext: podSecurityContext(),
          containers: [{
            name: "schema-migrator",
            image: receipt.imageReference,
            imagePullPolicy: "IfNotPresent",
            command: ["node", "scripts/production/migrate-postgres.mjs"],
            env: fixedEnvironment(receipt).concat([
              { name: "DEVILUDO_MIGRATION_DATABASE_URL_FILE", value: "/run/secrets/migration/database-url" },
              { name: "DEVILUDO_MIGRATION_POSTGRES_CA_FILE", value: "/run/secrets/migration/ca.pem" },
              { name: "DEVILUDO_MIGRATION_POSTGRES_CERT_FILE", value: "/run/secrets/migration/client.crt" },
              { name: "DEVILUDO_MIGRATION_POSTGRES_KEY_FILE", value: "/run/secrets/migration/client.key" },
            ]),
            resources: containerResources(),
            securityContext: containerSecurityContext(),
            volumeMounts: [
              { name: "temporary", mountPath: "/tmp" },
              { name: "migration-credentials", mountPath: "/run/secrets/migration", readOnly: true },
            ],
          }],
          volumes: [
            temporaryVolume(),
            { name: "migration-credentials", secret: { secretName: "deviludo-schema-migrator-files", defaultMode: 256 } },
          ],
        },
      },
    },
  };
}

function serviceDeployment(receipt, namespace, service, replicas, labels) {
  const name = `deviludo-${service}`;
  const port = CONTROL_SERVICE_PORTS[service];
  const selector = { "app.kubernetes.io/name": "deviludo", "app.kubernetes.io/component": service };
  const container = {
    name: "service",
    image: receipt.imageReference,
    imagePullPolicy: "IfNotPresent",
    env: fixedEnvironment(receipt).concat([
      { name: "DEVILUDO_SERVICE", value: service },
      ...(port === undefined ? [] : [{ name: CONTROL_SERVICE_PORT_ENVIRONMENT[service], value: String(port) }]),
    ]),
    envFrom: [
      { configMapRef: { name: `${name}-config`, optional: false } },
      { secretRef: { name: `${name}-environment`, optional: false } },
    ],
    resources: containerResources(),
    securityContext: containerSecurityContext(),
    volumeMounts: [
      { name: "temporary", mountPath: "/tmp" },
      { name: "service-files", mountPath: "/run/secrets/deviludo", readOnly: true },
    ],
  };
  if (port !== undefined) {
    container.ports = [{ name: "tcp", containerPort: port, protocol: "TCP" }];
    container.startupProbe = { tcpSocket: { port: "tcp" }, failureThreshold: 30, periodSeconds: 5, timeoutSeconds: 2 };
    container.readinessProbe = { tcpSocket: { port: "tcp" }, failureThreshold: 3, periodSeconds: 10, timeoutSeconds: 2 };
    container.livenessProbe = { tcpSocket: { port: "tcp" }, failureThreshold: 3, periodSeconds: 20, timeoutSeconds: 2 };
  }
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels: { ...labels, ...selector }, annotations: receiptAnnotations(receipt) },
    spec: {
      replicas,
      minReadySeconds: 10,
      progressDeadlineSeconds: 600,
      revisionHistoryLimit: 3,
      selector: { matchLabels: selector },
      strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      template: {
        metadata: {
          labels: { ...labels, ...selector },
          annotations: receiptAnnotations(receipt),
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          nodeSelector: platformNodeSelector(receipt),
          serviceAccountName: "deviludo-control",
          terminationGracePeriodSeconds: 30,
          securityContext: podSecurityContext(),
          containers: [container],
          volumes: [
            temporaryVolume(),
            { name: "service-files", secret: { secretName: `${name}-files`, defaultMode: 256 } },
          ],
        },
      },
    },
  };
}

function serviceResource(namespace, service, port, labels) {
  const name = `deviludo-${service}`;
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels: { ...labels, "app.kubernetes.io/component": service } },
    spec: {
      type: "ClusterIP",
      selector: { "app.kubernetes.io/name": "deviludo", "app.kubernetes.io/component": service },
      ports: [{ name: "tcp", port, targetPort: "tcp", protocol: "TCP" }],
    },
  };
}

function fixedEnvironment(receipt) {
  return [
    { name: "NODE_ENV", value: "production" },
    { name: "DEVILUDO_PLATFORM_VERSION", value: receipt.platformVersion },
    { name: "DEVILUDO_SOURCE_REVISION", value: receipt.sourceRevision },
    { name: "TMPDIR", value: "/tmp" },
  ];
}

function podSecurityContext() {
  return {
    runAsNonRoot: true,
    runAsUser: 1_000,
    runAsGroup: 1_000,
    fsGroup: 1_000,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  };
}

function containerSecurityContext() {
  return {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    privileged: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
  };
}

function containerResources() {
  return { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "1Gi" } };
}

function temporaryVolume() {
  return { name: "temporary", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } };
}

function platformNodeSelector(receipt) {
  return { "kubernetes.io/os": "linux", "kubernetes.io/arch": receipt.platform.slice("linux/".length) };
}

function commonLabels(receipt) {
  return {
    "app.kubernetes.io/name": "deviludo",
    "app.kubernetes.io/part-of": "deviludo",
    "app.kubernetes.io/managed-by": "deviludo-release",
    "app.kubernetes.io/version": receipt.platformVersion,
    "deviludo.io/source-revision": receipt.sourceRevision,
  };
}

function receiptAnnotations(receipt) {
  return {
    "deviludo.io/control-image": receipt.imageReference,
    "deviludo.io/dockerfile-digest": receipt.dockerfileDigest,
    "deviludo.io/package-lock-digest": receipt.packageLockDigest,
  };
}

function kubectlApply(context, namespace) {
  return {
    command: "kubectl",
    args: [
      "--context", context,
      ...(namespace ? ["--namespace", namespace] : []),
      "apply",
      "--server-side",
      "--validate=strict",
      "--field-manager=deviludo-release",
      "--filename=-",
    ],
  };
}

function manifestList(resources) {
  return `${JSON.stringify({ apiVersion: "v1", kind: "List", items: resources })}\n`;
}

function parseServices(value) {
  if (value === undefined) return Object.freeze([...CONTROL_PLANE_CONTAINER_SERVICES]);
  const services = value.split(",");
  if (services.length < 1 || services.some((service) => !service || !CONTROL_PLANE_CONTAINER_SERVICES.includes(service))
    || new Set(services).size !== services.length) invalidArguments();
  return Object.freeze(services.sort());
}

function validNamespace(value) {
  return typeof value === "string" && value.length <= 63 && DNS_LABEL.test(value);
}

function exactInteger(value, minimum, maximum) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || String(result) !== value || result < minimum || result > maximum) invalidArguments();
  return result;
}

async function executeKubectl(invocation, input) {
  await new Promise((accept, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) accept();
      else reject(new Error("Kubernetes release command failed"));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function digestFile(path) {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

function invalidReceipt() {
  throw new Error("Control-plane image receipt is invalid");
}

function invalidArguments() {
  throw new Error("Control-plane deployment input is invalid");
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const options = parseControlPlaneDeploymentArguments(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const receipt = validateControlPlaneImageReceipt(
    JSON.parse(await readFile(options.receiptPath, "utf8")),
    {
      platformVersion: packageJson.version,
      dockerfileDigest: await digestFile(resolve(root, "Dockerfile.control-plane")),
      packageLockDigest: await digestFile(resolve(root, "package-lock.json")),
    },
  );
  const bundle = renderControlPlaneRelease(receipt, options);
  const output = options.mode === "apply"
    ? await applyControlPlaneRelease(bundle, options.context)
    : bundle;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[deploy:control] release failed\n");
    process.exitCode = 1;
  });
}
