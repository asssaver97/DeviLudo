import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  agentSupplyChainReleaseSigningRequest,
  agentSupplyChainReleaseTrustPolicyDigest,
  createAgentSupplyChainReleaseClaims,
  MtlsAgentSupplyChainReleaseSigner,
  validateAgentSupplyChainReleaseTrustPolicy,
  verifyAgentSupplyChainReleaseAuthorization,
} from "../scripts/production/agent-supply-chain-release-authorization.mjs";
import { parseAgentSupplyChainReleaseAuthorizationArguments } from "../scripts/production/authorize-agent-supply-chain-release.mjs";
import { canonicalJson } from "../scripts/production/control-release-authorization.mjs";
import {
  applyAgentSupplyChainRelease,
  parseAgentSupplyChainDeploymentArguments,
  renderAgentSupplyChainRelease,
} from "../scripts/production/deploy-agent-supply-chain.mjs";
import {
  agentSupplyChainRuntimeLockDigest,
  createAgentSupplyChainRuntimeLock,
  inspectAgentSupplyChainRuntimeResources,
  parseAgentSupplyChainRuntimeLockArguments,
  parseAgentSupplyChainRuntimeMetadataOutput,
  validateAgentSupplyChainRuntimeLock,
  verifyAgentSupplyChainRuntimeLock,
} from "../scripts/production/lock-agent-supply-chain-runtime.mjs";
import {
  agentSupplyChainConfigurationRevision,
  makeAgentSupplyChainRuntimeLock,
  observedAgentSupplyChainRuntimeResources,
} from "./agent-supply-chain-runtime-lock-fixture.mjs";

const sourceRevision = "b".repeat(40);
const platformVersion = "0.1.0-beta.1";
const imageDigest = `sha256:${"3".repeat(64)}`;
const imageReceipt = Object.freeze({
  schemaVersion: "deviludo.agent-supply-chain-image-receipt.v1",
  imageReference: `registry.internal/deviludo/agent-supply-chain@${imageDigest}`,
  imageDigest,
  nodeBaseImage: `registry.internal/base/node:22.13.1-bookworm-slim@sha256:${"1".repeat(64)}`,
  toolchainBaseImage: `registry.internal/deviludo/agent-supply-chain-toolchain:${platformVersion}@sha256:${"2".repeat(64)}`,
  sourceRevision,
  platform: "linux/amd64",
  platformVersion,
  dockerfileDigest: `sha256:${"4".repeat(64)}`,
  packageLockDigest: `sha256:${"5".repeat(64)}`,
  attestations: Object.freeze(["buildkit-provenance-mode-max", "buildkit-sbom"]),
  completedAt: "2026-07-24T00:00:00.000Z",
});
const releaseKeys = generateKeyPairSync("ed25519");
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.agent-supply-chain-release-trust-policy.v1",
  policyId: "deviludo-agent-supply-chain-production-releases",
  policyRevision: 1,
  keys: Object.freeze([Object.freeze({
    keyId: "agent-supply-chain-release-key-2026-01",
    algorithm: "Ed25519",
    publicKeySpkiBase64: releaseKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    status: "ACTIVE",
  })]),
});
const trustPolicyDigest = agentSupplyChainReleaseTrustPolicyDigest(trustPolicy);

function releaseBundle(overrides = {}) {
  const runtimeLock = overrides.runtimeLock ?? makeAgentSupplyChainRuntimeLock();
  return Object.freeze({
    schemaVersion: "deviludo.kubernetes-agent-supply-chain-release.v1",
    receipt: overrides.receipt ?? imageReceipt,
    runtimeLock,
    namespace: overrides.namespace ?? runtimeLock.namespace,
    replicas: overrides.replicas ?? 1,
  });
}

