import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseSteamWorkflowExecutorReleaseAuthorizationArguments } from "../scripts/production/authorize-steam-workflow-executor-release.mjs";
import { canonicalJson } from "../scripts/production/control-release-authorization.mjs";
import {
  applySteamWorkflowExecutorRelease,
  parseSteamWorkflowExecutorDeploymentArguments,
  renderSteamWorkflowExecutorRelease,
} from "../scripts/production/deploy-steam-workflow-executor.mjs";
import {
  inspectSteamWorkflowExecutorReleaseTrustPolicy,
  parseSteamWorkflowExecutorReleaseTrustInspectionArguments,
} from "../scripts/production/inspect-steam-workflow-executor-release-trust-policy.mjs";
import { steamWorkflowExecutorRuntimeLockDigest } from "../scripts/production/lock-steam-workflow-executor-runtime.mjs";
import {
  createSteamWorkflowExecutorReleaseClaims,
  MtlsSteamWorkflowExecutorReleaseSigner,
  steamWorkflowExecutorReleaseSigningRequest,
  steamWorkflowExecutorReleaseTrustPolicyDigest,
  validateSteamWorkflowExecutorReleaseTrustPolicy,
  verifySteamWorkflowExecutorReleaseAuthorization,
} from "../scripts/production/steam-workflow-executor-release-authorization.mjs";

const sourceRevision = "7".repeat(40);
const platformVersion = "0.1.0-beta.1";
const imageDigest = `sha256:${"3".repeat(64)}`;
const receipt = Object.freeze({
  schemaVersion: "deviludo.steam-workflow-executor-image-receipt.v1",
  imageReference: `registry.internal/deviludo/steam-workflow-executor@${imageDigest}`,
  imageDigest,
  nodeBaseImage: `registry.internal/base/node:22.15.1-bookworm-slim@sha256:${"1".repeat(64)}`,
  nativePublisherImage: `registry.internal/deviludo/native-steam-publisher:1.3.0@sha256:${"2".repeat(64)}`,
  sourceRevision,
  platform: "linux/amd64",
  platformVersion,
  dockerfileDigest: `sha256:${"4".repeat(64)}`,
  packageLockDigest: `sha256:${"5".repeat(64)}`,
  attestations: Object.freeze(["buildkit-provenance-mode-max", "buildkit-sbom"]),
  completedAt: "2026-07-26T08:00:00.000Z",
});
const keys = generateKeyPairSync("ed25519");
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.steam-workflow-executor-release-trust-policy.v1",
  policyId: "deviludo-steam-workflow-executor-production",
  policyRevision: 1,
  keys: Object.freeze([Object.freeze({
    keyId: "steam-workflow-executor-release-2026-01",
    algorithm: "Ed25519",
    publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    status: "ACTIVE",
  })]),
});
const trustPolicyDigest = steamWorkflowExecutorReleaseTrustPolicyDigest(trustPolicy);

test("Steam workflow executor release trust is distinct, inspectable and revoked by default", () => {
  assert.deepEqual(validateSteamWorkflowExecutorReleaseTrustPolicy(trustPolicy, trustPolicyDigest), trustPolicy);
  const inspection = inspectSteamWorkflowExecutorReleaseTrustPolicy(trustPolicy);
  assert.equal(inspection.policyDigest, trustPolicyDigest);
  assert.equal("publicKeySpkiBase64" in inspection.keys[0], false);
  assert.deepEqual(parseSteamWorkflowExecutorReleaseTrustInspectionArguments([
    "--trust-policy", "/private/tmp/steam-executor-policy.json",
  ]), { trustPolicyPath: "/private/tmp/steam-executor-policy.json" });
  const template = JSON.parse(readFileSync(
    new URL("../infra/steam-workflow-executor-release-trust-policy.example.json", import.meta.url), "utf8"));
  assert.equal(inspectSteamWorkflowExecutorReleaseTrustPolicy(template).keys[0].status, "REVOKED");
  assert.throws(() => validateSteamWorkflowExecutorReleaseTrustPolicy({
    ...trustPolicy, schemaVersion: "deviludo.artifact-preparer-release-trust-policy.v1",
  }), /trust policy is invalid/);
});

