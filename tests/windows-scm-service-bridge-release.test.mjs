import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { canonicalJson, sha256Canonical } from "../services/runner-control/src/canonical.ts";
import {
  verifySignedWindowsScmServiceBridgeManifest,
  windowsScmServiceBridgeTrustPolicyDigest,
} from "../services/runner-control/src/windows-scm-service-bridge.ts";
import {
  finalizeWindowsScmServiceBridge,
  MtlsWindowsScmServiceBridgeSigner,
  parseWindowsScmServiceBridgeFinalizationArguments,
  prepareWindowsScmServiceBridgeClaims,
} from "../scripts/production/finalize-windows-scm-service-bridge.mjs";
import {
  inspectWindowsScmServiceBridgeTrustPolicy,
  parseWindowsScmServiceBridgeTrustInspectionArguments,
} from "../scripts/production/inspect-windows-scm-service-bridge-trust-policy.mjs";

const keyPair = generateKeyPairSync("ed25519");
const keyId = "windows-scm-bridge-release-2026-01";
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.windows-scm-service-bridge-trust-policy.v1",
  policyId: "deviludo-windows-scm-bridge-production",
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
const trustPolicyDigest = windowsScmServiceBridgeTrustPolicyDigest(trustPolicy);

test("Windows SCM bridge finalizer binds Authenticode and scan evidence to one KMS envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-windows-scm-bridge-"));
  try {
    const binaryPath = resolve(root, "deviludo-windows-scm-service-bridge.exe");
    const evidencePath = resolve(root, "signing-evidence.json");
    const trustPolicyPath = resolve(root, "trust-policy.json");
    const outputPath = resolve(root, "bridge-manifest.json");
    const binary = Buffer.from("authenticode-signed-windows-scm-bridge\n");
    const evidence = {
      schemaVersion: "deviludo.windows-scm-service-bridge-signing-evidence.v1",
      platform: "windows",
      architecture: "x86_64",
      binaryDigest: digest(binary),
      sizeBytes: binary.length,
      compiler: { name: "msvc", version: "19.44.35207", binaryDigest: "1".repeat(64) },
      sbomDigest: "2".repeat(64),
      malwareScanDigest: "3".repeat(64),
      vulnerabilityScanDigest: "4".repeat(64),
      nativeSignature: {
        scheme: "AUTHENTICODE",
        signerIdentity: "CN=DeviLudo Windows Release",
        evidenceDigest: "5".repeat(64),
      },
    };
    await Promise.all([
      writeFile(binaryPath, binary),
      writeFile(evidencePath, JSON.stringify(evidence)),
      writeFile(trustPolicyPath, JSON.stringify(trustPolicy)),
    ]);
    const options = Object.freeze({
      architecture: "x86_64",
      binaryPath,
      bridgeVersion: "1.0.0",
      builtAt: "2026-07-22T05:00:00.000Z",
      evidencePath,
      outputPath,
      revision: 3,
      sourceDigest: "6".repeat(64),
      trustPolicyDigest,
      trustPolicyPath,
    });
    const claims = await prepareWindowsScmServiceBridgeClaims(options);
    assert.equal(claims.binaryDigest, digest(binary));
    assert.equal(claims.supplyChainEvidenceDigest, sha256Canonical(evidence));
    const calls = [];
    const signer = new MtlsWindowsScmServiceBridgeSigner({
      endpoint: "https://windows-scm-bridge-kms.internal:8443",
      keyId,
      tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
      request: async (input) => {
        calls.push(input);
        const body = JSON.parse(input.body);
        return { statusCode: 200, body: {
          schemaVersion: "deviludo.windows-scm-service-bridge-signing-response.v1",
          algorithm: "Ed25519",
          keyId,
          claimsDigest: body.claimsDigest,
          signature: sign(null, Buffer.from(body.signingInput, "base64url"), keyPair.privateKey).toString("base64url"),
        } };
      },
    });
    const finalized = await finalizeWindowsScmServiceBridge(options, {
      signer,
      now: new Date("2026-07-22T05:01:00.000Z"),
    });
    assert.equal(finalized.replayed, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.href,
      "https://windows-scm-bridge-kms.internal:8443/v1/windows-scm-service-bridges/sign-ed25519");
    assert.equal(calls[0].headers["idempotency-key"], sha256Canonical(claims));
    assert.ok(!calls[0].body.includes("privateKey"));
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), finalized.manifest);
    assert.deepEqual(verifySignedWindowsScmServiceBridgeManifest(finalized.manifest, {
      trustPolicy,
      trustPolicyDigest,
      architecture: "x86_64",
      now: new Date("2026-07-22T05:01:00.000Z"),
    }), claims);

    const replay = await finalizeWindowsScmServiceBridge(options, {
      signer: { async sign() { throw new Error("KMS must not be called for an exact replay"); } },
      now: new Date("2026-07-22T05:02:00.000Z"),
    });
    assert.equal(replay.replayed, true);
    await writeFile(binaryPath, "tampered\n");
    await assert.rejects(finalizeWindowsScmServiceBridge(options, {
      signer,
      now: new Date("2026-07-22T05:02:00.000Z"),
    }), /finalization input is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows SCM bridge release inputs are exact, fixed-version and public-key-redacted", () => {
  const argv = [
    "--architecture", "x86_64",
    "--binary", "/private/release/deviludo-windows-scm-service-bridge.exe",
    "--bridge-version", "1.0.0",
    "--built-at", "2026-07-22T05:00:00.000Z",
    "--evidence", "/private/release/evidence.json",
    "--output", "/private/release/manifest.json",
    "--revision", "3",
    "--source-digest", "6".repeat(64),
    "--trust-policy", "/private/release/trust-policy.json",
    "--trust-policy-digest", trustPolicyDigest,
  ];
  assert.equal(parseWindowsScmServiceBridgeFinalizationArguments(argv).revision, 3);
  assert.throws(() => parseWindowsScmServiceBridgeFinalizationArguments(
    argv.map((value) => value === "1.0.0" ? "latest" : value),
  ), /finalization input is invalid/);
  assert.throws(() => parseWindowsScmServiceBridgeFinalizationArguments(
    argv.map((value) => value === "/private/release/trust-policy.json" ? "relative.json" : value),
  ), /finalization input is invalid/);
  assert.throws(() => new MtlsWindowsScmServiceBridgeSigner({
    endpoint: "http://windows-scm-bridge-kms.internal",
    keyId,
    tls: { key: Buffer.alloc(64), cert: Buffer.alloc(64), ca: Buffer.alloc(64) },
  }), /finalization input is invalid/);
  const inspection = inspectWindowsScmServiceBridgeTrustPolicy(trustPolicy);
  assert.equal(inspection.policyDigest, trustPolicyDigest);
  assert.ok(!JSON.stringify(inspection).includes("publicKeySpkiBase64"));
  assert.deepEqual(parseWindowsScmServiceBridgeTrustInspectionArguments([
    "--trust-policy", "/private/release/trust-policy.json",
  ]), { trustPolicyPath: "/private/release/trust-policy.json" });
  assert.ok(canonicalJson(trustPolicy).includes(keyId));
});

