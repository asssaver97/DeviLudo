import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildAgentSupplyChainNative,
  parseAgentSupplyChainNativeBuildArguments,
  validateAgentSupplyChainNativeBuildReceipt,
} from "../scripts/build-agent-supply-chain-native.mjs";
import {
  finalizeAgentSupplyChainNative,
  MtlsAgentSupplyChainNativeSigner,
  parseAgentSupplyChainNativeFinalizationArguments,
  prepareAgentSupplyChainNativeClaims,
} from "../scripts/production/finalize-agent-supply-chain-native.mjs";
import {
  inspectAgentSupplyChainNativeTrustPolicy,
  parseAgentSupplyChainNativeTrustInspectionArguments,
} from "../scripts/production/inspect-agent-supply-chain-native-trust-policy.mjs";
import {
  agentSupplyChainNativeTrustPolicyDigest,
  validateAgentSupplyChainNativeTrustPolicy,
  verifySignedAgentSupplyChainNativeRelease,
} from "../services/agent-supply-chain/src/native-release-manifest.ts";
import { canonicalJson, sha256Canonical } from "../services/runner-control/src/canonical.ts";

const sourceRevision = "a".repeat(40);
const keyPair = generateKeyPairSync("ed25519");
const keyId = "agent-supply-chain-native-2026-01";
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.agent-supply-chain-native-trust-policy.v1",
  policyId: "deviludo-agent-supply-chain-native-production",
  policyRevision: 1,
  keys: Object.freeze([Object.freeze({
    keyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64: keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    status: "ACTIVE",
  })]),
});
const trustPolicyDigest = agentSupplyChainNativeTrustPolicyDigest(trustPolicy);

test("Agent supply-chain native builder emits one immutable source-bound candidate", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-agent-native-build-"));
  const outputParent = resolve(root, "out");
  const outputDirectory = resolve(outputParent, "release");
  await Promise.all([
    mkdir(outputParent),
    mkdir(resolve(root, "node_modules/esbuild/lib"), { recursive: true }),
    mkdir(resolve(root, "services/agent-supply-chain/src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(root, "package.json"), JSON.stringify({
      version: "0.1.0-beta.1", devDependencies: { esbuild: "0.28.0" },
    })),
    writeFile(resolve(root, "package-lock.json"), JSON.stringify({ packages: {
      "node_modules/esbuild": {
        version: "0.28.0",
        resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.0.tgz",
        integrity: "sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==",
      },
    } })),
    writeFile(resolve(root, "node_modules/esbuild/lib/main.js"), "fixed-esbuild-library\n"),
    writeFile(resolve(root, "services/agent-supply-chain/src/run-native-policy.ts"), "entry\n"),
  ]);
  const result = await buildAgentSupplyChainNative({ outputDirectory, sourceRevision }, {
    root,
    verifySource: async (receivedRoot, receivedRevision) => {
      assert.equal(receivedRoot, root); assert.equal(receivedRevision, sourceRevision);
    },
    uuid: () => "11111111-1111-4111-8111-111111111111",
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    bundle: async (options) => {
      assert.equal(options.target, "node22.13");
      assert.equal(options.format, "esm");
      await writeFile(options.outfile, "#!/usr/bin/node\nfixed privileged policy artifact\n");
      return { metafile: { inputs: { "entry.ts": {}, "dependency.ts": {} } } };
    },
  });
  const { outputDirectory: publishedDirectory, ...receipt } = result;
  assert.equal(publishedDirectory, outputDirectory);
  assert.deepEqual(validateAgentSupplyChainNativeBuildReceipt(receipt), receipt);
  assert.equal(receipt.bundleInputCount, 2);
  assert.equal(receipt.sourceRevision, sourceRevision);
  assert.deepEqual(JSON.parse(await readFile(resolve(outputDirectory,
    "agent-supply-chain-native-build-receipt.json"), "utf8")), receipt);
  assert.deepEqual(parseAgentSupplyChainNativeBuildArguments([
    "--output-directory", outputDirectory, "--source-revision", sourceRevision,
  ]), { outputDirectory, sourceRevision });
  assert.throws(() => parseAgentSupplyChainNativeBuildArguments([
    "--output-directory", "relative", "--source-revision", sourceRevision,
  ]), /build input is invalid/);
});