test("Steam workflow executor claims bind both image bases, runtime identity and deployment scope", () => {
  const bundle = makeBundle();
  const claims = claimsFor(bundle);
  assert.equal(claims.nodeBaseImage, receipt.nodeBaseImage);
  assert.equal(claims.nativePublisherImage, receipt.nativePublisherImage);
  assert.equal(claims.runtimeLockDigest, steamWorkflowExecutorRuntimeLockDigest(bundle.runtimeLock));
  assert.equal(claims.replicas, 1);
  assert.equal(Buffer.from(steamWorkflowExecutorReleaseSigningRequest(claims).signingInput, "base64url").toString(),
    canonicalJson(claims));
  assert.throws(() => createSteamWorkflowExecutorReleaseClaims({ ...bundle, replicas: 11 }, bundle.runtimeLock.clusterContext),
    /authorization is invalid/);
});

test("Steam workflow executor authorization rejects image, scope and key lifecycle drift", () => {
  const bundle = makeBundle(); const authorization = signedAuthorization(bundle);
  const verified = verifySteamWorkflowExecutorReleaseAuthorization(authorization, trustPolicy, trustPolicyDigest, {
    bundle, clusterContext: bundle.runtimeLock.clusterContext, now: new Date("2026-07-26T08:05:00.000Z"),
  });
  assert.equal(verified.keyId, trustPolicy.keys[0].keyId);
  assert.throws(() => verifySteamWorkflowExecutorReleaseAuthorization(authorization, trustPolicy, trustPolicyDigest, {
    bundle: { ...bundle, replicas: 2 }, clusterContext: bundle.runtimeLock.clusterContext,
    now: new Date("2026-07-26T08:05:00.000Z"),
  }), /authorization is invalid/);
  const revoked = { ...trustPolicy, keys: [{ ...trustPolicy.keys[0], status: "REVOKED" }] };
  assert.throws(() => verifySteamWorkflowExecutorReleaseAuthorization(
    authorization, revoked, steamWorkflowExecutorReleaseTrustPolicyDigest(revoked), {
      bundle, clusterContext: bundle.runtimeLock.clusterContext, now: new Date("2026-07-26T08:05:00.000Z"),
    }), /authorization is invalid/);
});

test("Steam workflow executor signer uses one fixed TLS 1.3 mTLS KMS route", async () => {
  const bundle = makeBundle(); const claims = claimsFor(bundle); const calls = [];
  const signer = new MtlsSteamWorkflowExecutorReleaseSigner({
    endpoint: "https://steam-executor-release-kms.internal:8443/", keyId: trustPolicy.keys[0].keyId,
    tls: { key: Buffer.alloc(32, 1), cert: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    request: async (request) => { calls.push(request); return { statusCode: 200, body: signedResponse(claims) }; },
  });
  const authorization = await signer.sign(
    bundle, claims, trustPolicy, trustPolicyDigest, new Date("2026-07-26T08:05:00.000Z"));
  assert.equal(authorization.claims.authorizationId, claims.authorizationId);
  assert.equal(calls[0].url.pathname, "/v1/steam-workflow-executor-releases/sign-ed25519");
  assert.equal(calls[0].headers["idempotency-key"], claims.authorizationId);
  assert.throws(() => new MtlsSteamWorkflowExecutorReleaseSigner({
    endpoint: "http://steam-executor-release-kms.internal", keyId: trustPolicy.keys[0].keyId,
    tls: { key: Buffer.alloc(32), cert: Buffer.alloc(32), ca: Buffer.alloc(32) },
  }), /configuration is invalid/);
});

test("Steam workflow executor CLIs separate side-effect-free render from authorized apply", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["authorize:steam-workflow-executor"],
    "node scripts/production/authorize-steam-workflow-executor-release.mjs");
  assert.equal(packageJson.scripts["deploy:steam-workflow-executor"],
    "node scripts/production/deploy-steam-workflow-executor.mjs");
  assert.equal(parseSteamWorkflowExecutorDeploymentArguments([
    "--receipt", "/private/tmp/receipt.json", "--runtime-lock", "/private/tmp/runtime-lock.json",
  ]).mode, "render");
  assert.equal(parseSteamWorkflowExecutorDeploymentArguments([
    "--apply", "--context", "prod-steam/admin", "--receipt", "/private/tmp/receipt.json",
    "--runtime-lock", "/private/tmp/runtime-lock.json", "--authorization", "/private/tmp/auth.json",
    "--trust-policy", "/private/tmp/policy.json", "--trust-policy-digest", trustPolicyDigest,
  ]).mode, "apply");
  assert.throws(() => parseSteamWorkflowExecutorDeploymentArguments([
    "--apply", "--context", "prod-steam/admin", "--receipt", "/tmp/receipt.json", "--runtime-lock", "/tmp/lock.json",
  ]), /input is invalid/);
  assert.equal(parseSteamWorkflowExecutorReleaseAuthorizationArguments([
    "--context", "prod-steam/admin", "--receipt", "/tmp/receipt.json", "--runtime-lock", "/tmp/lock.json",
    "--trust-policy", "/tmp/policy.json", "--trust-policy-digest", trustPolicyDigest,
  ]).replicas, 1);
});