test("Windows SCM bridge source is a fixed fail-closed SCM host without shell execution", async () => {
  const [source, cmake] = await Promise.all([
    readFile(new URL("../services/runner-control/native/windows-scm-service-bridge.c", import.meta.url), "utf8"),
    readFile(new URL("../services/runner-control/native/CMakeLists.txt", import.meta.url), "utf8"),
  ]);
  for (const required of [
    "StartServiceCtrlDispatcherW", "RegisterServiceCtrlHandlerExW", "BCryptOpenAlgorithmProvider",
    "FILE_FLAG_OPEN_REPARSE_POINT", "GetFinalPathNameByHandleW", "CreateProcessW(verified_executable",
    "CREATE_SUSPENDED", "AssignProcessToJobObject", "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
    "DeviLudoPhysicalRunner", "DeviLudoSteamConnector", "DeviLudoSteamDepotFinalizer",
    "TargetArgumentDigest", "deviludo-steam-depot-finalizer-service.mjs", "--identity",
  ]) assert.match(source, new RegExp(required.replaceAll("(", "\\(")));
  assert.doesNotMatch(source, /\bsystem\s*\(|ShellExecute|cmd\.exe|powershell/i);
  assert.match(cmake, /NOT WIN32 OR NOT MSVC/);
  assert.match(cmake, /\/W4 \/WX \/O2 \/GL \/GS \/guard:cf \/sdl/);
  assert.match(cmake, /\/DYNAMICBASE \/NXCOMPAT \/HIGHENTROPYVA \/guard:cf \/CETCOMPAT/);
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
