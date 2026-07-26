import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildSteamDepotFinalizerNative,
  parseSteamDepotFinalizerNativeBuildArguments,
  validateSteamDepotFinalizerNativeBuildReceipt,
} from "../scripts/production/build-steam-depot-finalizer-native.mjs";
import {
  finalizeSteamDepotFinalizerNative,
  MtlsSteamDepotFinalizerNativeReleaseSigner,
  prepareSteamDepotFinalizerNativeClaims,
} from "../scripts/production/finalize-steam-depot-finalizer-native.mjs";
import { inspectSteamDepotFinalizerNativeTrustPolicy } from
  "../scripts/production/inspect-steam-depot-finalizer-native-trust-policy.mjs";
import {
  steamDepotFinalizerNativeTrustPolicyDigest,
  validateSteamDepotFinalizerNativeTrustPolicy,
  verifySignedSteamDepotFinalizerNativeRelease,
  verifySteamDepotFinalizerNativeRuntime,
} from "../services/steam-depot-finalizer/src/native-controller-release.ts";
import { canonicalJson, sha256Canonical } from "../services/runner-control/src/canonical.ts";

const sourceRevision = "a".repeat(40);
const keyPair = generateKeyPairSync("ed25519");
const keyId = "steam-depot-finalizer-native-release-key-2026-01";
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.steam-depot-finalizer-native-trust-policy.v1",
  policyId: "steam-depot-finalizer-native-production",
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
const trustPolicyDigest = steamDepotFinalizerNativeTrustPolicyDigest(trustPolicy);