test("Steam workflow executor renders one tokenless, default-deny, non-root workload", () => {
  const bundle = makeBundle();
  assert.deepEqual(bundle.stages.map((stage) => stage.name), ["namespace", "security", "workload"]);
  const resources = bundle.stages.flatMap((stage) => stage.resources);
  assert.deepEqual(resources.map((resource) => resource.kind), ["Namespace", "ServiceAccount", "NetworkPolicy", "Deployment"]);
  const account = resources.find((resource) => resource.kind === "ServiceAccount");
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const deployment = resources.find((resource) => resource.kind === "Deployment");
  const pod = deployment.spec.template.spec; const container = pod.containers[0];
  assert.equal(account.automountServiceAccountToken, false);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(policy.spec, { podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  assert.equal(container.image, receipt.imageReference);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.equal(pod.nodeSelector["deviludo.io/workload"], "steam-workflow-executor");
  assert.ok(pod.volumes.some((volume) => volume.name === "work" && volume.emptyDir.sizeLimit === "64Gi"));
  assert.ok(pod.volumes.every((volume) => volume.hostPath === undefined));
  assert.ok(container.env.every((entry) => !/(?:KEY|SECRET|PASSWORD|DATABASE_URL)/.test(entry.name)));
  assert.ok(container.envFrom.some((entry) => entry.secretRef?.name === bundle.runtimeLock.environmentSecret.name));
  assert.ok(container.volumeMounts.some((mount) => mount.name === "service-files" && mount.readOnly));
  assert.ok(container.startupProbe.exec.command.includes("require('node:fs').accessSync('/tmp/deviludo-steam-executor-ready')"));
  assert.deepEqual(container.readinessProbe.exec.command, container.startupProbe.exec.command);
  assert.equal(resources.some((resource) => resource.kind === "Service"), false);
  assert.equal(JSON.stringify(bundle).includes("config.vdf"), false);
});

test("Steam workflow executor apply reauthorizes and rechecks resources before every mutation", async () => {
  const bundle = makeBundle(); const authorization = signedAuthorization(bundle); const calls = [];
  let inspections = 0; let policyLoads = 0;
  const result = await applySteamWorkflowExecutorRelease(bundle, bundle.runtimeLock.clusterContext, {
    authorization,
    loadTrustPolicy: async () => { policyLoads += 1; return trustPolicy; },
    trustPolicyDigest,
    clock: () => new Date("2026-07-26T08:05:00.000Z"),
    inspectRuntimeResources: async () => { inspections += 1; return observed(bundle.runtimeLock); },
  }, async (invocation, input) => calls.push({ invocation, input }));
  assert.equal(result.imageReference, receipt.imageReference);
  assert.equal(inspections, 3);
  assert.equal(policyLoads, 3);
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((call) => call.invocation.args.includes("apply")).length, 3);
  assert.ok(calls.slice(0, 3).every((call) => call.invocation.args.includes("--server-side")));
  assert.ok(calls.every((call) => !call.invocation.args.some((arg) => new Set(["delete", "prune", "exec"]).has(arg))));
  assert.ok(calls[3].invocation.args.includes("deployment/deviludo-steam-workflow-executor"));
});

test("Steam workflow executor apply mutates nothing without authority and stops on live drift", async () => {
  const bundle = makeBundle(); const authorization = signedAuthorization(bundle); const calls = [];
  await assert.rejects(applySteamWorkflowExecutorRelease(bundle, bundle.runtimeLock.clusterContext, {
    authorization: { ...authorization, signature: { ...authorization.signature, value: "A".repeat(86) } },
    trustPolicy, trustPolicyDigest, now: new Date("2026-07-26T08:05:00.000Z"),
    inspectRuntimeResources: async () => observed(bundle.runtimeLock),
  }, async (...args) => calls.push(args)), /authorization is invalid/);
  assert.equal(calls.length, 0);
  let inspections = 0;
  await assert.rejects(applySteamWorkflowExecutorRelease(bundle, bundle.runtimeLock.clusterContext, {
    authorization, trustPolicy, trustPolicyDigest, now: new Date("2026-07-26T08:05:00.000Z"),
    inspectRuntimeResources: async () => {
      inspections += 1;
      return observed(bundle.runtimeLock).map((resource, index) => inspections === 2 && index === 0
        ? { ...resource, resourceVersion: "late-drift" } : resource);
    },
  }, async (...args) => calls.push(args)), /lock is invalid/);
  assert.equal(inspections, 2);
  assert.equal(calls.length, 1);
});

function makeBundle() {
  const runtimeLock = makeRuntimeLock();
  return renderSteamWorkflowExecutorRelease(receipt, {
    namespace: runtimeLock.namespace, replicas: 1, runtimeLock, timeoutSeconds: 600,
  });
}
function makeRuntimeLock() {
  const revision = "abcdef123456"; let index = 1;
  const resource = (kind, name) => Object.freeze({
    kind, name, uid: `70000000-0000-4000-8000-${String(index++).padStart(12, "0")}`,
    resourceVersion: String(50_000 + index),
  });
  return Object.freeze({
    schemaVersion: "deviludo.steam-workflow-executor-runtime-lock.v1",
    lockId: "77777777-7777-4777-8777-777777777777",
    clusterContext: "prod-steam/admin", namespace: "deviludo-steam-release", configurationRevision: revision,
    createdAt: "2026-07-26T08:00:00.000Z",
    registrySecret: resource("Secret", `deviludo-steam-workflow-executor-registry-${revision}`),
    configMap: resource("ConfigMap", `deviludo-steam-workflow-executor-config-${revision}`),
    environmentSecret: resource("Secret", `deviludo-steam-workflow-executor-environment-${revision}`),
    filesSecret: resource("Secret", `deviludo-steam-workflow-executor-files-${revision}`),
  });
}
function claimsFor(bundle) {
  return createSteamWorkflowExecutorReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "88888888-8888-4888-8888-888888888888",
    issuedAt: new Date("2026-07-26T08:00:00.000Z"), ttlSeconds: 900,
  });
}
function signedResponse(claims) {
  return {
    schemaVersion: "deviludo.steam-workflow-executor-release-signing-response.v1",
    algorithm: "Ed25519", keyId: trustPolicy.keys[0].keyId,
    claimsDigest: steamWorkflowExecutorReleaseSigningRequest(claims).claimsDigest,
    signature: sign(null, Buffer.from(canonicalJson(claims)), keys.privateKey).toString("base64url"),
  };
}
function signedAuthorization(bundle) {
  const claims = claimsFor(bundle);
  return Object.freeze({
    schemaVersion: "deviludo.steam-workflow-executor-release-authorization.v1", claims,
    signature: Object.freeze({ algorithm: "Ed25519", keyId: trustPolicy.keys[0].keyId, value: signedResponse(claims).signature }),
  });
}
function observed(lock) {
  return [lock.registrySecret, lock.configMap, lock.environmentSecret, lock.filesSecret]
    .map((resource) => Object.freeze({ ...resource, immutable: true }));
}
