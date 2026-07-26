import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAgentExecutionWorkerNative,
  parseAgentExecutionWorkerNativeBuildArguments,
  validateAgentExecutionWorkerNativeBuildReceipt,
} from "../scripts/build-agent-execution-worker-native.mjs";
import {
  finalizeAgentExecutionWorkerNative,
  MtlsAgentExecutionWorkerNativeSigner,
  parseAgentExecutionWorkerNativeFinalizationArguments,
  prepareAgentExecutionWorkerNativeClaims,
} from "../scripts/production/finalize-agent-execution-worker-native.mjs";
import {
  inspectAgentExecutionWorkerNativeTrustPolicy,
  parseAgentExecutionWorkerNativeTrustInspectionArguments,
} from "../scripts/production/inspect-agent-execution-worker-native-trust-policy.mjs";
import {
  agentExecutionWorkerNativeTrustPolicyDigest,
  validateAgentExecutionWorkerNativeTrustPolicy,
  verifyAgentExecutionWorkerNativeRuntime,
  verifySignedAgentExecutionWorkerNativeRelease,
} from "../services/agent-execution-broker/src/native-worker-release.ts";
import { canonicalJson } from "../services/runner-control/src/canonical.ts";

const sourceRevision = "a".repeat(40);
const keyPair = generateKeyPairSync("ed25519");
const keyId = "agent-execution-worker-native-2026-01";
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.agent-execution-worker-native-trust-policy.v1",
  policyId: "deviludo-agent-execution-worker-native-production",
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
const trustPolicyDigest = agentExecutionWorkerNativeTrustPolicyDigest(trustPolicy);

test("Agent execution Worker native builder emits an immutable source-bound bundle", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-agent-worker-native-build-"));
  const outputParent = resolve(root, "out"); const outputDirectory = resolve(outputParent, "candidate");
  await Promise.all([
    mkdir(outputParent),
    mkdir(resolve(root, "node_modules/esbuild/lib"), { recursive: true }),
    mkdir(resolve(root, "services/agent-execution-broker/src"), { recursive: true }),
  ]);
  const packageLock = { packages: { "node_modules/esbuild": {
    version: "0.28.0",
    resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.0.tgz",
    integrity: "sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==",
  } } };
  await Promise.all([
    writeFile(resolve(root, "package.json"), JSON.stringify({ version: "0.1.0-beta.1", devDependencies: { esbuild: "0.28.0" } })),
    writeFile(resolve(root, "package-lock.json"), JSON.stringify(packageLock)),
    writeFile(resolve(root, "node_modules/esbuild/lib/main.js"), "locked esbuild library"),
    writeFile(resolve(root, "services/agent-execution-broker/src/run-native-worker-bundle.ts"), "export {};"),
  ]);
  const receipt = await buildAgentExecutionWorkerNative({ outputDirectory, sourceRevision }, {
    root,
    verifySource: async () => undefined,
    now: () => new Date("2026-07-26T01:00:00.000Z"),
    uuid: () => "11111111-1111-4111-8111-111111111111",
    bundle: async ({ outfile }) => {
      await writeFile(outfile, "#!/usr/bin/node\nproduction worker bundle\n");
      return { metafile: { inputs: { "b.ts": {}, "a.ts": {} } } };
    },
  });
  assert.equal(receipt.schemaVersion, "deviludo.agent-execution-worker-native-build-receipt.v1");
  assert.equal(receipt.entryPoint, "services/agent-execution-broker/src/run-native-worker-bundle.ts");
  assert.equal(receipt.bundleInputCount, 2);
  assert.deepEqual(validateAgentExecutionWorkerNativeBuildReceipt(
    JSON.parse(await readFile(resolve(outputDirectory, "agent-execution-worker-native-build-receipt.json"), "utf8"))),
  Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "outputDirectory")));
  assert.deepEqual(parseAgentExecutionWorkerNativeBuildArguments([
    "--source-revision", sourceRevision, "--output-directory", outputDirectory,
  ]), { outputDirectory, sourceRevision });
  assert.throws(() => parseAgentExecutionWorkerNativeBuildArguments([
    "--source-revision", "latest", "--output-directory", outputDirectory,
  ]), /build input is invalid/);
});

