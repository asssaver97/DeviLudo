import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  agentMicrovmCredentialIssuerReleaseSigningRequest,
  agentMicrovmCredentialIssuerReleaseTrustPolicyDigest,
  createAgentMicrovmCredentialIssuerReleaseClaims,
  MtlsAgentMicrovmCredentialIssuerReleaseSigner,
  validateAgentMicrovmCredentialIssuerReleaseTrustPolicy,
  verifyAgentMicrovmCredentialIssuerReleaseAuthorization,
} from "../scripts/production/agent-microvm-credential-issuer-release-authorization.mjs";
import { parseAgentMicrovmCredentialIssuerReleaseAuthorizationArguments } from "../scripts/production/authorize-agent-microvm-credential-issuer-release.mjs";
import { canonicalJson } from "../scripts/production/control-release-authorization.mjs";
import {
  applyAgentMicrovmCredentialIssuerRelease,
  parseAgentMicrovmCredentialIssuerDeploymentArguments,
  renderAgentMicrovmCredentialIssuerRelease,
} from "../scripts/production/deploy-agent-microvm-credential-issuer.mjs";
import { inspectAgentMicrovmCredentialIssuerReleaseTrustPolicy } from "../scripts/production/inspect-agent-microvm-credential-issuer-release-trust-policy.mjs";
import {
  agentMicrovmCredentialIssuerRuntimeLockDigest,
  createAgentMicrovmCredentialIssuerRuntimeLock,
  inspectAgentMicrovmCredentialIssuerRuntimeResources,
  parseAgentMicrovmCredentialIssuerRuntimeLockArguments,
  parseAgentMicrovmCredentialIssuerRuntimeMetadataOutput,
  validateAgentMicrovmCredentialIssuerRuntimeLock,
  verifyAgentMicrovmCredentialIssuerRuntimeLock,
} from "../scripts/production/lock-agent-microvm-credential-issuer-runtime.mjs";
import {
  agentMicrovmCredentialIssuerConfigurationRevision,
  makeAgentMicrovmCredentialIssuerRuntimeLock,
  observedAgentMicrovmCredentialIssuerRuntimeResources,
} from "./agent-microvm-credential-issuer-runtime-lock-fixture.mjs";

const sourceRevision = "7".repeat(40);
const platformVersion = "0.1.0-beta.1";
const imageDigest = `sha256:${"3".repeat(64)}`;
const imageReceipt = Object.freeze({
  schemaVersion: "deviludo.agent-microvm-credential-issuer-image-receipt.v1",
  imageReference: `registry.internal/deviludo/agent-microvm-credential-issuer@${imageDigest}`,
  imageDigest,
  nodeBaseImage: `registry.internal/base/node:22.13.1-bookworm-slim@sha256:${"1".repeat(64)}`,
  toolchainBaseImage: `registry.internal/deviludo/agent-microvm-credential-toolchain:${platformVersion}@sha256:${"2".repeat(64)}`,
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
  schemaVersion: "deviludo.agent-microvm-credential-issuer-release-trust-policy.v1",
  policyId: "deviludo-agent-microvm-credential-issuer-production-releases",
  policyRevision: 1,
  keys: Object.freeze([Object.freeze({
    keyId: "agent-microvm-credential-issuer-release-key-2026-01",
    algorithm: "Ed25519",
    publicKeySpkiBase64: releaseKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    status: "ACTIVE",
  })]),
});
const trustPolicyDigest = agentMicrovmCredentialIssuerReleaseTrustPolicyDigest(trustPolicy);