test("native finalizer builder emits one source-bound SEA candidate for the current host", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-finalizer-native-build-"));
  const outputParent = resolve(root, "out");
  const outputDirectory = resolve(outputParent, "candidate");
  const nodeBinary = resolve(root, "node");
  const packageName = process.platform === "win32" ? `@esbuild/win32-${process.arch}`
    : `@esbuild/${process.platform}-${process.arch}`;
  const platformBinary = process.platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"];
  await Promise.all([
    mkdir(outputParent),
    mkdir(resolve(root, "node_modules/esbuild/lib"), { recursive: true }),
    mkdir(resolve(root, "node_modules/postject/dist"), { recursive: true }),
    mkdir(resolve(root, "node_modules", packageName, ...platformBinary.slice(0, -1)), { recursive: true }),
  ]);
  const packageLock = {
    packages: {
      "node_modules/esbuild": {
        version: "0.28.0",
        resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.0.tgz",
        integrity: "sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==",
      },
      "node_modules/postject": {
        version: "1.0.0-alpha.6",
        resolved: "https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz",
        integrity: "sha512-b9Eb8h2eVqNE8edvKdwqkrY6O7kAwmI8kcnBv1NScolYJbo59XUF0noFq+lxbC1yN20bmC0WBEbDC5H/7ASb0A==",
      },
      [`node_modules/${packageName}`]: { version: "0.28.0", integrity: "sha512-YWJj" },
    },
  };
  await Promise.all([
    writeFile(resolve(root, "package.json"), JSON.stringify({
      version: "0.1.0-beta.1", devDependencies: { esbuild: "0.28.0", postject: "1.0.0-alpha.6" },
    })),
    writeFile(resolve(root, "package-lock.json"), JSON.stringify(packageLock)),
    writeFile(nodeBinary, "locked-node-runtime"),
    writeFile(resolve(root, "node_modules/esbuild/lib/main.js"), "locked-esbuild-library"),
    writeFile(resolve(root, "node_modules/postject/dist/cli.js"), "locked-postject-cli"),
    writeFile(resolve(root, "node_modules", packageName, ...platformBinary), "locked-esbuild-binary"),
  ]);
  const nodeBinaryDigest = digest(await readFile(nodeBinary));
  const execute = async ({ command, args }) => {
    if (command === "git" && args.includes("rev-parse")) return `${sourceRevision}\n`;
    if (command === "git") return "";
    if (command === nodeBinary && args[0] === "-p") return JSON.stringify({
      version: process.version, platform: process.platform, arch: process.arch, execPath: nodeBinary,
    });
    if (command === nodeBinary && args[0] === "--experimental-sea-config") {
      const config = JSON.parse(await readFile(args[1], "utf8"));
      await writeFile(config.output, "sea-blob");
      return "";
    }
    if (command === nodeBinary || command === "codesign") return "";
    if (command.endsWith("deviludo-steam-depot-finalizer-native")
      || command.endsWith("deviludo-steam-depot-finalizer-native.exe")) {
      return JSON.stringify({
        schemaVersion: "deviludo.native-component-identity.v1",
        component: "steam-depot-finalizer-controller",
        platformVersion: "0.1.0-beta.1",
        sourceRevision,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
      });
    }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await buildSteamDepotFinalizerNative({
    nodeBinary, nodeBinaryDigest, outputDirectory, sourceRevision,
  }, {
    root,
    execute,
    bundle: async ({ outfile }) => { await writeFile(outfile, "bundled-controller"); return { inputCount: 12 }; },
    now: () => new Date("2026-07-26T00:00:00.000Z"),
    uuid: () => "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(result.platform, process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");
  assert.equal(result.bundleInputCount, 12);
  validateSteamDepotFinalizerNativeBuildReceipt(JSON.parse(await readFile(
    resolve(outputDirectory, "steam-depot-finalizer-native-build-receipt.json"), "utf8",
  )));
  assert.deepEqual(parseSteamDepotFinalizerNativeBuildArguments([
    "--node-binary", nodeBinary,
    "--node-binary-digest", nodeBinaryDigest,
    "--output-directory", resolve(root, "next"),
    "--source-revision", sourceRevision,
  ]), { nodeBinary, nodeBinaryDigest, outputDirectory: resolve(root, "next"), sourceRevision });
});

test("native finalizer runtime requires an independent release and exact embedded identity", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-finalizer-native-runtime-"));
  const artifactPath = resolve(root, "deviludo-steam-depot-finalizer-native");
  const buildReceiptPath = resolve(root, "build.json");
  const releasePath = resolve(root, "release.json");
  const trustPolicyPath = resolve(root, "trust.json");
  const artifact = Buffer.from("native-controller-artifact");
  const buildReceipt = Buffer.from(canonicalJson({ schemaVersion: "build.v1", status: "CANDIDATE" }));
  const identity = Object.freeze({
    schemaVersion: "deviludo.native-component-identity.v1",
    component: "steam-depot-finalizer-controller",
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    nodeVersion: "v22.13.1",
    platform: "darwin",
    architecture: "arm64",
  });
  const claims = Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalizer-native-release-claims.v1",
    releaseId: "00000000-0000-4000-8000-000000000001",
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    platform: "macos",
    architecture: "arm64",
    nodeVersion: "v22.13.1",
    artifactDigest: digest(artifact),
    artifactSizeBytes: artifact.byteLength,
    buildReceiptDigest: digest(buildReceipt),
    identityDigest: sha256Canonical(identity),
    nativeSignature: Object.freeze({
      scheme: "developer-id-notarized",
      signerIdentity: "developer-id-application-deviludo",
      evidenceDigest: "b".repeat(64),
      transparencyLogDigest: null,
      notarizationDigest: "c".repeat(64),
    }),
    publishedAt: "2026-07-26T00:00:00.000Z",
  });
  const release = Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalizer-native-release.v1",
    claims,
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId,
      value: sign(null, Buffer.from(canonicalJson(claims)), keyPair.privateKey).toString("base64url"),
    }),
  });
  await Promise.all([
    writeFile(artifactPath, artifact, { mode: 0o500 }),
    writeFile(buildReceiptPath, buildReceipt, { mode: 0o400 }),
    writeFile(releasePath, canonicalJson(release), { mode: 0o400 }),
    writeFile(trustPolicyPath, canonicalJson(trustPolicy), { mode: 0o400 }),
  ]);
  const env = {
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE: artifactPath,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE_DIGEST: digest(artifact),
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_BUILD_RECEIPT_FILE: buildReceiptPath,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_BUILD_RECEIPT_DIGEST: digest(buildReceipt),
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_RELEASE_FILE: releasePath,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_TRUST_POLICY_FILE: trustPolicyPath,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_TRUST_POLICY_DIGEST: trustPolicyDigest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_PLATFORM: "macos",
    DEVILUDO_STEAM_DEPOT_FINALIZER_VERSION: "0.1.0-beta.1",
  };
  const verified = await verifySteamDepotFinalizerNativeRuntime(env, {
    inspectIdentity: async () => identity,
    now: new Date("2026-07-26T00:01:00.000Z"),
  });
  assert.equal(verified.claims.releaseId, claims.releaseId);
  await assert.rejects(verifySteamDepotFinalizerNativeRuntime({
    ...env,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE_DIGEST: "d".repeat(64),
  }, { inspectIdentity: async () => identity, now: new Date("2026-07-26T00:01:00.000Z") }), /release is invalid/);
  await assert.rejects(verifySteamDepotFinalizerNativeRuntime(env, {
    inspectIdentity: async () => ({ ...identity, sourceRevision: "e".repeat(40) }),
    now: new Date("2026-07-26T00:01:00.000Z"),
  }), /release is invalid/);
});

