import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  applyControlPlaneRelease,
  assertControlServiceDeploymentClassification,
  CONTROL_SERVICE_PORTS,
  parseControlPlaneDeploymentArguments,
  renderControlPlaneRelease,
  validateControlPlaneImageReceipt,
} from "../scripts/production/deploy-control-plane.mjs";
import {
  canonicalJson,
  controlReleaseTrustPolicyDigest,
  createControlReleaseClaims,
} from "../scripts/production/control-release-authorization.mjs";
import {
  CONTROL_PLANE_CONTAINER_SERVICES,
  EXTERNAL_WORKLOAD_SERVICES,
} from "../scripts/production/run-control-service.mjs";

const imageDigest = `sha256:${"c".repeat(64)}`;
const dockerfileDigest = `sha256:${"d".repeat(64)}`;
const packageLockDigest = `sha256:${"e".repeat(64)}`;
const sourceRevision = "b".repeat(40);
const platformVersion = "0.1.0-beta.1";
const receipt = Object.freeze({
  schemaVersion: "deviludo.control-plane-image-receipt.v1",
  imageReference: `registry.internal/deviludo/control-plane@${imageDigest}`,
  imageDigest,
  baseImage: `registry.internal/base/node:22.13.1-bookworm-slim@sha256:${"a".repeat(64)}`,
  sourceRevision,
  platform: "linux/amd64",
  platformVersion,
  dockerfileDigest,
  packageLockDigest,
  attestations: Object.freeze(["buildkit-provenance-mode-max", "buildkit-sbom"]),
  completedAt: "2026-07-22T00:00:00.000Z",
});
const expected = Object.freeze({ platformVersion, dockerfileDigest, packageLockDigest });
const releaseKeys = generateKeyPairSync("ed25519");
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.control-release-trust-policy.v1",
  policyId: "deviludo-production-releases",
  policyRevision: 1,
  keys: Object.freeze([Object.freeze({
    keyId: "control-release-key-2026-01",
    algorithm: "Ed25519",
    publicKeySpkiBase64: releaseKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    status: "ACTIVE",
  })]),
});
const trustPolicyDigest = controlReleaseTrustPolicyDigest(trustPolicy);

test("deployment receipt validation binds the exact image, platform inputs and BuildKit attestations", () => {
  assert.deepEqual(validateControlPlaneImageReceipt(receipt, expected), receipt);
  assert.throws(
    () => validateControlPlaneImageReceipt({ ...receipt, imageReference: "registry.internal/deviludo/control-plane:latest" }, expected),
    /receipt is invalid/,
  );
  assert.throws(
    () => validateControlPlaneImageReceipt({ ...receipt, imageDigest: `sha256:${"f".repeat(64)}` }, expected),
    /receipt is invalid/,
  );
  assert.throws(
    () => validateControlPlaneImageReceipt({ ...receipt, attestations: ["buildkit-sbom"] }, expected),
    /receipt is invalid/,
  );
  assert.throws(
    () => validateControlPlaneImageReceipt({ ...receipt, packageLockDigest: `sha256:${"0".repeat(64)}` }, expected),
    /receipt is invalid/,
  );
  assert.throws(
    () => validateControlPlaneImageReceipt({ ...receipt, unexpected: true }, expected),
    /receipt is invalid/,
  );
  assert.equal(validateControlPlaneImageReceipt({ ...receipt, platform: "linux/arm64" }, expected).platform, "linux/arm64");
  assert.throws(
    () => validateControlPlaneImageReceipt({ ...receipt, platform: "windows/amd64" }, expected),
    /receipt is invalid/,
  );
});

test("deployment CLI renders by default and makes a cluster context mandatory only for explicit apply", () => {
  assert.deepEqual(parseControlPlaneDeploymentArguments([
    "--receipt", "/private/tmp/control-receipt.json",
    "--services", "control-plane,agent-configuration",
    "--replicas", "2",
  ]), {
    authorizationPath: undefined,
    context: undefined,
    mode: "render",
    namespace: "deviludo-system",
    receiptPath: "/private/tmp/control-receipt.json",
    replicas: 2,
    services: ["agent-configuration", "control-plane"],
    timeoutSeconds: 900,
    trustPolicyDigest: undefined,
    trustPolicyPath: undefined,
  });
  assert.equal(parseControlPlaneDeploymentArguments([
    "--apply",
    "--context", "production-ap-east-1/admin",
    "--namespace", "deviludo-prod",
    "--receipt", "/private/tmp/control-receipt.json",
    "--authorization", "/private/tmp/control-authorization.json",
    "--trust-policy", "/private/tmp/control-trust.json",
    "--trust-policy-digest", trustPolicyDigest,
  ]).mode, "apply");
  assert.throws(
    () => parseControlPlaneDeploymentArguments(["--apply", "--receipt", "/private/tmp/control-receipt.json"]),
    /input is invalid/,
  );
  assert.throws(
    () => parseControlPlaneDeploymentArguments(["--context", "production", "--receipt", "/private/tmp/control-receipt.json"]),
    /input is invalid/,
  );
  assert.throws(
    () => parseControlPlaneDeploymentArguments(["--apply", "--context", "prod\n--namespace=other", "--receipt", "/tmp/a"]),
    /input is invalid/,
  );
  assert.throws(
    () => parseControlPlaneDeploymentArguments(["--receipt", "relative.json"]),
    /input is invalid/,
  );
});