test("real Worker bundle loads CommonJS dependencies without starting an imported CLI", async () => {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const outputParent = await mkdtemp(resolve(tmpdir(), "deviludo-agent-worker-native-smoke-"));
  const outputDirectory = resolve(outputParent, "candidate");
  await buildAgentExecutionWorkerNative({ outputDirectory, sourceRevision }, { root, verifySource: async () => undefined });
  const artifact = resolve(outputDirectory, "deviludo-agent-execution-worker-native.mjs");
  const result = spawnSync(process.execPath, [artifact], {
    env: { NODE_ENV: "production" }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 1, JSON.stringify({ execPath: process.execPath, stdout: result.stdout, stderr: result.stderr }));
  assert.match(result.stderr, /"service":"deviludo-agent-execution-worker","event":"FAILED"/);
  assert.doesNotMatch(result.stderr, /Dynamic require|agent-microvm-launcher/);
});

test("Agent execution Worker native finalizer uses its distinct mTLS KMS route and is replay-safe", async () => {
  const fixture = await releaseFixture();
  const claims = await prepareAgentExecutionWorkerNativeClaims(fixture.options);
  const calls = [];
  const signer = new MtlsAgentExecutionWorkerNativeSigner({
    endpoint: "https://agent-worker-kms.internal:8443/", keyId,
    tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    request: async (input) => {
      calls.push(input); const body = JSON.parse(input.body);
      return { statusCode: 200, body: {
        schemaVersion: "deviludo.agent-execution-worker-native-signing-response.v1",
        algorithm: "Ed25519", keyId, claimsDigest: body.claimsDigest,
        signature: sign(null, Buffer.from(body.signingInput, "base64url"), keyPair.privateKey).toString("base64url"),
      } };
    },
  });
  const result = await finalizeAgentExecutionWorkerNative(fixture.options, {
    signer, now: new Date("2026-07-26T01:02:00.000Z"),
  });
  assert.equal(result.replayed, false);
  assert.equal(calls[0].url.href, "https://agent-worker-kms.internal:8443/v1/agent-execution-worker-native/sign-ed25519");
  assert.deepEqual(verifySignedAgentExecutionWorkerNativeRelease(result.manifest, {
    trustPolicy, trustPolicyDigest, platformVersion: claims.platformVersion,
    artifactDigest: claims.artifactDigest, artifactSizeBytes: claims.artifactSizeBytes,
    buildReceiptDigest: claims.buildReceiptDigest, now: new Date("2026-07-26T01:02:00.000Z"),
  }), claims);
  const replay = await finalizeAgentExecutionWorkerNative(fixture.options, {
    signer: { async sign() { throw new Error("KMS must not run on replay"); } },
    now: new Date("2026-07-26T01:03:00.000Z"),
  });
  assert.equal(replay.replayed, true);
  await chmod(fixture.options.artifactPath, 0o700);
  await writeFile(fixture.options.artifactPath, "tampered\n");
  await assert.rejects(finalizeAgentExecutionWorkerNative(fixture.options, { signer,
    now: new Date("2026-07-26T01:03:00.000Z") }), /finalization input is invalid/);
});

test("Agent execution Worker verifies its own exact artifact before any external connection", async () => {
  const fixture = await releaseFixture();
  const claims = await prepareAgentExecutionWorkerNativeClaims(fixture.options);
  const manifest = {
    keyId,
    claims,
    signature: sign(null, Buffer.from(canonicalJson(claims)), keyPair.privateKey).toString("base64url"),
  };
  await writeFile(fixture.options.outputPath, `${canonicalJson(manifest)}\n`);
  const env = {
    NODE_ENV: "production",
    DEVILUDO_PLATFORM_VERSION: claims.platformVersion,
    DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_ARTIFACT_FILE: fixture.options.artifactPath,
    DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_ARTIFACT_DIGEST: claims.artifactDigest,
    DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_BUILD_RECEIPT_FILE: fixture.options.buildReceiptPath,
    DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_BUILD_RECEIPT_DIGEST: claims.buildReceiptDigest,
    DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_RELEASE_FILE: fixture.options.outputPath,
    DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_TRUST_POLICY_FILE: fixture.options.trustPolicyPath,
    DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_TRUST_POLICY_DIGEST: trustPolicyDigest,
  };
  assert.deepEqual(await verifyAgentExecutionWorkerNativeRuntime(env, {
    executedPath: fixture.options.artifactPath, now: new Date("2026-07-26T01:02:00.000Z"),
  }), claims);
  await assert.rejects(verifyAgentExecutionWorkerNativeRuntime({ ...env,
    DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_ARTIFACT_DIGEST: "9".repeat(64),
  }, { executedPath: fixture.options.artifactPath, now: new Date("2026-07-26T01:02:00.000Z") }), /release is invalid/);
  assert.equal(await verifyAgentExecutionWorkerNativeRuntime({ DEVILUDO_LOCAL_TEST_MODE: "1" }, {}), null);
  await assert.rejects(verifyAgentExecutionWorkerNativeRuntime({ NODE_ENV: "production", DEVILUDO_LOCAL_TEST_MODE: "1" }, {}),
    /release is invalid/);
});

test("Agent execution Worker native trust policy is revoked by default and CLI input is exact", async () => {
  assert.deepEqual(validateAgentExecutionWorkerNativeTrustPolicy(trustPolicy, trustPolicyDigest), trustPolicy);
  const template = JSON.parse(await readFile(new URL("../infra/agent-execution-worker-native-trust-policy.example.json", import.meta.url), "utf8"));
  assert.equal(template.keys[0].status, "REVOKED");
  const inspection = inspectAgentExecutionWorkerNativeTrustPolicy(template);
  assert.ok(!JSON.stringify(inspection).includes("publicKeySpkiBase64"));
  assert.deepEqual(parseAgentExecutionWorkerNativeTrustInspectionArguments([
    "--trust-policy", "/private/reviewed/agent-worker-native-trust.json",
  ]), { trustPolicyPath: "/private/reviewed/agent-worker-native-trust.json" });
  const fixture = await releaseFixture();
  const argv = [
    "--artifact", fixture.options.artifactPath, "--build-receipt", fixture.options.buildReceiptPath,
    "--evidence", fixture.options.evidencePath, "--output", fixture.options.outputPath,
    "--published-at", fixture.options.publishedAt, "--release-id", fixture.options.releaseId,
    "--source-revision", fixture.options.sourceRevision, "--trust-policy", fixture.options.trustPolicyPath,
    "--trust-policy-digest", fixture.options.trustPolicyDigest,
  ];
  assert.equal(parseAgentExecutionWorkerNativeFinalizationArguments(argv).releaseId, fixture.options.releaseId);
  assert.throws(() => new MtlsAgentExecutionWorkerNativeSigner({
    endpoint: "http://agent-worker-kms.internal", keyId,
    tls: { key: Buffer.alloc(64), cert: Buffer.alloc(64), ca: Buffer.alloc(64) },
  }), /finalization input is invalid/);
});

async function releaseFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-agent-worker-native-release-"));
  const artifactPath = resolve(root, "deviludo-agent-execution-worker-native.mjs");
  const buildReceiptPath = resolve(root, "agent-execution-worker-native-build-receipt.json");
  const evidencePath = resolve(root, "evidence.json");
  const outputPath = resolve(root, "release.json");
  const trustPolicyPath = resolve(root, "trust-policy.json");
  const artifact = Buffer.from("#!/usr/bin/node\nreleased Agent execution Worker\n");
  const artifactDigest = digest(artifact);
  const buildReceipt = {
    schemaVersion: "deviludo.agent-execution-worker-native-build-receipt.v1", status: "CANDIDATE",
    platformVersion: "0.1.0-beta.1", sourceRevision, nodeTarget: "22.13", packageLockDigest: "1".repeat(64),
    esbuildVersion: "0.28.0", esbuildLibraryDigest: "2".repeat(64),
    entryPoint: "services/agent-execution-broker/src/run-native-worker-bundle.ts",
    artifactFileName: "deviludo-agent-execution-worker-native.mjs", artifactDigest,
    sizeBytes: artifact.byteLength, bundleInputCount: 12, bundleInputDigest: "3".repeat(64),
    completedAt: "2026-07-26T01:00:00.000Z",
  };
  const buildBytes = Buffer.from(`${JSON.stringify(buildReceipt, null, 2)}\n`);
  const buildReceiptDigest = digest(buildBytes);
  await Promise.all([
    writeFile(artifactPath, artifact, { mode: 0o500 }),
    writeFile(buildReceiptPath, buildBytes, { mode: 0o400 }),
    writeFile(evidencePath, JSON.stringify({
      schemaVersion: "deviludo.agent-execution-worker-native-evidence.v1", scanState: "PASS",
      artifactDigest, buildReceiptDigest, sbomDigest: "4".repeat(64), malwareScanDigest: "5".repeat(64),
      vulnerabilityScanDigest: "6".repeat(64), provenanceDigest: "7".repeat(64),
    })),
    writeFile(trustPolicyPath, JSON.stringify(trustPolicy)),
  ]);
  return { options: {
    artifactPath, buildReceiptPath, evidencePath, outputPath,
    publishedAt: "2026-07-26T01:01:00.000Z", releaseId: "11111111-1111-4111-8111-111111111111",
    sourceRevision, trustPolicyPath, trustPolicyDigest,
  } };
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