test("native finalization binds platform signing evidence and uses its dedicated KMS route", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-finalizer-native-finalize-"));
  const artifactPath = resolve(root, "deviludo-steam-depot-finalizer-native");
  const buildReceiptPath = resolve(root, "build.json");
  const evidencePath = resolve(root, "evidence.json");
  const outputPath = resolve(root, "release.json");
  const trustPolicyPath = resolve(root, "trust.json");
  const artifact = Buffer.from("signed-native-controller");
  const build = {
    schemaVersion: "deviludo.steam-depot-finalizer-native-build-receipt.v1",
    status: "CANDIDATE",
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    platform: "linux",
    architecture: "x86_64",
    nodeVersion: "v22.13.1",
    nodeBinaryDigest: "1".repeat(64),
    packageLockDigest: "2".repeat(64),
    esbuildVersion: "0.28.0",
    esbuildLibraryDigest: "3".repeat(64),
    esbuildBinaryDigest: "4".repeat(64),
    postjectVersion: "1.0.0-alpha.6",
    postjectCliDigest: "5".repeat(64),
    signatureState: "UNSIGNED",
    artifactFileName: "deviludo-steam-depot-finalizer-native",
    artifactDigest: "6".repeat(64),
    sizeBytes: 123,
    bundleDigest: "7".repeat(64),
    bundleInputCount: 12,
    identityDigest: "8".repeat(64),
    completedAt: "2026-07-25T23:00:00.000Z",
  };
  const buildBytes = Buffer.from(canonicalJson(build));
  const evidence = {
    schemaVersion: "deviludo.steam-depot-finalizer-native-evidence.v1",
    scanState: "PASS",
    candidateDigest: build.artifactDigest,
    artifactDigest: digest(artifact),
    artifactSizeBytes: artifact.byteLength,
    buildReceiptDigest: digest(buildBytes),
    sbomDigest: "9".repeat(64),
    malwareScanDigest: "a".repeat(64),
    vulnerabilityScanDigest: "b".repeat(64),
    provenanceDigest: "c".repeat(64),
    nativeSignature: {
      scheme: "sigstore-cosign",
      signerIdentity: "kms-linux-release-key",
      evidenceDigest: "d".repeat(64),
      transparencyLogDigest: "e".repeat(64),
      notarizationDigest: null,
    },
  };
  await Promise.all([
    writeFile(artifactPath, artifact, { mode: 0o500 }),
    writeFile(buildReceiptPath, buildBytes, { mode: 0o400 }),
    writeFile(evidencePath, canonicalJson(evidence), { mode: 0o400 }),
    writeFile(trustPolicyPath, canonicalJson(trustPolicy), { mode: 0o400 }),
  ]);
  const options = {
    artifactPath,
    buildReceiptPath,
    evidencePath,
    outputPath,
    publishedAt: "2026-07-26T00:00:00.000Z",
    releaseId: "00000000-0000-4000-8000-000000000002",
    trustPolicyPath,
    trustPolicyDigest,
  };
  const claims = await prepareSteamDepotFinalizerNativeClaims(options);
  assert.equal(claims.artifactDigest, evidence.artifactDigest);
  const signer = new MtlsSteamDepotFinalizerNativeReleaseSigner({
    endpoint: "https://native-release-kms.internal:8443/",
    keyId,
    tls: { key: Buffer.alloc(32, 1), cert: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    request: async (request) => {
      assert.equal(request.url.href,
        "https://native-release-kms.internal:8443/v1/steam-depot-finalizer-native-releases/sign-ed25519");
      const body = JSON.parse(request.body);
      assert.equal(body.claimsDigest, sha256Canonical(claims));
      return {
        statusCode: 200,
        body: {
          schemaVersion: "deviludo.steam-depot-finalizer-native-signing-response.v1",
          algorithm: "Ed25519",
          keyId,
          claimsDigest: body.claimsDigest,
          signature: sign(null, Buffer.from(canonicalJson(claims)), keyPair.privateKey).toString("base64url"),
        },
      };
    },
  });
  const finalized = await finalizeSteamDepotFinalizerNative(options, {
    signer,
    now: new Date("2026-07-26T00:01:00.000Z"),
  });
  assert.equal(finalized.replayed, false);
  const replay = await finalizeSteamDepotFinalizerNative(options, {
    signer,
    now: new Date("2026-07-26T00:02:00.000Z"),
  });
  assert.equal(replay.replayed, true);
});

