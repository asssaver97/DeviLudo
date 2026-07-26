import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  artifactPreparerReleaseAuthorizationFromSigner,
  artifactPreparerReleaseSigningRequest,
  artifactPreparerReleaseTrustPolicyDigest,
  createArtifactPreparerReleaseClaims,
  MtlsArtifactPreparerReleaseSigner,
  validateArtifactPreparerReleaseTrustPolicy,
  verifyArtifactPreparerReleaseAuthorization,
} from "../scripts/production/artifact-preparer-release-authorization.mjs";
import { canonicalJson } from "../scripts/production/control-release-authorization.mjs";
import {
  inspectArtifactPreparerReleaseTrustPolicy,
  parseArtifactPreparerReleaseTrustInspectionArguments,
} from "../scripts/production/inspect-artifact-preparer-release-trust-policy.mjs";
import { parseArtifactPreparerReleaseAuthorizationArguments } from "../scripts/production/authorize-artifact-preparer-release.mjs";
import {
  applyArtifactPreparerRelease,
  parseArtifactPreparerDeploymentArguments,
  renderArtifactPreparerRelease,
} from "../scripts/production/deploy-artifact-preparer.mjs";
import { artifactPreparerRuntimeLockDigest } from "../scripts/production/lock-artifact-preparer-runtime.mjs";

const sourceRevision = "7".repeat(40);
const platformVersion = "0.1.0-beta.1";
const imageDigest = `sha256:${"3".repeat(64)}`;
const imageReceipt = Object.freeze({
  schemaVersion: "deviludo.artifact-preparer-image-receipt.v1",
  imageReference: `registry.internal/deviludo/artifact-preparer@${imageDigest}`,
  imageDigest,
  baseImage: `registry.internal/base/node:22.15.1-bookworm-slim@sha256:${"1".repeat(64)}`,
  sourceRevision,
  platform: "linux/amd64",
  platformVersion,
  dockerfileDigest: `sha256:${"4".repeat(64)}`,
  packageLockDigest: `sha256:${"5".repeat(64)}`,
  attestations: Object.freeze(["buildkit-provenance-mode-max", "buildkit-sbom"]),
  completedAt: "2026-07-26T00:00:00.000Z",
});
const releaseKeys = generateKeyPairSync("ed25519");
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.artifact-preparer-release-trust-policy.v1",
  policyId: "deviludo-artifact-preparer-production-releases",
  policyRevision: 1,
  keys: Object.freeze([Object.freeze({
    keyId: "artifact-preparer-release-key-2026-01",
    algorithm: "Ed25519",
    publicKeySpkiBase64: releaseKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    status: "ACTIVE",
  })]),
});
const trustPolicyDigest = artifactPreparerReleaseTrustPolicyDigest(trustPolicy);

test("Artifact Preparer release trust is distinct, digest-pinned and safe to inspect", () => {
  assert.deepEqual(validateArtifactPreparerReleaseTrustPolicy(trustPolicy, trustPolicyDigest), trustPolicy);
  const inspection = inspectArtifactPreparerReleaseTrustPolicy(trustPolicy);
  assert.equal(inspection.policyDigest, trustPolicyDigest);
  assert.equal("publicKeySpkiBase64" in inspection.keys[0], false);
  assert.deepEqual(parseArtifactPreparerReleaseTrustInspectionArguments([
    "--trust-policy", "/private/tmp/artifact-preparer-policy.json",
  ]), { trustPolicyPath: "/private/tmp/artifact-preparer-policy.json" });
  assert.throws(() => validateArtifactPreparerReleaseTrustPolicy({
    ...trustPolicy,
    schemaVersion: "deviludo.control-release-trust-policy.v1",
  }), /trust policy is invalid/);
  assert.throws(() => validateArtifactPreparerReleaseTrustPolicy(trustPolicy, `sha256:${"0".repeat(64)}`),
    /trust policy is invalid/);
});