test("credential issuer runtime lock binds four immutable Kubernetes resources", async () => {
  const expected = makeAgentMicrovmCredentialIssuerRuntimeLock();
  assert.deepEqual(parseAgentMicrovmCredentialIssuerRuntimeLockArguments([
    "--context", expected.clusterContext,
    "--configuration-revision", agentMicrovmCredentialIssuerConfigurationRevision,
  ]), {
    clusterContext: expected.clusterContext,
    configurationRevision: agentMicrovmCredentialIssuerConfigurationRevision,
    lockId: undefined,
    namespace: "deviludo-agent-credentials",
  });
  const lock = await createAgentMicrovmCredentialIssuerRuntimeLock({
    clusterContext: expected.clusterContext, namespace: expected.namespace,
    configurationRevision: expected.configurationRevision, createdAt: new Date(expected.createdAt), lockId: expected.lockId,
  }, async () => observedAgentMicrovmCredentialIssuerRuntimeResources(expected));
  assert.deepEqual(lock, expected);
  assert.match(agentMicrovmCredentialIssuerRuntimeLockDigest(lock), /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => validateAgentMicrovmCredentialIssuerRuntimeLock({ ...lock, unexpected: true }), /lock is invalid/);
  assert.throws(() => parseAgentMicrovmCredentialIssuerRuntimeLockArguments([
    "--context", "prod", "--configuration-revision", "latest",
  ]), /input is invalid/);
});

test("credential issuer runtime metadata is immutable, metadata-only and rechecked", async () => {
  const lock = makeAgentMicrovmCredentialIssuerRuntimeLock();
  const output = observedAgentMicrovmCredentialIssuerRuntimeResources(lock)
    .map((resource) => `${resource.kind} ${resource.name} ${resource.uid} ${resource.resourceVersion} true`).join("\n");
  assert.equal(parseAgentMicrovmCredentialIssuerRuntimeMetadataOutput(output).length, 4);
  assert.throws(() => parseAgentMicrovmCredentialIssuerRuntimeMetadataOutput(output.replace(" true", " false")), /lock is invalid/);
  const calls = [];
  const observed = await inspectAgentMicrovmCredentialIssuerRuntimeResources({
    clusterContext: lock.clusterContext, namespace: lock.namespace,
    resources: [lock.filesSecret, lock.registrySecret, lock.configMap, lock.environmentSecret],
  }, async (invocation) => { calls.push(invocation); return output; });
  assert.equal(observed.length, 4);
  assert.ok(calls[0].args.some((argument) => argument.startsWith("--output=custom-columns=")));
  assert.ok(!calls[0].args.includes("--output=json"));
  const verified = await verifyAgentMicrovmCredentialIssuerRuntimeLock(lock, {
    clusterContext: lock.clusterContext, namespace: lock.namespace,
  }, async () => observedAgentMicrovmCredentialIssuerRuntimeResources(lock));
  assert.equal(verified.resourceCount, 4);
  await assert.rejects(verifyAgentMicrovmCredentialIssuerRuntimeLock(lock, {
    clusterContext: lock.clusterContext, namespace: lock.namespace,
  }, async () => observedAgentMicrovmCredentialIssuerRuntimeResources(lock).map((resource, index) => index === 0
    ? { ...resource, resourceVersion: "999" } : resource)), /lock is invalid/);
});

test("credential issuer release trust and claims are cryptographically separate and fully bound", () => {
  assert.deepEqual(validateAgentMicrovmCredentialIssuerReleaseTrustPolicy(trustPolicy, trustPolicyDigest), trustPolicy);
  const inspection = inspectAgentMicrovmCredentialIssuerReleaseTrustPolicy(trustPolicy);
  assert.equal(inspection.policyDigest, trustPolicyDigest);
  assert.equal("publicKeySpkiBase64" in inspection.keys[0], false);
  const bundle = renderAgentMicrovmCredentialIssuerRelease(imageReceipt, {
    runtimeLock: makeAgentMicrovmCredentialIssuerRuntimeLock(), replicas: 2, timeoutSeconds: 600,
  });
  const claims = createAgentMicrovmCredentialIssuerReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "66666666-6666-4666-8666-666666666666",
    issuedAt: new Date("2026-07-26T00:00:00.000Z"), ttlSeconds: 900,
  });
  assert.equal(claims.timeoutSeconds, 600);
  assert.equal(claims.toolchainBaseImage, imageReceipt.toolchainBaseImage);
  assert.equal(claims.runtimeLockDigest, agentMicrovmCredentialIssuerRuntimeLockDigest(bundle.runtimeLock));
  const request = agentMicrovmCredentialIssuerReleaseSigningRequest(claims);
  assert.equal(Buffer.from(request.signingInput, "base64url").toString("utf8"), canonicalJson(claims));
  assert.throws(() => validateAgentMicrovmCredentialIssuerReleaseTrustPolicy({
    ...trustPolicy, schemaVersion: "deviludo.agent-supply-chain-release-trust-policy.v1",
  }), /trust policy is invalid/);
});