test("every shared-image workload is rendered as a least-authority deployment and only network servers get Services", () => {
  const classification = assertControlServiceDeploymentClassification();
  assert.deepEqual(classification.workers, ["agent-configuration", "temporal-worker"]);
  assert.equal(classification.networked.length, 29);
  assert.equal(Object.keys(CONTROL_SERVICE_PORTS).length, CONTROL_PLANE_CONTAINER_SERVICES.length - 2);

  const bundle = renderControlPlaneRelease(receipt);
  assert.equal(bundle.stages[0].resources.length, 1);
  assert.equal(bundle.stages[1].resources.length, 3);
  assert.equal(bundle.stages[2].resources.filter((resource) => resource.kind === "Deployment").length, 31);
  assert.equal(bundle.stages[2].resources.filter((resource) => resource.kind === "Service").length, 29);
  assert.ok(EXTERNAL_WORKLOAD_SERVICES.every((service) => !bundle.services.includes(service)));

  const namespace = bundle.stages[0].resources[0];
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted");
  const account = bundle.stages[1].resources[0];
  assert.equal(account.automountServiceAccountToken, false);
  assert.deepEqual(account.imagePullSecrets, [{ name: "deviludo-control-registry" }]);
  const policy = bundle.stages[1].resources.find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec, { podSelector: {}, policyTypes: ["Ingress", "Egress"] });

  const worker = bundle.stages[2].resources.find((resource) => resource.kind === "Deployment"
    && resource.metadata.name === "deviludo-agent-configuration");
  const workerContainer = worker.spec.template.spec.containers[0];
  assert.equal(workerContainer.ports, undefined);
  assert.equal(workerContainer.readinessProbe, undefined);
  assert.ok(!bundle.stages[2].resources.some((resource) => resource.kind === "Service"
    && resource.metadata.name === "deviludo-agent-configuration"));

  const server = bundle.stages[2].resources.find((resource) => resource.kind === "Deployment"
    && resource.metadata.name === "deviludo-control-plane");
  const pod = server.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(container.image, receipt.imageReference);
  assert.equal(container.ports[0].containerPort, 4_100);
  assert.deepEqual(container.env.find((entry) => entry.name === "DEVILUDO_CONTROL_PLANE_PORT"),
    { name: "DEVILUDO_CONTROL_PLANE_PORT", value: "4100" });
  assert.deepEqual(container.envFrom, [
    { configMapRef: { name: "deviludo-control-plane-config", optional: false } },
    { secretRef: { name: "deviludo-control-plane-environment", optional: false } },
  ]);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.nodeSelector, { "kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64" });
  assert.equal(pod.securityContext.seccompProfile.type, "RuntimeDefault");
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.equal(pod.volumes.find((volume) => volume.name === "service-files").secret.secretName, "deviludo-control-plane-files");
});

test("migration job alone receives the dedicated file-mounted database owner credential", () => {
  const bundle = renderControlPlaneRelease(receipt, { services: ["control-plane"] });
  const migration = bundle.stages[1].resources.find((resource) => resource.kind === "Job");
  const container = migration.spec.template.spec.containers[0];
  assert.deepEqual(container.command, ["node", "scripts/production/migrate-postgres.mjs"]);
  assert.equal(container.image, receipt.imageReference);
  assert.equal(container.envFrom, undefined);
  assert.equal(container.env.find((entry) => entry.name === "DEVILUDO_MIGRATION_DATABASE_URL_FILE").value,
    "/run/secrets/migration/database-url");
  assert.equal(migration.spec.template.spec.volumes.find((volume) => volume.name === "migration-credentials")
    .secret.secretName, "deviludo-schema-migrator-files");
  assert.deepEqual(migration.spec.template.spec.nodeSelector,
    { "kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64" });
  const workload = bundle.stages[2].resources.find((resource) => resource.kind === "Deployment");
  assert.ok(!JSON.stringify(workload).includes("DEVILUDO_MIGRATION_DATABASE_URL_FILE"));
  assert.ok(!JSON.stringify(workload).includes("schema-migrator-files"));
});