test("Artifact Preparer release claims bind image base, runtime lock and deployment scope", () => {
  const bundle = makeBundle();
  const claims = createArtifactPreparerReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "77777777-7777-4777-8777-777777777777",
    issuedAt: new Date("2026-07-26T00:00:00.000Z"),
    ttlSeconds: 900,
  });
  assert.equal(claims.baseImage, imageReceipt.baseImage);
  assert.equal(claims.runtimeLockDigest, artifactPreparerRuntimeLockDigest(bundle.runtimeLock));
  assert.equal(claims.replicas, 2);
  assert.equal(claims.timeoutSeconds, 600);
  const request = artifactPreparerReleaseSigningRequest(claims);
  assert.equal(Buffer.from(request.signingInput, "base64url").toString("utf8"), canonicalJson(claims));
  assert.throws(() => createArtifactPreparerReleaseClaims({ ...bundle, replicas: 11 }, bundle.runtimeLock.clusterContext),
    /authorization is invalid/);
});

test("Artifact Preparer authorization verifies exact release and rejects drift or revocation", () => {
  const bundle = makeBundle();
  const claims = createArtifactPreparerReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "88888888-8888-4888-8888-888888888888",
    issuedAt: new Date("2026-07-26T00:00:00.000Z"),
    ttlSeconds: 900,
  });
  const response = signedResponse(claims);
  const authorization = artifactPreparerReleaseAuthorizationFromSigner(
    claims, response, bundle, trustPolicy, trustPolicyDigest, new Date("2026-07-26T00:05:00.000Z"));
  const verified = verifyArtifactPreparerReleaseAuthorization(
    authorization, trustPolicy, trustPolicyDigest, {
      bundle, clusterContext: bundle.runtimeLock.clusterContext, now: new Date("2026-07-26T00:05:00.000Z"),
    });
  assert.equal(verified.keyId, trustPolicy.keys[0].keyId);
  assert.throws(() => verifyArtifactPreparerReleaseAuthorization(
    authorization, trustPolicy, trustPolicyDigest, {
      bundle: { ...bundle, timeoutSeconds: 601 },
      clusterContext: bundle.runtimeLock.clusterContext,
      now: new Date("2026-07-26T00:05:00.000Z"),
    }), /authorization is invalid/);
  const revoked = { ...trustPolicy, keys: [{ ...trustPolicy.keys[0], status: "REVOKED" }] };
  assert.throws(() => verifyArtifactPreparerReleaseAuthorization(
    authorization, revoked, artifactPreparerReleaseTrustPolicyDigest(revoked), {
      bundle, clusterContext: bundle.runtimeLock.clusterContext, now: new Date("2026-07-26T00:05:00.000Z"),
    }), /authorization is invalid/);
});

test("Artifact Preparer signer uses one fixed mTLS KMS route", async () => {
  const bundle = makeBundle();
  const claims = createArtifactPreparerReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "99999999-9999-4999-8999-999999999999",
    issuedAt: new Date("2026-07-26T00:00:00.000Z"),
    ttlSeconds: 900,
  });
  const calls = [];
  const signer = new MtlsArtifactPreparerReleaseSigner({
    endpoint: "https://artifact-preparer-release-signer.internal:8443/",
    keyId: trustPolicy.keys[0].keyId,
    tls: { key: Buffer.alloc(32, 1), cert: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    request: async (request) => { calls.push(request); return { statusCode: 200, body: signedResponse(claims) }; },
  });
  const authorization = await signer.sign(
    bundle, claims, trustPolicy, trustPolicyDigest, new Date("2026-07-26T00:05:00.000Z"));
  assert.equal(authorization.claims.authorizationId, claims.authorizationId);
  assert.equal(calls[0].url.pathname, "/v1/artifact-preparer-releases/sign-ed25519");
  assert.equal(calls[0].headers["idempotency-key"], claims.authorizationId);
  assert.throws(() => new MtlsArtifactPreparerReleaseSigner({
    endpoint: "https://artifact-preparer-release-signer.internal/other",
    keyId: trustPolicy.keys[0].keyId,
    tls: { key: Buffer.alloc(32), cert: Buffer.alloc(32), ca: Buffer.alloc(32) },
  }), /configuration is invalid/);
});

test("repository Artifact Preparer release trust template is revoked by default", () => {
  const template = JSON.parse(readFileSync(
    new URL("../infra/artifact-preparer-release-trust-policy.example.json", import.meta.url), "utf8"));
  const inspected = inspectArtifactPreparerReleaseTrustPolicy(template);
  assert.equal(inspected.keys.length, 1);
  assert.equal(inspected.keys[0].status, "REVOKED");
  assert.match(inspected.policyDigest, /^sha256:[a-f0-9]{64}$/);
});