test("credential issuer authorization verifies exact release and rejects revoked authority", () => {
  const bundle = renderAgentMicrovmCredentialIssuerRelease(imageReceipt, {
    runtimeLock: makeAgentMicrovmCredentialIssuerRuntimeLock(), timeoutSeconds: 600,
  });
  const authorization = signedAuthorization(bundle);
  const result = verifyAgentMicrovmCredentialIssuerReleaseAuthorization(
    authorization, trustPolicy, trustPolicyDigest, {
      bundle, clusterContext: bundle.runtimeLock.clusterContext, now: new Date("2026-07-26T00:05:00.000Z"),
    });
  assert.equal(result.keyId, trustPolicy.keys[0].keyId);
  assert.throws(() => verifyAgentMicrovmCredentialIssuerReleaseAuthorization(
    authorization, trustPolicy, trustPolicyDigest, {
      bundle: renderAgentMicrovmCredentialIssuerRelease(imageReceipt, {
        runtimeLock: makeAgentMicrovmCredentialIssuerRuntimeLock(), timeoutSeconds: 601,
      }),
      clusterContext: bundle.runtimeLock.clusterContext, now: new Date("2026-07-26T00:05:00.000Z"),
    }), /authorization is invalid/);
  const revoked = { ...trustPolicy, keys: [{ ...trustPolicy.keys[0], status: "REVOKED" }] };
  assert.throws(() => verifyAgentMicrovmCredentialIssuerReleaseAuthorization(
    authorization, revoked, agentMicrovmCredentialIssuerReleaseTrustPolicyDigest(revoked), {
      bundle, clusterContext: bundle.runtimeLock.clusterContext, now: new Date("2026-07-26T00:05:00.000Z"),
    }), /authorization is invalid/);
});

test("credential issuer signer uses one fixed mTLS KMS route", async () => {
  const bundle = renderAgentMicrovmCredentialIssuerRelease(imageReceipt, {
    runtimeLock: makeAgentMicrovmCredentialIssuerRuntimeLock(),
  });
  const claims = createAgentMicrovmCredentialIssuerReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "77777777-7777-4777-8777-777777777777",
    issuedAt: new Date("2026-07-26T00:00:00.000Z"), ttlSeconds: 900,
  });
  const calls = [];
  const signer = new MtlsAgentMicrovmCredentialIssuerReleaseSigner({
    endpoint: "https://agent-release-signer.internal:8443/",
    keyId: trustPolicy.keys[0].keyId,
    tls: { key: Buffer.alloc(32, 1), cert: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    request: async (request) => { calls.push(request); return { statusCode: 200, body: {
      schemaVersion: "deviludo.agent-microvm-credential-issuer-release-signing-response.v1",
      algorithm: "Ed25519", claimsDigest: agentMicrovmCredentialIssuerReleaseSigningRequest(claims).claimsDigest,
      keyId: trustPolicy.keys[0].keyId,
      signature: sign(null, Buffer.from(canonicalJson(claims)), releaseKeys.privateKey).toString("base64url"),
    } }; },
  });
  const authorization = await signer.sign(bundle, claims, trustPolicy, trustPolicyDigest,
    new Date("2026-07-26T00:05:00.000Z"));
  assert.equal(authorization.claims.authorizationId, claims.authorizationId);
  assert.equal(calls[0].url.pathname, "/v1/agent-microvm-credential-issuer-releases/sign-ed25519");
  assert.equal(calls[0].headers["idempotency-key"], claims.authorizationId);
});

