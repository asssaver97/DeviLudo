import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseControlReleaseAuthorizationArguments } from "../scripts/production/authorize-control-plane-release.mjs";
import {
  canonicalJson,
  controlReleaseSigningRequest,
  controlReleaseTrustPolicyDigest,
  createControlReleaseClaims,
  MtlsControlReleaseSigner,
  validateControlReleaseTrustPolicy,
  verifyControlReleaseAuthorization,
} from "../scripts/production/control-release-authorization.mjs";
import { renderControlPlaneRelease } from "../scripts/production/deploy-control-plane.mjs";
import { controlRuntimeLockDigest } from "../scripts/production/lock-control-runtime.mjs";
import {
  inspectControlReleaseTrustPolicy,
  parseControlReleaseTrustInspectionArguments,
} from "../scripts/production/inspect-control-release-trust-policy.mjs";
import { makeControlRuntimeLock } from "./control-runtime-lock-fixture.mjs";

const keyPair = generateKeyPairSync("ed25519");
const keyId = "control-release-key-2026-01";
const policy = Object.freeze({
  schemaVersion: "deviludo.control-release-trust-policy.v1",
  policyId: "deviludo-production-releases",
  policyRevision: 3,
  keys: Object.freeze([Object.freeze({
    keyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64: keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    status: "ACTIVE",
  })]),
});
const policyDigest = controlReleaseTrustPolicyDigest(policy);
const receipt = Object.freeze({
  schemaVersion: "deviludo.control-plane-image-receipt.v1",
  imageReference: `registry.internal/deviludo/control-plane@sha256:${"c".repeat(64)}`,
  imageDigest: `sha256:${"c".repeat(64)}`,
  baseImage: `registry.internal/base/node:22.13.1-bookworm-slim@sha256:${"a".repeat(64)}`,
  sourceRevision: "b".repeat(40),
  platform: "linux/amd64",
  platformVersion: "0.1.0-beta.1",
  dockerfileDigest: `sha256:${"d".repeat(64)}`,
  packageLockDigest: `sha256:${"e".repeat(64)}`,
  attestations: Object.freeze(["buildkit-provenance-mode-max", "buildkit-sbom"]),
  completedAt: "2026-07-22T00:00:00.000Z",
});
const context = "production-ap-east-1/platform-admin";
const runtimeLock = makeControlRuntimeLock({
  clusterContext: context,
  namespace: "deviludo-prod",
  services: ["agent-configuration", "control-plane"],
});
const bundle = renderControlPlaneRelease(receipt, {
  namespace: "deviludo-prod",
  replicas: 2,
  services: ["agent-configuration", "control-plane"],
  runtimeLock,
});
const issuedAt = new Date("2026-07-22T00:00:00.000Z");
const now = new Date("2026-07-22T00:05:00.000Z");