test("Artifact Preparer release CLIs separate safe rendering from authorized apply", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["authorize:artifact-preparer"],
    "node scripts/production/authorize-artifact-preparer-release.mjs");
  assert.equal(packageJson.scripts["deploy:artifact-preparer"],
    "node scripts/production/deploy-artifact-preparer.mjs");
  assert.equal(parseArtifactPreparerDeploymentArguments([
    "--receipt", "/private/tmp/receipt.json", "--runtime-lock", "/private/tmp/runtime-lock.json",
  ]).mode, "render");
  assert.equal(parseArtifactPreparerDeploymentArguments([
    "--apply", "--context", "prod-runner/admin", "--receipt", "/private/tmp/receipt.json",
    "--runtime-lock", "/private/tmp/runtime-lock.json", "--authorization", "/private/tmp/auth.json",
    "--trust-policy", "/private/tmp/policy.json", "--trust-policy-digest", trustPolicyDigest,
  ]).mode, "apply");
  assert.throws(() => parseArtifactPreparerDeploymentArguments([
    "--apply", "--context", "prod-runner/admin", "--receipt", "/tmp/receipt.json",
    "--runtime-lock", "/tmp/lock.json",
  ]), /input is invalid/);
  assert.equal(parseArtifactPreparerReleaseAuthorizationArguments([
    "--context", "prod-runner/admin", "--receipt", "/tmp/receipt.json",
    "--runtime-lock", "/tmp/lock.json", "--trust-policy", "/tmp/policy.json",
    "--trust-policy-digest", trustPolicyDigest,
  ]).replicas, 2);
});

