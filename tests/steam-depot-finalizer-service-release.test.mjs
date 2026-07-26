import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSteamDepotFinalizerService,
  parseSteamDepotFinalizerServiceBuildArguments,
  validateSteamDepotFinalizerServiceBuildReceipt,
} from "../scripts/build-steam-depot-finalizer-service.mjs";
import {
  finalizeSteamDepotFinalizerService,
  MtlsSteamDepotFinalizerServiceSigner,
  parseSteamDepotFinalizerServiceFinalizationArguments,
  prepareSteamDepotFinalizerServiceClaims,
} from "../scripts/production/finalize-steam-depot-finalizer-service.mjs";
import {
  inspectSteamDepotFinalizerServiceTrustPolicy,
  parseSteamDepotFinalizerServiceTrustArguments,
} from "../scripts/production/inspect-steam-depot-finalizer-service-trust-policy.mjs";
import {
  steamDepotFinalizerServiceTrustPolicyDigest,
  validateSteamDepotFinalizerServiceTrustPolicy,
  verifySignedSteamDepotFinalizerServiceRelease,
  verifySteamDepotFinalizerServiceRuntime,
} from "../services/steam-depot-finalizer/src/native-service-release.ts";
import { canonicalJson } from "../services/runner-control/src/canonical.ts";

const sourceRevision = "a".repeat(40);
const keyPair = generateKeyPairSync("ed25519");
const keyId = "steam-depot-finalizer-service-release-key-2026-01";
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.steam-depot-finalizer-service-trust-policy.v1",
  policyId: "steam-depot-finalizer-service-production",
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
const trustPolicyDigest = steamDepotFinalizerServiceTrustPolicyDigest(trustPolicy);

test("Steam depot finalizer service builder emits an immutable source-bound bundle", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-depot-service-build-"));
  const outputParent = resolve(root, "out"); const outputDirectory = resolve(outputParent, "candidate");
  await Promise.all([
    mkdir(outputParent),
    mkdir(resolve(root, "node_modules/esbuild/lib"), { recursive: true }),
    mkdir(resolve(root, "services/steam-depot-finalizer/src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(root, "package.json"), JSON.stringify({ version: "0.1.0-beta.1", devDependencies: { esbuild: "0.28.0" } })),
    writeFile(resolve(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/esbuild": {
      version: "0.28.0", resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.0.tgz",
      integrity: "sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==",
    } } })),
    writeFile(resolve(root, "node_modules/esbuild/lib/main.js"), "locked esbuild library"),
    writeFile(resolve(root, "services/steam-depot-finalizer/src/run-native-bundle.ts"), "export {};"),
  ]);
  const receipt = await buildSteamDepotFinalizerService({ outputDirectory, sourceRevision }, {
    root, verifySource: async () => undefined, now: () => new Date("2026-07-26T01:00:00.000Z"),
    uuid: () => "11111111-1111-4111-8111-111111111111",
    bundle: async ({ outfile }) => {
      await writeFile(outfile, "#!/usr/bin/node\nproduction finalizer service bundle\n");
      return { metafile: { inputs: { "b.ts": {}, "a.ts": {} } } };
    },
  });
  assert.equal(receipt.schemaVersion, "deviludo.steam-depot-finalizer-service-build-receipt.v1");
  assert.equal(receipt.entryPoint, "services/steam-depot-finalizer/src/run-native-bundle.ts");
  assert.equal(receipt.bundleInputCount, 2);
  assert.deepEqual(validateSteamDepotFinalizerServiceBuildReceipt(JSON.parse(await readFile(resolve(
    outputDirectory, "steam-depot-finalizer-service-build-receipt.json",
  ), "utf8"))), Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "outputDirectory")));
  assert.deepEqual(parseSteamDepotFinalizerServiceBuildArguments([
    "--source-revision", sourceRevision, "--output-directory", outputDirectory,
  ]), { outputDirectory, sourceRevision });
  assert.throws(() => parseSteamDepotFinalizerServiceBuildArguments([
    "--source-revision", "latest", "--output-directory", outputDirectory,
  ]), /build input is invalid/);
});