test("trust policy pins sorted Ed25519 public keys, lifecycle and a canonical semantic digest", () => {
  assert.deepEqual(validateControlReleaseTrustPolicy(policy, policyDigest), policy);
  assert.match(policyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(controlReleaseTrustPolicyDigest({
    policyRevision: 3,
    keys: policy.keys,
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
  }), policyDigest);
  assert.throws(
    () => validateControlReleaseTrustPolicy({ ...policy, keys: [policy.keys[0], policy.keys[0]] }, policyDigest),
    /trust policy is invalid/,
  );
  assert.throws(
    () => validateControlReleaseTrustPolicy(policy, `sha256:${"0".repeat(64)}`),
    /trust policy is invalid/,
  );
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () => validateControlReleaseTrustPolicy({
      ...policy,
      keys: [{ ...policy.keys[0], publicKeySpkiBase64: rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64") }],
    }),
    /trust policy is invalid/,
  );
});

test("checked-in trust template is valid but revoked, and inspection reveals no public-key material", () => {
  const template = JSON.parse(readFileSync(
    new URL("../infra/control-release-trust-policy.example.json", import.meta.url),
    "utf8",
  ));
  const inspection = inspectControlReleaseTrustPolicy(template);
  assert.equal(inspection.keys[0].status, "REVOKED");
  assert.match(inspection.policyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(inspection).includes("publicKeySpkiBase64"));
  assert.deepEqual(parseControlReleaseTrustInspectionArguments([
    "--trust-policy", "/private/reviewed/control-release-trust.json",
  ]), { trustPolicyPath: "/private/reviewed/control-release-trust.json" });
  assert.throws(
    () => parseControlReleaseTrustInspectionArguments(["--trust-policy", "relative.json"]),
    /input is invalid/,
  );
});

test("short-lived authorization binds the image, cluster, runtime lock, namespace, services and replicas", () => {
  const claims = claimsFor(bundle);
  const authorization = signedAuthorization(claims);
  const evidence = verifyControlReleaseAuthorization(authorization, policy, policyDigest, { bundle, clusterContext: context, now });
  assert.equal(evidence.authorizationId, claims.authorizationId);
  assert.equal(evidence.keyId, keyId);
  assert.equal(evidence.trustPolicyDigest, policyDigest);
  assert.equal(claims.runtimeLockDigest, controlRuntimeLockDigest(runtimeLock));
  assert.throws(
    () => verifyControlReleaseAuthorization({ ...authorization, schemaVersion: "deviludo.control-release-authorization.v1" },
      policy, policyDigest, { bundle, clusterContext: context, now }),
    /authorization is invalid/,
  );

  for (const [changedBundle, changedContext] of [
    [{ ...bundle, namespace: "other-prod" }, context],
    [{ ...bundle, replicas: 3 }, context],
    [{ ...bundle, services: ["control-plane"] }, context],
    [{ ...bundle, runtimeLock: { ...runtimeLock, configurationRevision: "abcdefabcdef" } }, context],
    [{ ...bundle, receipt: { ...receipt, imageDigest: `sha256:${"f".repeat(64)}` } }, context],
    [bundle, "another-cluster/admin"],
  ]) {
    assert.throws(
      () => verifyControlReleaseAuthorization(authorization, policy, policyDigest, {
        bundle: changedBundle,
        clusterContext: changedContext,
        now,
      }),
      /authorization is invalid/,
    );
  }
  assert.throws(
    () => verifyControlReleaseAuthorization(authorization, policy, policyDigest, {
      bundle,
      clusterContext: context,
      now: new Date("2026-07-22T00:20:00.000Z"),
    }),
    /authorization is invalid/,
  );
  assert.throws(
    () => verifyControlReleaseAuthorization({
      ...authorization,
      signature: {
        ...authorization.signature,
        value: `${authorization.signature.value.startsWith("A") ? "B" : "A"}${authorization.signature.value.slice(1)}`,
      },
    }, policy, policyDigest, { bundle, clusterContext: context, now }),
    /authorization is invalid/,
  );
  const revoked = { ...policy, keys: [{ ...policy.keys[0], status: "REVOKED" }] };
  assert.throws(
    () => verifyControlReleaseAuthorization(authorization, revoked, controlReleaseTrustPolicyDigest(revoked), {
      bundle,
      clusterContext: context,
      now,
    }),
    /authorization is invalid/,
  );
});

test("mTLS signer sends only canonical claims to one fixed KMS route and locally verifies its response", async () => {
  const claims = claimsFor(bundle);
  const calls = [];
  const signer = new MtlsControlReleaseSigner({
    endpoint: "https://kms-signing.internal:8443",
    keyId,
    tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    request: async (input) => {
      calls.push(input);
      const body = JSON.parse(input.body);
      assert.equal(body.keyId, keyId);
      assert.deepEqual(body, { ...controlReleaseSigningRequest(claims), keyId });
      return {
        statusCode: 200,
        body: {
          schemaVersion: "deviludo.control-release-signing-response.v2",
          algorithm: "Ed25519",
          keyId,
          claimsDigest: body.claimsDigest,
          signature: sign(null, Buffer.from(body.signingInput, "base64url"), keyPair.privateKey).toString("base64url"),
        },
      };
    },
  });
  const authorization = await signer.sign(bundle, claims, policy, policyDigest, now);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://kms-signing.internal:8443/v2/control-releases/sign-ed25519");
  assert.equal(calls[0].headers["idempotency-key"], claims.authorizationId);
  assert.equal(authorization.claims, claims);
  assert.equal(authorization.signature.keyId, keyId);
  await assert.rejects(
    signer.sign({ ...bundle, namespace: "other-prod" }, claims, policy, policyDigest, now),
    /authorization is invalid/,
  );
  assert.equal(calls.length, 1);

  const drifted = new MtlsControlReleaseSigner({
    endpoint: "https://kms-signing.internal",
    keyId,
    tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    request: async () => ({
      statusCode: 200,
      body: {
        schemaVersion: "deviludo.control-release-signing-response.v2",
        algorithm: "Ed25519",
        keyId,
        claimsDigest: `sha256:${"0".repeat(64)}`,
        signature: "A".repeat(86),
      },
    }),
  });
  await assert.rejects(drifted.sign(bundle, claims, policy, policyDigest, now), /authorization is invalid/);
  assert.throws(
    () => new MtlsControlReleaseSigner({
      endpoint: "http://kms-signing.internal",
      keyId,
      tls: { key: Buffer.alloc(64), cert: Buffer.alloc(64), ca: Buffer.alloc(64) },
    }),
    /signing configuration is invalid/,
  );
});

test("authorization CLI requires absolute inputs, an exact trust digest and explicit cluster context", () => {
  assert.deepEqual(parseControlReleaseAuthorizationArguments([
    "--receipt", "/private/control-receipt.json",
    "--runtime-lock", "/private/control-runtime-lock.json",
    "--context", context,
    "--namespace", "deviludo-prod",
    "--services", "control-plane,agent-configuration",
    "--replicas", "2",
    "--ttl-seconds", "600",
    "--authorization-id", "33333333-3333-4333-8333-333333333333",
    "--trust-policy", "/private/control-trust.json",
    "--trust-policy-digest", policyDigest,
  ]), {
    authorizationId: "33333333-3333-4333-8333-333333333333",
    clusterContext: context,
    namespace: "deviludo-prod",
    receiptPath: "/private/control-receipt.json",
    replicas: 2,
    runtimeLockPath: "/private/control-runtime-lock.json",
    services: ["agent-configuration", "control-plane"],
    trustPolicyDigest: policyDigest,
    trustPolicyPath: "/private/control-trust.json",
    ttlSeconds: 600,
  });
  assert.throws(
    () => parseControlReleaseAuthorizationArguments([
      "--receipt", "relative.json", "--runtime-lock", "/private/lock.json", "--context", context,
      "--trust-policy", "/private/policy.json", "--trust-policy-digest", policyDigest,
    ]),
    /input is invalid/,
  );
  assert.throws(
    () => parseControlReleaseAuthorizationArguments([
      "--receipt", "/private/receipt.json", "--runtime-lock", "/private/lock.json", "--context", "prod\nother",
      "--trust-policy", "/private/policy.json", "--trust-policy-digest", policyDigest,
    ]),
    /input is invalid/,
  );
});

function claimsFor(selectedBundle) {
  return createControlReleaseClaims(selectedBundle, context, {
    authorizationId: "11111111-1111-4111-8111-111111111111",
    issuedAt,
    ttlSeconds: 900,
  });
}

function signedAuthorization(claims) {
  return Object.freeze({
    schemaVersion: "deviludo.control-release-authorization.v2",
    claims,
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId,
      value: sign(null, Buffer.from(canonicalJson(claims)), keyPair.privateKey).toString("base64url"),
    }),
  });
}