test("Artifact Preparer release renders one restricted tokenless workload", () => {
  const bundle = makeBundle();
  assert.deepEqual(bundle.stages.map((stage) => stage.name), ["namespace", "security", "workload"]);
  const resources = bundle.stages.flatMap((stage) => stage.resources);
  assert.deepEqual(resources.map((resource) => resource.kind), [
    "Namespace", "ServiceAccount", "NetworkPolicy", "Service", "Deployment",
  ]);
  const account = resources.find((resource) => resource.kind === "ServiceAccount");
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const deployment = resources.find((resource) => resource.kind === "Deployment");
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(account.automountServiceAccountToken, false);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(policy.spec, { podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  assert.equal(container.image, imageReceipt.imageReference);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.equal(pod.nodeSelector["deviludo.io/workload"], "artifact-preparer");
  assert.ok(pod.volumes.some((volume) => volume.name === "work" && volume.emptyDir.sizeLimit === "144Gi"));
  assert.ok(pod.volumes.every((volume) => volume.hostPath === undefined));
  assert.ok(container.env.every((entry) => !/(?:KEY|SECRET|PASSWORD|DATABASE_URL)/.test(entry.name)));
  assert.ok(container.envFrom.some((entry) => entry.secretRef?.name === bundle.runtimeLock.environmentSecret.name));
  assert.ok(container.volumeMounts.some((mount) => mount.name === "service-files" && mount.readOnly === true));
  assert.equal(JSON.stringify(bundle).includes("claude"), false);
  assert.equal(JSON.stringify(bundle).includes("codex"), false);
  assert.equal(JSON.stringify(bundle).includes("steamcmd"), false);
});

test("Artifact Preparer apply reauthorizes and rechecks live resources before every mutation", async () => {
  const bundle = makeBundle();
  const authorization = signedAuthorization(bundle);
  const calls = [];
  let inspections = 0;
  let policyLoads = 0;
  const result = await applyArtifactPreparerRelease(bundle, bundle.runtimeLock.clusterContext, {
    authorization,
    loadTrustPolicy: async () => { policyLoads += 1; return trustPolicy; },
    trustPolicyDigest,
    clock: () => new Date("2026-07-26T00:05:00.000Z"),
    inspectRuntimeResources: async () => { inspections += 1; return observedRuntimeResources(bundle.runtimeLock); },
  }, async (invocation, input) => calls.push({ invocation, input }));
  assert.equal(result.imageReference, imageReceipt.imageReference);
  assert.equal(inspections, 3);
  assert.equal(policyLoads, 3);
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((call) => call.invocation.args.includes("apply")).length, 3);
  assert.ok(calls.slice(0, 3).every((call) => call.invocation.args.includes("--context")));
  assert.ok(calls.slice(0, 3).every((call) => call.invocation.args.includes("--server-side")));
  assert.ok(calls.slice(0, 3).every((call) => call.invocation.args.includes("--validate=strict")));
  assert.ok(calls.every((call) => !call.invocation.args.some((arg) => new Set(["delete", "prune", "exec"]).has(arg))));
  assert.ok(calls.slice(0, 3).every((call) => JSON.parse(call.input).kind === "List"));
  assert.ok(calls[3].invocation.args.includes("deployment/deviludo-artifact-preparer"));
});

test("Artifact Preparer apply performs no mutation for bad authority and stops on late runtime drift", async () => {
  const bundle = makeBundle();
  const authorization = signedAuthorization(bundle);
  const noAuthorityCalls = [];
  await assert.rejects(applyArtifactPreparerRelease(bundle, bundle.runtimeLock.clusterContext, {
    authorization: { ...authorization, signature: { ...authorization.signature, value: "A".repeat(86) } },
    trustPolicy,
    trustPolicyDigest,
    now: new Date("2026-07-26T00:05:00.000Z"),
    inspectRuntimeResources: async () => observedRuntimeResources(bundle.runtimeLock),
  }, async (...args) => noAuthorityCalls.push(args)), /authorization is invalid/);
  assert.equal(noAuthorityCalls.length, 0);

  const driftCalls = [];
  let inspections = 0;
  await assert.rejects(applyArtifactPreparerRelease(bundle, bundle.runtimeLock.clusterContext, {
    authorization,
    trustPolicy,
    trustPolicyDigest,
    now: new Date("2026-07-26T00:05:00.000Z"),
    inspectRuntimeResources: async () => {
      inspections += 1;
      return observedRuntimeResources(bundle.runtimeLock).map((resource, index) => inspections === 2 && index === 0
        ? { ...resource, resourceVersion: "late-drift" } : resource);
    },
  }, async (...args) => driftCalls.push(args)), /lock is invalid/);
  assert.equal(inspections, 2);
  assert.equal(driftCalls.length, 1);
});

function signedResponse(claims) {
  return {
    schemaVersion: "deviludo.artifact-preparer-release-signing-response.v1",
    algorithm: "Ed25519",
    claimsDigest: artifactPreparerReleaseSigningRequest(claims).claimsDigest,
    keyId: trustPolicy.keys[0].keyId,
    signature: sign(null, Buffer.from(canonicalJson(claims)), releaseKeys.privateKey).toString("base64url"),
  };
}

function makeBundle() {
  const runtimeLock = makeRuntimeLock();
  return renderArtifactPreparerRelease(imageReceipt, {
    namespace: runtimeLock.namespace, replicas: 2, runtimeLock, timeoutSeconds: 600,
  });
}

function makeRuntimeLock() {
  let resourceIndex = 1;
  const revision = "abcdef123456";
  const resource = (kind, name) => Object.freeze({
    kind,
    name,
    uid: `30000000-0000-4000-8000-${String(resourceIndex++).padStart(12, "0")}`,
    resourceVersion: String(40_000 + resourceIndex),
  });
  return Object.freeze({
    schemaVersion: "deviludo.artifact-preparer-runtime-lock.v1",
    lockId: "66666666-6666-4666-8666-666666666666",
    clusterContext: "prod-runner/admin",
    namespace: "deviludo-runner-inputs",
    configurationRevision: revision,
    createdAt: "2026-07-26T00:00:00.000Z",
    registrySecret: resource("Secret", `deviludo-artifact-preparer-registry-${revision}`),
    configMap: resource("ConfigMap", `deviludo-artifact-preparer-config-${revision}`),
    environmentSecret: resource("Secret", `deviludo-artifact-preparer-environment-${revision}`),
    filesSecret: resource("Secret", `deviludo-artifact-preparer-files-${revision}`),
  });
}

function observedRuntimeResources(lock) {
  return [lock.registrySecret, lock.configMap, lock.environmentSecret, lock.filesSecret]
    .map((resource) => Object.freeze({ ...resource, immutable: true }));
}

function signedAuthorization(bundle) {
  const claims = createArtifactPreparerReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    issuedAt: new Date("2026-07-26T00:00:00.000Z"),
    ttlSeconds: 900,
  });
  return artifactPreparerReleaseAuthorizationFromSigner(
    claims, signedResponse(claims), bundle, trustPolicy, trustPolicyDigest,
    new Date("2026-07-26T00:05:00.000Z"));
}