test("credential issuer release CLIs require immutable inputs and apply authority", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["lock:agent-microvm-credential-issuer-runtime"],
    "node scripts/production/lock-agent-microvm-credential-issuer-runtime.mjs");
  assert.equal(packageJson.scripts["authorize:agent-microvm-credential-issuer"],
    "node scripts/production/authorize-agent-microvm-credential-issuer-release.mjs");
  assert.equal(packageJson.scripts["deploy:agent-microvm-credential-issuer"],
    "node scripts/production/deploy-agent-microvm-credential-issuer.mjs");
  assert.equal(parseAgentMicrovmCredentialIssuerDeploymentArguments([
    "--receipt", "/private/tmp/receipt.json", "--runtime-lock", "/private/tmp/runtime-lock.json",
  ]).mode, "render");
  assert.equal(parseAgentMicrovmCredentialIssuerDeploymentArguments([
    "--apply", "--context", "prod-cluster/admin", "--receipt", "/private/tmp/receipt.json",
    "--runtime-lock", "/private/tmp/runtime-lock.json", "--authorization", "/private/tmp/auth.json",
    "--trust-policy", "/private/tmp/policy.json", "--trust-policy-digest", trustPolicyDigest,
  ]).mode, "apply");
  assert.throws(() => parseAgentMicrovmCredentialIssuerDeploymentArguments([
    "--apply", "--context", "prod-cluster/admin", "--receipt", "/tmp/receipt.json",
    "--runtime-lock", "/tmp/lock.json",
  ]), /input is invalid/);
  assert.equal(parseAgentMicrovmCredentialIssuerReleaseAuthorizationArguments([
    "--context", "prod-cluster/admin", "--receipt", "/private/tmp/receipt.json",
    "--runtime-lock", "/private/tmp/runtime-lock.json", "--trust-policy", "/private/tmp/policy.json",
    "--trust-policy-digest", trustPolicyDigest, "--timeout-seconds", "600",
  ]).timeoutSeconds, 600);
});

test("credential issuer repository trust policy is safe by default", () => {
  const example = JSON.parse(readFileSync(new URL(
    "../infra/agent-microvm-credential-issuer-release-trust-policy.example.json", import.meta.url), "utf8"));
  assert.equal(example.keys[0].status, "REVOKED");
  assert.deepEqual(validateAgentMicrovmCredentialIssuerReleaseTrustPolicy(example), example);
});

test("credential issuer release renders only a restricted workload with private tmpfs", () => {
  const runtimeLock = makeAgentMicrovmCredentialIssuerRuntimeLock();
  const bundle = renderAgentMicrovmCredentialIssuerRelease(imageReceipt, { runtimeLock, replicas: 2 });
  const namespace = bundle.stages[0].resources[0];
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted");
  const account = bundle.stages[1].resources.find((resource) => resource.kind === "ServiceAccount");
  assert.equal(account.automountServiceAccountToken, false);
  const policy = bundle.stages[1].resources.find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec, { podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  const deployment = bundle.stages[2].resources.find((resource) => resource.kind === "Deployment");
  const pod = deployment.spec.template.spec; const container = pod.containers[0];
  assert.equal(container.image, imageReceipt.imageReference);
  assert.equal(container.command, undefined); assert.equal(container.args, undefined);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.deepEqual(pod.nodeSelector, {
    "kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64",
    "deviludo.io/workload": "agent-microvm-credential-issuer",
  });
  assert.deepEqual(pod.volumes.find((volume) => volume.name === "credential-images").emptyDir,
    { medium: "Memory", sizeLimit: "256Mi" });
  assert.equal(pod.volumes.find((volume) => volume.name === "service-files").secret.defaultMode, 288);
  assert.equal(container.volumeMounts.find((mount) => mount.name === "service-files").readOnly, true);
  assert.equal(container.env.find((entry) => entry.name === "DEVILUDO_GUEST_CREDENTIAL_ISSUER_MKE2FS_EXECUTABLE").value,
    "/usr/sbin/mke2fs");
  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes("hostPath")); assert.ok(!serialized.includes("DEVILUDO_SERVICE"));
  assert.ok(!serialized.includes("claude")); assert.ok(!serialized.includes("codex"));
});