test("real Steam depot finalizer service bundle fails once before external initialization", async () => {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const outputParent = await mkdtemp(resolve(tmpdir(), "deviludo-depot-service-smoke-"));
  const outputDirectory = resolve(outputParent, "candidate");
  await buildSteamDepotFinalizerService({ outputDirectory, sourceRevision }, { root, verifySource: async () => undefined });
  const artifact = resolve(outputDirectory, "deviludo-steam-depot-finalizer-service.mjs");
  const result = spawnSync(process.execPath, [artifact], { env: { NODE_ENV: "production" }, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.equal((result.stderr.match(/"service":"deviludo-steam-depot-finalizer","event":"FAILED"/g) ?? []).length, 1);
  assert.doesNotMatch(result.stderr, /Dynamic require/);
});

test("Steam depot finalizer service finalization uses a distinct KMS route and exact replay", async () => {
  const fixture = await releaseFixture();
  const claims = await prepareSteamDepotFinalizerServiceClaims(fixture.options);
  const calls = [];
  const signer = new MtlsSteamDepotFinalizerServiceSigner({
    endpoint: "https://depot-release-kms.internal:8443/", keyId,
    tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    request: async (input) => {
      calls.push(input); const body = JSON.parse(input.body);
      return { statusCode: 200, body: {
        schemaVersion: "deviludo.steam-depot-finalizer-service-signing-response.v1",
        algorithm: "Ed25519", keyId, claimsDigest: body.claimsDigest,
        signature: sign(null, Buffer.from(body.signingInput, "base64url"), keyPair.privateKey).toString("base64url"),
      } };
    },
  });
  const result = await finalizeSteamDepotFinalizerService(fixture.options, {
    signer, now: new Date("2026-07-26T01:02:00.000Z"),
  });
  assert.equal(result.replayed, false);
  assert.equal(calls[0].url.href,
    "https://depot-release-kms.internal:8443/v1/steam-depot-finalizer-service-releases/sign-ed25519");
  assert.deepEqual(verifySignedSteamDepotFinalizerServiceRelease(result.manifest, {
    trustPolicy, trustPolicyDigest, platformVersion: claims.platformVersion,
    artifactDigest: claims.artifactDigest, artifactSizeBytes: claims.artifactSizeBytes,
    buildReceiptDigest: claims.buildReceiptDigest, now: new Date("2026-07-26T01:02:00.000Z"),
  }), claims);
  const replay = await finalizeSteamDepotFinalizerService(fixture.options, {
    signer: { async sign() { throw new Error("KMS must not run on replay"); } },
    now: new Date("2026-07-26T01:03:00.000Z"),
  });
  assert.equal(replay.replayed, true);
  await chmod(fixture.options.artifactPath, 0o700);
  await writeFile(fixture.options.artifactPath, "tampered\n");
  await assert.rejects(finalizeSteamDepotFinalizerService(fixture.options, { signer,
    now: new Date("2026-07-26T01:03:00.000Z") }), /finalization input is invalid/);
});

test("Steam depot finalizer verifies its exact service before any external connection", async () => {
  const fixture = await releaseFixture();
  const claims = await prepareSteamDepotFinalizerServiceClaims(fixture.options);
  const manifest = {
    keyId, claims,
    signature: sign(null, Buffer.from(canonicalJson(claims)), keyPair.privateKey).toString("base64url"),
  };
  await writeFile(fixture.options.outputPath, `${canonicalJson(manifest)}\n`, { mode: 0o400 });
  const env = {
    NODE_ENV: "production",
    DEVILUDO_STEAM_DEPOT_FINALIZER_VERSION: claims.platformVersion,
    DEVILUDO_STEAM_DEPOT_FINALIZER_BINARY_DIGEST: claims.artifactDigest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_ARTIFACT_FILE: fixture.options.artifactPath,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_BUILD_RECEIPT_FILE: fixture.options.buildReceiptPath,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_BUILD_RECEIPT_DIGEST: claims.buildReceiptDigest,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_RELEASE_FILE: fixture.options.outputPath,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_TRUST_POLICY_FILE: fixture.options.trustPolicyPath,
    DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_TRUST_POLICY_DIGEST: trustPolicyDigest,
  };
  assert.deepEqual(await verifySteamDepotFinalizerServiceRuntime(env, {
    executedPath: fixture.options.artifactPath, now: new Date("2026-07-26T01:02:00.000Z"),
  }), claims);
  await assert.rejects(verifySteamDepotFinalizerServiceRuntime({ ...env,
    DEVILUDO_STEAM_DEPOT_FINALIZER_BINARY_DIGEST: "9".repeat(64),
  }, { executedPath: fixture.options.artifactPath, now: new Date("2026-07-26T01:02:00.000Z") }), /release is invalid/);
  assert.equal(await verifySteamDepotFinalizerServiceRuntime({ DEVILUDO_LOCAL_TEST_MODE: "1" }), null);
  await assert.rejects(verifySteamDepotFinalizerServiceRuntime({ NODE_ENV: "production", DEVILUDO_LOCAL_TEST_MODE: "1" }),
    /release is invalid/);
});

test("Steam depot finalizer service trust is revoked by default and public-key redacted", async () => {
  assert.deepEqual(validateSteamDepotFinalizerServiceTrustPolicy(trustPolicy, trustPolicyDigest), trustPolicy);
  const template = JSON.parse(await readFile(new URL(
    "../infra/steam-depot-finalizer-service-trust-policy.example.json", import.meta.url,
  ), "utf8"));
  assert.equal(template.keys[0].status, "REVOKED");
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-depot-trust-"));
  const path = resolve(root, "trust.json"); await writeFile(path, JSON.stringify(template), { mode: 0o400 });
  const inspection = await inspectSteamDepotFinalizerServiceTrustPolicy(path);
  assert.ok(!JSON.stringify(inspection).includes("publicKeySpkiBase64"));
  assert.deepEqual(parseSteamDepotFinalizerServiceTrustArguments(["--trust-policy", path]), { trustPolicyPath: path });
  const fixture = await releaseFixture();
  assert.equal(parseSteamDepotFinalizerServiceFinalizationArguments([
    "--artifact", fixture.options.artifactPath, "--build-receipt", fixture.options.buildReceiptPath,
    "--evidence", fixture.options.evidencePath, "--output", fixture.options.outputPath,
    "--published-at", fixture.options.publishedAt, "--release-id", fixture.options.releaseId,
    "--source-revision", fixture.options.sourceRevision, "--trust-policy", fixture.options.trustPolicyPath,
    "--trust-policy-digest", fixture.options.trustPolicyDigest,
  ]).releaseId, fixture.options.releaseId);
  assert.throws(() => new MtlsSteamDepotFinalizerServiceSigner({
    endpoint: "http://depot-release-kms.internal", keyId,
    tls: { key: Buffer.alloc(64), cert: Buffer.alloc(64), ca: Buffer.alloc(64) },
  }), /finalization input is invalid/);
});

async function releaseFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-depot-service-release-"));
  const artifactPath = resolve(root, "deviludo-steam-depot-finalizer-service.mjs");
  const buildReceiptPath = resolve(root, "steam-depot-finalizer-service-build-receipt.json");
  const evidencePath = resolve(root, "evidence.json");
  const outputPath = resolve(root, "release.json");
  const trustPolicyPath = resolve(root, "trust-policy.json");
  const artifact = Buffer.from("#!/usr/bin/node\nreleased Steam depot finalizer service\n");
  const artifactDigest = digest(artifact);
  const buildReceipt = {
    schemaVersion: "deviludo.steam-depot-finalizer-service-build-receipt.v1", status: "CANDIDATE",
    platformVersion: "0.1.0-beta.1", sourceRevision, nodeTarget: "22.13", packageLockDigest: "1".repeat(64),
    esbuildVersion: "0.28.0", esbuildLibraryDigest: "2".repeat(64),
    entryPoint: "services/steam-depot-finalizer/src/run-native-bundle.ts",
    artifactFileName: "deviludo-steam-depot-finalizer-service.mjs", artifactDigest,
    sizeBytes: artifact.byteLength, bundleInputCount: 12, bundleInputDigest: "3".repeat(64),
    completedAt: "2026-07-26T01:00:00.000Z",
  };
  const buildBytes = Buffer.from(`${JSON.stringify(buildReceipt, null, 2)}\n`);
  const buildReceiptDigest = digest(buildBytes);
  await Promise.all([
    writeFile(artifactPath, artifact, { mode: 0o500 }),
    writeFile(buildReceiptPath, buildBytes, { mode: 0o400 }),
    writeFile(evidencePath, JSON.stringify({
      schemaVersion: "deviludo.steam-depot-finalizer-service-evidence.v1", scanState: "PASS",
      artifactDigest, buildReceiptDigest, sbomDigest: "4".repeat(64), malwareScanDigest: "5".repeat(64),
      vulnerabilityScanDigest: "6".repeat(64), provenanceDigest: "7".repeat(64),
    }), { mode: 0o400 }),
    writeFile(trustPolicyPath, JSON.stringify(trustPolicy), { mode: 0o400 }),
  ]);
  return { options: {
    artifactPath, buildReceiptPath, evidencePath, outputPath,
    publishedAt: "2026-07-26T01:01:00.000Z", releaseId: "11111111-1111-4111-8111-111111111111",
    sourceRevision, trustPolicyPath, trustPolicyDigest,
  } };
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