test("apply uses shell-free, explicit-context stages and does not release workloads before migration completes", async () => {
  const bundle = renderControlPlaneRelease(receipt, { services: ["agent-configuration", "control-plane"], timeoutSeconds: 300 });
  const security = signedSecurity(bundle, "prod-cluster/admin");
  const calls = [];
  const result = await applyControlPlaneRelease(bundle, "prod-cluster/admin", security, async (invocation, input) => {
    calls.push({ invocation, input });
  });
  assert.equal(calls.length, 6);
  assert.ok(calls.every(({ invocation }) => invocation.command === "kubectl" && !Object.hasOwn(invocation, "shell")));
  assert.deepEqual(calls[0].invocation.args.slice(0, 2), ["--context", "prod-cluster/admin"]);
  assert.equal(JSON.parse(calls[0].input).items[0].kind, "Namespace");
  assert.deepEqual(JSON.parse(calls[1].input).items.map((resource) => resource.kind), ["ServiceAccount", "NetworkPolicy"]);
  assert.equal(JSON.parse(calls[2].input).items[0].metadata.name, bundle.migrationJobName);
  assert.ok(calls[3].invocation.args.includes("--for=condition=complete"));
  assert.ok(calls[3].invocation.args.includes(`job/${bundle.migrationJobName}`));
  assert.equal(JSON.parse(calls[4].input).items.filter((resource) => resource.kind === "Deployment").length, 2);
  assert.ok(calls[5].invocation.args.includes("--for=condition=Available"));
  assert.equal(result.imageReference, receipt.imageReference);
  assert.deepEqual(result.deployedServices, ["agent-configuration", "control-plane"]);
  assert.equal(result.authorization.keyId, "control-release-key-2026-01");

  const mutated = structuredClone(bundle);
  mutated.stages[2].resources[0].metadata.name = "injected";
  await assert.rejects(
    applyControlPlaneRelease(mutated, "prod-cluster/admin", security, async () => undefined),
    /input is invalid/,
  );

  const blockedCalls = [];
  await assert.rejects(
    applyControlPlaneRelease(bundle, "prod-cluster/admin", security, async (invocation, input) => {
      blockedCalls.push({ invocation, input });
      if (blockedCalls.length === 4) throw new Error("migration did not complete");
    }),
    /migration did not complete/,
  );
  assert.equal(blockedCalls.length, 4);

  const unauthorizedCalls = [];
  await assert.rejects(
    applyControlPlaneRelease(bundle, "another-cluster/admin", security, async (...args) => unauthorizedCalls.push(args)),
    /authorization is invalid/,
  );
  assert.equal(unauthorizedCalls.length, 0);
  await assert.rejects(
    applyControlPlaneRelease(bundle, "prod-cluster/admin", {
      ...security,
      trustPolicyDigest: undefined,
    }, async (...args) => unauthorizedCalls.push(args)),
    /input is invalid/,
  );
  assert.equal(unauthorizedCalls.length, 0);

  let clockReads = 0;
  const expiringSecurity = {
    ...security,
    now: undefined,
    clock: () => {
      clockReads += 1;
      return new Date(clockReads < 4 ? "2026-07-22T00:05:00.000Z" : "2026-07-22T00:20:00.000Z");
    },
  };
  const expiryCalls = [];
  await assert.rejects(
    applyControlPlaneRelease(bundle, "prod-cluster/admin", expiringSecurity,
      async (...args) => expiryCalls.push(args)),
    /authorization is invalid/,
  );
  assert.equal(clockReads, 4);
  assert.equal(expiryCalls.length, 4);
  assert.ok(expiryCalls[3][0].args.includes("--for=condition=complete"));
});

function signedSecurity(bundle, context) {
  const claims = createControlReleaseClaims(bundle, context, {
    authorizationId: "22222222-2222-4222-8222-222222222222",
    issuedAt: new Date("2026-07-22T00:00:00.000Z"),
    ttlSeconds: 900,
  });
  return Object.freeze({
    authorization: Object.freeze({
      schemaVersion: "deviludo.control-release-authorization.v1",
      claims,
      signature: Object.freeze({
        algorithm: "Ed25519",
        keyId: "control-release-key-2026-01",
        value: sign(null, Buffer.from(canonicalJson(claims)), releaseKeys.privateKey).toString("base64url"),
      }),
    }),
    trustPolicy,
    trustPolicyDigest,
    now: new Date("2026-07-22T00:05:00.000Z"),
  });
}