test("Agent supply-chain runtime lock CLI requires an explicit cluster and immutable revision", () => {
  assert.deepEqual(parseAgentSupplyChainRuntimeLockArguments([
    "--context", "production-ap-east-1/admin",
    "--configuration-revision", agentSupplyChainConfigurationRevision,
  ]), {
    clusterContext: "production-ap-east-1/admin",
    configurationRevision: agentSupplyChainConfigurationRevision,
    lockId: undefined,
    namespace: "deviludo-agent-supply-chain",
  });
  assert.throws(() => parseAgentSupplyChainRuntimeLockArguments([
    "--configuration-revision", agentSupplyChainConfigurationRevision,
  ]), /input is invalid/);
  assert.throws(() => parseAgentSupplyChainRuntimeLockArguments([
    "--context", "prod\nother",
    "--configuration-revision", agentSupplyChainConfigurationRevision,
  ]), /input is invalid/);
  assert.throws(() => parseAgentSupplyChainRuntimeLockArguments([
    "--context", "prod",
    "--configuration-revision", "latest",
  ]), /input is invalid/);
});

test("Agent supply-chain runtime lock binds all five exact resource identities", async () => {
  const expected = makeAgentSupplyChainRuntimeLock();
  const seen = [];
  const lock = await createAgentSupplyChainRuntimeLock({
    clusterContext: expected.clusterContext,
    namespace: expected.namespace,
    configurationRevision: expected.configurationRevision,
    createdAt: new Date(expected.createdAt),
    lockId: expected.lockId,
  }, async (request) => {
    seen.push(request);
    return observedAgentSupplyChainRuntimeResources(expected);
  });
  assert.deepEqual(lock, expected);
  assert.equal(seen[0].resources.length, 5);
  assert.match(agentSupplyChainRuntimeLockDigest(lock), /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => validateAgentSupplyChainRuntimeLock({
    ...lock,
    registrySecret: { ...lock.registrySecret, uid: lock.configMap.uid },
  }), /lock is invalid/);
  assert.throws(() => validateAgentSupplyChainRuntimeLock({ ...lock, unexpected: true }), /lock is invalid/);
});

test("Agent supply-chain runtime metadata parser requires immutable Secrets and ConfigMap", () => {
  const lock = makeAgentSupplyChainRuntimeLock();
  const output = observedAgentSupplyChainRuntimeResources(lock)
    .map((resource) => `${resource.kind} ${resource.name} ${resource.uid} ${resource.resourceVersion} ${resource.immutable === null ? "<none>" : resource.immutable}`)
    .join("\n");
  assert.equal(parseAgentSupplyChainRuntimeMetadataOutput(output).length, 5);
  assert.throws(() => parseAgentSupplyChainRuntimeMetadataOutput(output.replace("Secret", "Secret").replace(" true", " false")),
    /lock is invalid/);
  assert.throws(() => parseAgentSupplyChainRuntimeMetadataOutput(output.replace("<none>", "true")), /lock is invalid/);
});

test("Agent supply-chain runtime inspector uses metadata-only kubectl with an explicit context", async () => {
  const lock = makeAgentSupplyChainRuntimeLock();
  const calls = [];
  const output = observedAgentSupplyChainRuntimeResources(lock)
    .map((resource) => `${resource.kind} ${resource.name} ${resource.uid} ${resource.resourceVersion} ${resource.immutable === null ? "<none>" : resource.immutable}`)
    .join("\n");
  const result = await inspectAgentSupplyChainRuntimeResources({
    clusterContext: lock.clusterContext,
    namespace: lock.namespace,
    resources: [lock.filesSecret, lock.registrySecret, lock.releaseVolumeClaim, lock.configMap, lock.environmentSecret],
  }, async (invocation) => {
    calls.push(invocation);
    return output;
  });
  assert.equal(result.length, 5);
  assert.deepEqual(calls[0].args.slice(0, 4), ["--context", lock.clusterContext, "--namespace", lock.namespace]);
  assert.ok(calls[0].args.some((argument) => argument.startsWith("--output=custom-columns=")));
  assert.ok(!calls[0].args.includes("--output=json"));
});

test("Agent supply-chain runtime lock is rechecked and rejects any late resource replacement", async () => {
  const lock = makeAgentSupplyChainRuntimeLock();
  const verified = await verifyAgentSupplyChainRuntimeLock(lock, {
    clusterContext: lock.clusterContext,
    namespace: lock.namespace,
  }, async () => observedAgentSupplyChainRuntimeResources(lock));
  assert.equal(verified.resourceCount, 5);
  await assert.rejects(verifyAgentSupplyChainRuntimeLock(lock, {
    clusterContext: lock.clusterContext,
    namespace: lock.namespace,
  }, async () => observedAgentSupplyChainRuntimeResources(lock).map((resource, index) => index === 0
    ? { ...resource, resourceVersion: "99999" }
    : resource)), /lock is invalid/);
});