test("native release policy and platform evidence fail closed on drift", () => {
  assert.equal(validateSteamDepotFinalizerNativeTrustPolicy(trustPolicy, trustPolicyDigest).keys[0].keyId, keyId);
  const claims = {
    schemaVersion: "deviludo.steam-depot-finalizer-native-release-claims.v1",
    releaseId: "00000000-0000-4000-8000-000000000001",
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    platform: "linux",
    architecture: "x86_64",
    nodeVersion: "v22.13.1",
    artifactDigest: "1".repeat(64),
    artifactSizeBytes: 100,
    buildReceiptDigest: "2".repeat(64),
    identityDigest: "3".repeat(64),
    nativeSignature: {
      scheme: "sigstore-cosign",
      signerIdentity: "kms-linux-release-key",
      evidenceDigest: "4".repeat(64),
      transparencyLogDigest: "5".repeat(64),
      notarizationDigest: null,
    },
    publishedAt: "2026-07-26T00:00:00.000Z",
  };
  const release = {
    schemaVersion: "deviludo.steam-depot-finalizer-native-release.v1",
    claims,
    signature: {
      algorithm: "Ed25519",
      keyId,
      value: sign(null, Buffer.from(canonicalJson(claims)), keyPair.privateKey).toString("base64url"),
    },
  };
  const options = {
    trustPolicy,
    trustPolicyDigest,
    platformVersion: claims.platformVersion,
    platform: claims.platform,
    artifactDigest: claims.artifactDigest,
    artifactSizeBytes: claims.artifactSizeBytes,
    buildReceiptDigest: claims.buildReceiptDigest,
    now: new Date("2026-07-26T00:01:00.000Z"),
  };
  assert.equal(verifySignedSteamDepotFinalizerNativeRelease(release, options).claims.platform, "linux");
  const drift = structuredClone(release);
  drift.claims.nativeSignature.transparencyLogDigest = null;
  assert.throws(() => verifySignedSteamDepotFinalizerNativeRelease(drift, options), /release is invalid/);
});

test("checked-in native trust is revoked and inspection redacts public key material", async () => {
  const path = resolve("infra/steam-depot-finalizer-native-trust-policy.example.json");
  const inspection = await inspectSteamDepotFinalizerNativeTrustPolicy(path);
  assert.equal(inspection.keys[0].status, "REVOKED");
  assert.equal(inspection.trustPolicyDigest.length, 64);
  assert.equal(JSON.stringify(inspection).includes("publicKeySpkiBase64"), false);
});

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
