import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { canonicalJson, sha256Canonical } from "../services/runner-control/src/canonical.ts";
import {
  steamNativeBridgeTrustPolicyDigest,
  verifySignedSteamNativeBridgeManifest,
} from "../services/steam-client-connector/src/native-bridge-manifest.ts";
import {
  finalizeSteamNativeBridge,
  MtlsSteamNativeBridgeSigner,
  parseSteamNativeBridgeFinalizationArguments,
  prepareSteamNativeBridgeClaims,
} from "../scripts/production/finalize-steam-native-bridge.mjs";
import {
  inspectSteamNativeBridgeTrustPolicy,
  parseSteamNativeBridgeTrustInspectionArguments,
} from "../scripts/production/inspect-steam-native-bridge-trust-policy.mjs";

const keyPair = generateKeyPairSync("ed25519");
const keyId = "steam-native-release-2026-01";
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.steam-native-bridge-trust-policy.v1",
  policyId: "deviludo-steam-native-production",
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
const trustPolicyDigest = steamNativeBridgeTrustPolicyDigest(trustPolicy);

test("Steam bridge finalizer binds platform signing evidence, binary bytes and one KMS envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-native-finalizer-"));
  const binaryPath = resolve(root, "steam-client-bridge");
  const evidencePath = resolve(root, "signing-evidence.json");
  const trustPolicyPath = resolve(root, "trust-policy.json");
  const outputPath = resolve(root, "bridge-manifest.json");
  const binary = Buffer.from("platform-signed-steam-native-bridge\n");
  const binaryDigest = digest(binary);
  const evidence = {
    schemaVersion: "deviludo.steam-native-bridge-signing-evidence.v1",
    platform: "linux",
    binaryDigest,
    sizeBytes: binary.length,
    nativeSignature: {
      scheme: "SIGSTORE_BUNDLE",
      signerIdentity: "https://github.com/deviludo/steam-native-release",
      evidenceDigest: "1".repeat(64),
      transparencyLogDigest: "2".repeat(64),
      notarizationDigest: null,
    },
  };
  await Promise.all([
    writeFile(binaryPath, binary),
    writeFile(evidencePath, JSON.stringify(evidence)),
    writeFile(trustPolicyPath, JSON.stringify(trustPolicy)),
  ]);
  const options = Object.freeze({
    automationPolicyDigest: "3".repeat(64),
    binaryPath,
    bridgeVersion: "1.0.3",
    builtAt: "2026-07-22T00:00:00.000Z",
    connectorVersion: "0.1.0-beta.1",
    evidencePath,
    outputPath,
    platform: "linux",
    revision: 7,
    runnerId: "runner-linux-1",
    trustPolicyDigest,
    trustPolicyPath,
  });
  const claims = await prepareSteamNativeBridgeClaims(options);
  assert.equal(claims.binaryDigest, binaryDigest);
  assert.equal(claims.supplyChainEvidenceDigest, sha256Canonical(evidence));
  const calls = [];
  const signer = new MtlsSteamNativeBridgeSigner({
    endpoint: "https://steam-native-kms.internal:8443",
    keyId,
    tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    request: async (input) => {
      calls.push(input);
      const body = JSON.parse(input.body);
      return { statusCode: 200, body: {
        schemaVersion: "deviludo.steam-native-bridge-signing-response.v1",
        algorithm: "Ed25519",
        keyId,
        claimsDigest: body.claimsDigest,
        signature: sign(null, Buffer.from(body.signingInput, "base64url"), keyPair.privateKey).toString("base64url"),
      } };
    },
  });
  const finalized = await finalizeSteamNativeBridge(options, {
    signer,
    now: new Date("2026-07-22T00:01:00.000Z"),
  });
  assert.equal(finalized.replayed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://steam-native-kms.internal:8443/v1/steam-native-bridges/sign-ed25519");
  assert.equal(calls[0].headers["idempotency-key"], sha256Canonical(claims));
  assert.ok(!calls[0].body.includes("privateKey"));
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), finalized.manifest);
  assert.deepEqual(verifySignedSteamNativeBridgeManifest(finalized.manifest, {
    trustPolicy,
    trustPolicyDigest,
    runnerId: claims.runnerId,
    platform: claims.platform,
    connectorVersion: claims.connectorVersion,
    now: new Date("2026-07-22T00:01:00.000Z"),
  }), claims);

  const replay = await finalizeSteamNativeBridge(options, {
    signer: { async sign() { throw new Error("KMS must not be called for a valid replay"); } },
    now: new Date("2026-07-22T00:02:00.000Z"),
  });
  assert.equal(replay.replayed, true);
  await writeFile(binaryPath, "tampered\n");
  await assert.rejects(finalizeSteamNativeBridge(options, {
    signer,
    now: new Date("2026-07-22T00:02:00.000Z"),
  }), /finalization input is invalid/);
});

test("Steam bridge finalization CLI is exact and rejects floating versions or relative trust inputs", () => {
  const argv = [
    "--binary", "/private/release/steam-client-bridge",
    "--evidence", "/private/release/evidence.json",
    "--output", "/private/release/manifest.json",
    "--runner-id", "runner-linux-1",
    "--platform", "linux",
    "--connector-version", "0.1.0-beta.1",
    "--bridge-version", "1.0.3",
    "--revision", "7",
    "--built-at", "2026-07-22T00:00:00.000Z",
    "--automation-policy-digest", "3".repeat(64),
    "--trust-policy", "/private/release/trust-policy.json",
    "--trust-policy-digest", trustPolicyDigest,
  ];
  assert.equal(parseSteamNativeBridgeFinalizationArguments(argv).revision, 7);
  assert.throws(() => parseSteamNativeBridgeFinalizationArguments(argv.map((value) =>
    value === "1.0.3" ? "latest" : value)), /input is invalid/);
  assert.throws(() => parseSteamNativeBridgeFinalizationArguments(argv.map((value) =>
    value === "/private/release/trust-policy.json" ? "relative.json" : value)), /input is invalid/);
  assert.throws(() => new MtlsSteamNativeBridgeSigner({
    endpoint: "http://steam-native-kms.internal",
    keyId,
    tls: { key: Buffer.alloc(64), cert: Buffer.alloc(64), ca: Buffer.alloc(64) },
  }), /input is invalid/);
  assert.ok(canonicalJson(trustPolicy).includes(keyId));
  const inspection = inspectSteamNativeBridgeTrustPolicy(trustPolicy);
  assert.equal(inspection.policyDigest, trustPolicyDigest);
  assert.equal(inspection.keys[0].status, "ACTIVE");
  assert.ok(!JSON.stringify(inspection).includes("publicKeySpkiBase64"));
  assert.deepEqual(parseSteamNativeBridgeTrustInspectionArguments([
    "--trust-policy", "/private/release/trust-policy.json",
  ]), { trustPolicyPath: "/private/release/trust-policy.json" });
  assert.throws(() => parseSteamNativeBridgeTrustInspectionArguments([
    "--trust-policy", "relative.json",
  ]), /input is invalid/);
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