test("Agent supply-chain release trust policy is cryptographically separate and digest pinned", () => {
  assert.deepEqual(validateAgentSupplyChainReleaseTrustPolicy(trustPolicy, trustPolicyDigest), trustPolicy);
  assert.throws(() => validateAgentSupplyChainReleaseTrustPolicy({
    ...trustPolicy,
    schemaVersion: "deviludo.control-release-trust-policy.v1",
  }), /trust policy is invalid/);
  assert.throws(() => validateAgentSupplyChainReleaseTrustPolicy({
    ...trustPolicy,
    keys: [{ ...trustPolicy.keys[0], status: "UNKNOWN" }],
  }), /trust policy is invalid/);
  assert.throws(() => validateAgentSupplyChainReleaseTrustPolicy(trustPolicy, `sha256:${"0".repeat(64)}`),
    /trust policy is invalid/);
});

test("Agent supply-chain release claims bind image, toolchain, runtime resources and deployment scope", () => {
  const bundle = releaseBundle();
  const claims = createAgentSupplyChainReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "66666666-6666-4666-8666-666666666666",
    issuedAt: new Date("2026-07-24T00:00:00.000Z"),
    ttlSeconds: 900,
  });
  assert.equal(claims.toolchainBaseImage, imageReceipt.toolchainBaseImage);
  assert.equal(claims.runtimeLockDigest, agentSupplyChainRuntimeLockDigest(bundle.runtimeLock));
  assert.match(claims.receiptDigest, /^sha256:[a-f0-9]{64}$/);
  const request = agentSupplyChainReleaseSigningRequest(claims);
  assert.equal(request.schemaVersion, "deviludo.agent-supply-chain-release-signing-request.v1");
  assert.equal(Buffer.from(request.signingInput, "base64url").toString("utf8"), canonicalJson(claims));
  assert.throws(() => createAgentSupplyChainReleaseClaims(bundle, "another-cluster/admin"), /authorization is invalid/);
  assert.throws(() => createAgentSupplyChainReleaseClaims(bundle, bundle.runtimeLock.clusterContext, { ttlSeconds: 1_801 }),
    /authorization is invalid/);
});

test("Agent supply-chain authorization verifies exact claims and rejects control-plane or revoked authority", () => {
  const bundle = releaseBundle();
  const claims = createAgentSupplyChainReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "66666666-6666-4666-8666-666666666666",
    issuedAt: new Date("2026-07-24T00:00:00.000Z"),
    ttlSeconds: 900,
  });
  const authorization = Object.freeze({
    schemaVersion: "deviludo.agent-supply-chain-release-authorization.v1",
    claims,
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId: trustPolicy.keys[0].keyId,
      value: sign(null, Buffer.from(canonicalJson(claims)), releaseKeys.privateKey).toString("base64url"),
    }),
  });
  const result = verifyAgentSupplyChainReleaseAuthorization(authorization, trustPolicy, trustPolicyDigest, {
    bundle,
    clusterContext: bundle.runtimeLock.clusterContext,
    now: new Date("2026-07-24T00:05:00.000Z"),
  });
  assert.equal(result.keyId, trustPolicy.keys[0].keyId);
  assert.throws(() => verifyAgentSupplyChainReleaseAuthorization({
    ...authorization,
    schemaVersion: "deviludo.control-release-authorization.v2",
  }, trustPolicy, trustPolicyDigest, {
    bundle,
    clusterContext: bundle.runtimeLock.clusterContext,
    now: new Date("2026-07-24T00:05:00.000Z"),
  }), /authorization is invalid/);
  assert.throws(() => verifyAgentSupplyChainReleaseAuthorization(authorization, {
    ...trustPolicy,
    keys: [{ ...trustPolicy.keys[0], status: "REVOKED" }],
  }, agentSupplyChainReleaseTrustPolicyDigest({
    ...trustPolicy,
    keys: [{ ...trustPolicy.keys[0], status: "REVOKED" }],
  }), {
    bundle,
    clusterContext: bundle.runtimeLock.clusterContext,
    now: new Date("2026-07-24T00:05:00.000Z"),
  }), /authorization is invalid/);
  assert.throws(() => verifyAgentSupplyChainReleaseAuthorization(authorization, trustPolicy, trustPolicyDigest, {
    bundle: releaseBundle({ replicas: 2 }),
    clusterContext: bundle.runtimeLock.clusterContext,
    now: new Date("2026-07-24T00:05:00.000Z"),
  }), /authorization is invalid/);
});