test("credential issuer apply reauthorizes and rechecks live resources before every mutation", async () => {
  const bundle = renderAgentMicrovmCredentialIssuerRelease(imageReceipt, {
    runtimeLock: makeAgentMicrovmCredentialIssuerRuntimeLock(),
  });
  let inspections = 0; const calls = [];
  const result = await applyAgentMicrovmCredentialIssuerRelease(bundle, bundle.runtimeLock.clusterContext, {
    authorization: signedAuthorization(bundle), trustPolicy, trustPolicyDigest,
    now: new Date("2026-07-26T00:05:00.000Z"),
    inspectRuntimeResources: async () => { inspections += 1;
      return observedAgentMicrovmCredentialIssuerRuntimeResources(bundle.runtimeLock); },
  }, async (invocation, input) => calls.push({ invocation, input }));
  assert.equal(inspections, 3); assert.equal(calls.length, 4);
  assert.ok(calls.slice(0, 3).every(({ invocation }) => invocation.args.includes("--validate=strict")));
  assert.ok(calls.every(({ invocation }) => !invocation.args.some((argument) =>
    new Set(["delete", "prune", "exec", "--force"]).has(argument))));
  assert.equal(result.authorization.keyId, trustPolicy.keys[0].keyId);
});

test("credential issuer apply performs no mutation for bad authority and stops on late drift", async () => {
  const bundle = renderAgentMicrovmCredentialIssuerRelease(imageReceipt, {
    runtimeLock: makeAgentMicrovmCredentialIssuerRuntimeLock(),
  });
  const calls = [];
  await assert.rejects(applyAgentMicrovmCredentialIssuerRelease(bundle, "other-cluster/admin", {
    authorization: signedAuthorization(bundle), trustPolicy, trustPolicyDigest,
    now: new Date("2026-07-26T00:05:00.000Z"),
    inspectRuntimeResources: async () => observedAgentMicrovmCredentialIssuerRuntimeResources(bundle.runtimeLock),
  }, async (...args) => calls.push(args)), /authorization is invalid/);
  assert.equal(calls.length, 0);
  let inspections = 0;
  await assert.rejects(applyAgentMicrovmCredentialIssuerRelease(bundle, bundle.runtimeLock.clusterContext, {
    authorization: signedAuthorization(bundle), trustPolicy, trustPolicyDigest,
    now: new Date("2026-07-26T00:05:00.000Z"),
    inspectRuntimeResources: async () => { inspections += 1;
      const resources = observedAgentMicrovmCredentialIssuerRuntimeResources(bundle.runtimeLock);
      return inspections < 3 ? resources : resources.map((resource, index) => index === 2
        ? { ...resource, uid: "90000000-0000-4000-8000-000000000099" } : resource); },
  }, async (...args) => calls.push(args)), /lock is invalid/);
  assert.equal(inspections, 3); assert.equal(calls.length, 2);
});

function signedAuthorization(bundle) {
  const claims = createAgentMicrovmCredentialIssuerReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "88888888-8888-4888-8888-888888888888",
    issuedAt: new Date("2026-07-26T00:00:00.000Z"), ttlSeconds: 900,
  });
  return Object.freeze({
    schemaVersion: "deviludo.agent-microvm-credential-issuer-release-authorization.v1",
    claims,
    signature: Object.freeze({
      algorithm: "Ed25519", keyId: trustPolicy.keys[0].keyId,
      value: sign(null, Buffer.from(canonicalJson(claims)), releaseKeys.privateKey).toString("base64url"),
    }),
  });
}