test("Agent supply-chain native finalizer binds scans, candidate bytes and one KMS envelope", async () => {
  const fixture = await releaseFixture();
  const claims = await prepareAgentSupplyChainNativeClaims(fixture.options);
  assert.equal(claims.artifactDigest, fixture.artifactDigest);
  assert.equal(claims.buildReceiptDigest, fixture.buildReceiptDigest);
  const calls = [];
  const signer = new MtlsAgentSupplyChainNativeSigner({
    endpoint: "https://agent-native-kms.internal:8443",
    keyId,
    tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    request: async (input) => {
      calls.push(input);
      const body = JSON.parse(input.body);
      return { statusCode: 200, body: {
        schemaVersion: "deviludo.agent-supply-chain-native-signing-response.v1",
        algorithm: "Ed25519",
        keyId,
        claimsDigest: body.claimsDigest,
        signature: sign(null, Buffer.from(body.signingInput, "base64url"), keyPair.privateKey).toString("base64url"),
      } };
    },
  });
  const finalized = await finalizeAgentSupplyChainNative(fixture.options, {
    signer, now: new Date("2026-07-24T00:01:00.000Z"),
  });
  assert.equal(finalized.replayed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://agent-native-kms.internal:8443/v1/agent-supply-chain-native/sign-ed25519");
  assert.equal(calls[0].headers["idempotency-key"], sha256Canonical(claims));
  assert.deepEqual(JSON.parse(await readFile(fixture.options.outputPath, "utf8")), finalized.manifest);
  assert.deepEqual(verifySignedAgentSupplyChainNativeRelease(finalized.manifest, {
    trustPolicy,
    trustPolicyDigest,
    platformVersion: claims.platformVersion,
    artifactDigest: claims.artifactDigest,
    buildReceiptDigest: claims.buildReceiptDigest,
    now: new Date("2026-07-24T00:01:00.000Z"),
  }), claims);
  assert.throws(() => verifySignedAgentSupplyChainNativeRelease({
    ...finalized.manifest,
    claims: { ...finalized.manifest.claims, provenanceDigest: "9".repeat(64) },
  }, {
    trustPolicy,
    trustPolicyDigest,
    platformVersion: claims.platformVersion,
    artifactDigest: claims.artifactDigest,
    buildReceiptDigest: claims.buildReceiptDigest,
    now: new Date("2026-07-24T00:01:00.000Z"),
  }), /release is invalid/);
  const revokedPolicy = { ...trustPolicy, keys: trustPolicy.keys.map((key) => ({ ...key, status: "REVOKED" })) };
  assert.throws(() => verifySignedAgentSupplyChainNativeRelease(finalized.manifest, {
    trustPolicy: revokedPolicy,
    trustPolicyDigest: agentSupplyChainNativeTrustPolicyDigest(revokedPolicy),
    platformVersion: claims.platformVersion,
    artifactDigest: claims.artifactDigest,
    buildReceiptDigest: claims.buildReceiptDigest,
    now: new Date("2026-07-24T00:01:00.000Z"),
  }), /release is invalid/);

  const replay = await finalizeAgentSupplyChainNative(fixture.options, {
    signer: { async sign() { throw new Error("KMS must not run during replay"); } },
    now: new Date("2026-07-24T00:02:00.000Z"),
  });
  assert.equal(replay.replayed, true);
  await writeFile(fixture.options.artifactPath, "tampered\n");
  await assert.rejects(finalizeAgentSupplyChainNative(fixture.options, {
    signer, now: new Date("2026-07-24T00:02:00.000Z"),
  }), /finalization input is invalid/);
});

test("Agent supply-chain native trust and CLI contracts are exact and revoked by default", async () => {
  assert.deepEqual(validateAgentSupplyChainNativeTrustPolicy(trustPolicy, trustPolicyDigest), trustPolicy);
  const template = JSON.parse(await readFile(new URL("../infra/agent-supply-chain-native-trust-policy.example.json", import.meta.url), "utf8"));
  assert.equal(template.keys[0].status, "REVOKED");
  assert.doesNotThrow(() => validateAgentSupplyChainNativeTrustPolicy(template));
  const inspection = inspectAgentSupplyChainNativeTrustPolicy(template);
  assert.equal(inspection.keys[0].status, "REVOKED");
  assert.ok(!JSON.stringify(inspection).includes("publicKeySpkiBase64"));
  assert.deepEqual(parseAgentSupplyChainNativeTrustInspectionArguments([
    "--trust-policy", "/private/reviewed/agent-native-trust.json",
  ]), { trustPolicyPath: "/private/reviewed/agent-native-trust.json" });
  assert.throws(() => parseAgentSupplyChainNativeTrustInspectionArguments([
    "--trust-policy", "relative.json",
  ]), /input is invalid/);
  const fixture = await releaseFixture();
  const argv = [
    "--artifact", fixture.options.artifactPath,
    "--build-receipt", fixture.options.buildReceiptPath,
    "--evidence", fixture.options.evidencePath,
    "--output", fixture.options.outputPath,
    "--published-at", fixture.options.publishedAt,
    "--release-id", fixture.options.releaseId,
    "--source-revision", fixture.options.sourceRevision,
    "--trust-policy", fixture.options.trustPolicyPath,
    "--trust-policy-digest", fixture.options.trustPolicyDigest,
  ];
  assert.equal(parseAgentSupplyChainNativeFinalizationArguments(argv).releaseId, fixture.options.releaseId);
  assert.throws(() => parseAgentSupplyChainNativeFinalizationArguments(argv.map((value) =>
    value === sourceRevision ? "latest" : value)), /input is invalid/);
  assert.throws(() => new MtlsAgentSupplyChainNativeSigner({
    endpoint: "http://agent-native-kms.internal", keyId,
    tls: { key: Buffer.alloc(64), cert: Buffer.alloc(64), ca: Buffer.alloc(64) },
  }), /input is invalid/);
  assert.ok(canonicalJson(trustPolicy).includes(keyId));
});

async function releaseFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-agent-native-release-"));
  const artifactPath = resolve(root, "deviludo-agent-supply-chain-native.mjs");
  const buildReceiptPath = resolve(root, "agent-supply-chain-native-build-receipt.json");
  const evidencePath = resolve(root, "evidence.json");
  const outputPath = resolve(root, "release.json");
  const trustPolicyPath = resolve(root, "trust-policy.json");
  const artifact = Buffer.from("#!/usr/bin/node\nreleased privileged policy artifact\n");
  const artifactDigest = digest(artifact);
  const buildReceipt = {
    schemaVersion: "deviludo.agent-supply-chain-native-build-receipt.v2",
    status: "CANDIDATE",
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    nodeTarget: "22.13",
    packageLockDigest: "1".repeat(64),
    esbuildVersion: "0.28.0",
    esbuildLibraryDigest: "2".repeat(64),
    entryPoint: "services/agent-supply-chain/src/run-native-policy.ts",
    artifactFileName: "deviludo-agent-supply-chain-native.mjs",
    artifactDigest,
    sizeBytes: artifact.byteLength,
    bundleInputCount: 17,
    bundleInputDigest: "3".repeat(64),
    completedAt: "2026-07-24T00:00:00.000Z",
  };
  const buildBytes = Buffer.from(`${JSON.stringify(buildReceipt, null, 2)}\n`);
  const buildReceiptDigest = digest(buildBytes);
  await Promise.all([
    writeFile(artifactPath, artifact),
    writeFile(buildReceiptPath, buildBytes),
    writeFile(evidencePath, JSON.stringify({
      schemaVersion: "deviludo.agent-supply-chain-native-evidence.v1",
      scanState: "PASS",
      artifactDigest,
      buildReceiptDigest,
      sbomDigest: "4".repeat(64),
      malwareScanDigest: "5".repeat(64),
      vulnerabilityScanDigest: "6".repeat(64),
      provenanceDigest: "7".repeat(64),
    })),
    writeFile(trustPolicyPath, JSON.stringify(trustPolicy)),
  ]);
  return Object.freeze({
    artifactDigest,
    buildReceiptDigest,
    options: Object.freeze({
      artifactPath,
      buildReceiptPath,
      evidencePath,
      outputPath,
      publishedAt: "2026-07-24T00:00:30.000Z",
      releaseId: "11111111-1111-4111-8111-111111111111",
      sourceRevision,
      trustPolicyDigest,
      trustPolicyPath,
    }),
  });
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