test("Agent supply-chain signer uses only its fixed mTLS KMS route", async () => {
  const bundle = releaseBundle();
  const claims = createAgentSupplyChainReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "66666666-6666-4666-8666-666666666666",
    issuedAt: new Date("2026-07-24T00:00:00.000Z"),
    ttlSeconds: 900,
  });
  const calls = [];
  const signer = new MtlsAgentSupplyChainReleaseSigner({
    endpoint: "https://agent-release-signer.internal:8443/",
    keyId: trustPolicy.keys[0].keyId,
    tls: { key: Buffer.alloc(32, 1), cert: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    request: async (request) => {
      calls.push(request);
      return {
        statusCode: 200,
        body: {
          schemaVersion: "deviludo.agent-supply-chain-release-signing-response.v1",
          algorithm: "Ed25519",
          claimsDigest: agentSupplyChainReleaseSigningRequest(claims).claimsDigest,
          keyId: trustPolicy.keys[0].keyId,
          signature: sign(null, Buffer.from(canonicalJson(claims)), releaseKeys.privateKey).toString("base64url"),
        },
      };
    },
  });
  const authorization = await signer.sign(bundle, claims, trustPolicy, trustPolicyDigest,
    new Date("2026-07-24T00:05:00.000Z"));
  assert.equal(authorization.claims.authorizationId, claims.authorizationId);
  assert.equal(calls[0].url.pathname, "/v1/agent-supply-chain-releases/sign-ed25519");
  assert.equal(calls[0].headers["idempotency-key"], claims.authorizationId);
  assert.throws(() => new MtlsAgentSupplyChainReleaseSigner({
    endpoint: "http://agent-release-signer.internal/",
    keyId: trustPolicy.keys[0].keyId,
    tls: { key: Buffer.alloc(32), cert: Buffer.alloc(32), ca: Buffer.alloc(32) },
  }), /configuration is invalid/);
});

test("Agent supply-chain deployment CLI renders by default and requires full authority for apply", () => {
  assert.deepEqual(parseAgentSupplyChainDeploymentArguments([
    "--receipt", "/private/tmp/agent-supply-chain-receipt.json",
    "--runtime-lock", "/private/tmp/agent-supply-chain-runtime-lock.json",
    "--replicas", "2",
  ]), {
    authorizationPath: undefined,
    context: undefined,
    mode: "render",
    namespace: "deviludo-agent-supply-chain",
    receiptPath: "/private/tmp/agent-supply-chain-receipt.json",
    replicas: 2,
    runtimeLockPath: "/private/tmp/agent-supply-chain-runtime-lock.json",
    timeoutSeconds: 900,
    trustPolicyDigest: undefined,
    trustPolicyPath: undefined,
  });
  assert.equal(parseAgentSupplyChainDeploymentArguments([
    "--apply",
    "--context", "prod-cluster/admin",
    "--receipt", "/private/tmp/receipt.json",
    "--runtime-lock", "/private/tmp/runtime-lock.json",
    "--authorization", "/private/tmp/authorization.json",
    "--trust-policy", "/private/tmp/trust-policy.json",
    "--trust-policy-digest", trustPolicyDigest,
  ]).mode, "apply");
  assert.throws(() => parseAgentSupplyChainDeploymentArguments([
    "--apply", "--context", "prod-cluster/admin", "--receipt", "/tmp/receipt.json", "--runtime-lock", "/tmp/lock.json",
  ]), /input is invalid/);
  assert.throws(() => parseAgentSupplyChainDeploymentArguments([
    "--context", "prod-cluster/admin", "--receipt", "/tmp/receipt.json", "--runtime-lock", "/tmp/lock.json",
  ]), /input is invalid/);
  assert.throws(() => parseAgentSupplyChainDeploymentArguments([
    "--receipt", "relative.json", "--runtime-lock", "/tmp/lock.json",
  ]), /input is invalid/);
});

test("Agent supply-chain authorization CLI requires exact immutable release inputs", () => {
  assert.deepEqual(parseAgentSupplyChainReleaseAuthorizationArguments([
    "--context", "prod-cluster/admin",
    "--receipt", "/private/tmp/receipt.json",
    "--runtime-lock", "/private/tmp/runtime-lock.json",
    "--trust-policy", "/private/tmp/trust-policy.json",
    "--trust-policy-digest", trustPolicyDigest,
    "--authorization-id", "88888888-8888-4888-8888-888888888888",
    "--ttl-seconds", "600",
  ]), {
    authorizationId: "88888888-8888-4888-8888-888888888888",
    clusterContext: "prod-cluster/admin",
    namespace: "deviludo-agent-supply-chain",
    receiptPath: "/private/tmp/receipt.json",
    replicas: 1,
    runtimeLockPath: "/private/tmp/runtime-lock.json",
    trustPolicyDigest,
    trustPolicyPath: "/private/tmp/trust-policy.json",
    ttlSeconds: 600,
  });
  assert.throws(() => parseAgentSupplyChainReleaseAuthorizationArguments([
    "--context", "prod-cluster/admin", "--receipt", "/tmp/receipt.json",
  ]), /input is invalid/);
  assert.throws(() => parseAgentSupplyChainReleaseAuthorizationArguments([
    "--context", "prod-cluster/admin",
    "--receipt", "/tmp/receipt.json",
    "--runtime-lock", "/tmp/runtime-lock.json",
    "--trust-policy", "/tmp/trust-policy.json",
    "--trust-policy-digest", trustPolicyDigest,
    "--ttl-seconds", "1801",
  ]), /input is invalid/);
});

test("Agent supply-chain release renders one dedicated restricted workload and no shared authority", () => {
  const runtimeLock = makeAgentSupplyChainRuntimeLock();
  const bundle = renderAgentSupplyChainRelease(imageReceipt, { runtimeLock, replicas: 2 });
  assert.equal(bundle.stages.length, 3);
  const namespace = bundle.stages[0].resources[0];
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted");
  const account = bundle.stages[1].resources.find((resource) => resource.kind === "ServiceAccount");
  assert.equal(account.automountServiceAccountToken, false);
  assert.deepEqual(account.imagePullSecrets, [{ name: runtimeLock.registrySecret.name }]);
  const policy = bundle.stages[1].resources.find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec, { podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  const deployment = bundle.stages[2].resources.find((resource) => resource.kind === "Deployment");
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(deployment.spec.replicas, 2);
  assert.equal(container.image, imageReceipt.imageReference);
  assert.equal(container.command, undefined);
  assert.equal(container.args, undefined);
  assert.deepEqual(pod.nodeSelector, {
    "kubernetes.io/os": "linux",
    "kubernetes.io/arch": "amd64",
    "deviludo.io/workload": "agent-supply-chain",
  });
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.deepEqual(container.envFrom, [
    { configMapRef: { name: runtimeLock.configMap.name, optional: false } },
    { secretRef: { name: runtimeLock.environmentSecret.name, optional: false } },
  ]);
  assert.deepEqual(container.env.find((entry) => entry.name === "PATH"), {
    name: "PATH",
    value: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  });
  assert.deepEqual(container.env.find((entry) => entry.name === "LD_PRELOAD"), { name: "LD_PRELOAD", value: "" });
  assert.deepEqual(container.env.find((entry) => entry.name === "NODE_OPTIONS"), {
    name: "NODE_OPTIONS",
    value: "--enable-source-maps",
  });
  assert.equal(pod.volumes.find((volume) => volume.name === "native-release").persistentVolumeClaim.claimName,
    runtimeLock.releaseVolumeClaim.name);
  assert.equal(container.volumeMounts.find((mount) => mount.name === "native-release").readOnly, true);
  assert.equal(container.volumeMounts.find((mount) => mount.name === "work").mountPath,
    "/var/lib/deviludo/agent-supply-chain");
  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes("DEVILUDO_SERVICE"));
  assert.ok(!serialized.includes("schema-migrator"));
  assert.ok(!serialized.includes("dangerously"));
  assert.ok(!serialized.includes("hostPath"));
});

test("Agent supply-chain apply reauthorizes and rechecks live resources before every mutation", async () => {
  const bundle = renderAgentSupplyChainRelease(imageReceipt, { runtimeLock: makeAgentSupplyChainRuntimeLock() });
  let inspections = 0;
  const security = signedAgentSupplyChainSecurity(bundle, {
    inspectRuntimeResources: async () => {
      inspections += 1;
      return observedAgentSupplyChainRuntimeResources(bundle.runtimeLock);
    },
  });
  const calls = [];
  const result = await applyAgentSupplyChainRelease(bundle, bundle.runtimeLock.clusterContext, security,
    async (invocation, input) => calls.push({ invocation, input }));
  assert.equal(inspections, 3);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ invocation }) => invocation.command === "kubectl" && !Object.hasOwn(invocation, "shell")));
  assert.deepEqual(calls[0].invocation.args.slice(0, 2), ["--context", bundle.runtimeLock.clusterContext]);
  assert.equal(JSON.parse(calls[0].input).items[0].kind, "Namespace");
  assert.deepEqual(JSON.parse(calls[1].input).items.map((resource) => resource.kind), ["ServiceAccount", "NetworkPolicy"]);
  assert.deepEqual(JSON.parse(calls[2].input).items.map((resource) => resource.kind), ["Service", "Deployment"]);
  assert.ok(calls[3].invocation.args.includes("deployment/deviludo-agent-supply-chain"));
  assert.ok(calls.slice(0, 3).every(({ invocation }) => invocation.args.includes("--validate=strict")));
  assert.ok(calls.every(({ invocation }) => !invocation.args.some((argument) => new Set(["delete", "prune", "exec", "--force"]).has(argument))));
  assert.equal(result.authorization.keyId, trustPolicy.keys[0].keyId);
});

test("Agent supply-chain apply performs no mutation for bad scope and stops on late runtime drift", async () => {
  const bundle = renderAgentSupplyChainRelease(imageReceipt, { runtimeLock: makeAgentSupplyChainRuntimeLock() });
  const calls = [];
  await assert.rejects(applyAgentSupplyChainRelease(bundle, "another-cluster/admin",
    signedAgentSupplyChainSecurity(bundle), async (...args) => calls.push(args)), /authorization is invalid/);
  assert.equal(calls.length, 0);

  let inspections = 0;
  await assert.rejects(applyAgentSupplyChainRelease(bundle, bundle.runtimeLock.clusterContext,
    signedAgentSupplyChainSecurity(bundle, {
      inspectRuntimeResources: async () => {
        inspections += 1;
        const resources = observedAgentSupplyChainRuntimeResources(bundle.runtimeLock);
        return inspections < 3 ? resources : resources.map((resource, index) => index === 2
          ? { ...resource, uid: "90000000-0000-4000-8000-000000000099" }
          : resource);
      },
    }), async (...args) => calls.push(args)), /lock is invalid/);
  assert.equal(inspections, 3);
  assert.equal(calls.length, 2);
});

function signedAgentSupplyChainSecurity(bundle, overrides = {}) {
  const claims = createAgentSupplyChainReleaseClaims(bundle, bundle.runtimeLock.clusterContext, {
    authorizationId: "77777777-7777-4777-8777-777777777777",
    issuedAt: new Date("2026-07-24T00:00:00.000Z"),
    ttlSeconds: 900,
  });
  return Object.freeze({
    authorization: Object.freeze({
      schemaVersion: "deviludo.agent-supply-chain-release-authorization.v1",
      claims,
      signature: Object.freeze({
        algorithm: "Ed25519",
        keyId: trustPolicy.keys[0].keyId,
        value: sign(null, Buffer.from(canonicalJson(claims)), releaseKeys.privateKey).toString("base64url"),
      }),
    }),
    trustPolicy,
    trustPolicyDigest,
    now: new Date("2026-07-24T00:05:00.000Z"),
    inspectRuntimeResources: overrides.inspectRuntimeResources
      ?? (async () => observedAgentSupplyChainRuntimeResources(bundle.runtimeLock)),
  });
}
