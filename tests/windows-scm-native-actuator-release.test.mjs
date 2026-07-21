import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { canonicalJson, sha256Canonical } from "../services/runner-control/src/canonical.ts";
import {
  createWindowsScmActuationRequest,
  decodeWindowsScmActuationRequest,
  encodeWindowsScmActuationRequest,
  windowsScmActuationRequestDigest,
} from "../services/runner-control/src/windows-scm-actuation-request.ts";
import {
  verifySignedWindowsScmNativeActuatorManifest,
  windowsScmNativeActuatorTrustPolicyDigest,
} from "../services/runner-control/src/windows-scm-native-actuator.ts";
import {
  finalizeWindowsScmNativeActuator,
  MtlsWindowsScmNativeActuatorSigner,
  parseWindowsScmNativeActuatorFinalizationArguments,
  prepareWindowsScmNativeActuatorClaims,
} from "../scripts/production/finalize-windows-scm-native-actuator.mjs";
import {
  inspectWindowsScmNativeActuatorTrustPolicy,
  parseWindowsScmNativeActuatorTrustInspectionArguments,
} from "../scripts/production/inspect-windows-scm-native-actuator-trust-policy.mjs";
import {
  compileWindowsScmActuationRequest,
  parseWindowsScmActuationRequestArguments,
} from "../scripts/production/compile-windows-scm-actuation-request.mjs";

const keyPair = generateKeyPairSync("ed25519");
const keyId = "windows-scm-actuator-release-2026-01";
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.windows-scm-native-actuator-trust-policy.v1",
  policyId: "deviludo-windows-scm-actuator-production",
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
const trustPolicyDigest = windowsScmNativeActuatorTrustPolicyDigest(trustPolicy);

test("Windows SCM actuator request is canonical, bounded and round-trips empty environment values", () => {
  const transaction = windowsTransaction();
  const request = createWindowsScmActuationRequest(transaction);
  const encoded = encodeWindowsScmActuationRequest(request);
  assert.equal(encoded.subarray(0, 16).toString("ascii"), "DEVILUDO_SCM_V1\0");
  assert.equal(encoded.readUInt32LE(16), 1);
  assert.equal(encoded.readUInt32LE(20), encoded.length);
  assert.equal(request.transactionDigest, transaction.transactionDigest);
  assert.deepEqual(decodeWindowsScmActuationRequest(encoded), request);
  assert.equal(windowsScmActuationRequestDigest(encoded), digest(encoded));
  assert.equal(request.services[0].environment.DEVILUDO_OPTIONAL_VALUE, "");

  const tampered = Buffer.from(encoded);
  tampered[0] ^= 1;
  assert.throws(() => decodeWindowsScmActuationRequest(tampered), /actuation request is invalid/);
  const duplicateNameBytes = encodeWindowsScmActuationRequest({
    ...request,
    services: [{ ...request.services[0], environment: { A_VALUE: "", B_VALUE: "production" } }],
  });
  const secondNameOffset = duplicateNameBytes.indexOf(Buffer.from("B_VALUE", "ascii"));
  assert.ok(secondNameOffset > 0);
  Buffer.from("A_VALUE", "ascii").copy(duplicateNameBytes, secondNameOffset);
  assert.throws(() => decodeWindowsScmActuationRequest(duplicateNameBytes), /actuation request is invalid/);
  assert.throws(() => createWindowsScmActuationRequest({ ...transaction, managerTool: "C:\\Windows\\System32\\sc.exe" }),
    /actuation request is invalid/);
  assert.throws(() => encodeWindowsScmActuationRequest({
    ...request,
    services: [{ ...request.services[0], environment: { Z_VALUE: "1", A_VALUE: "2" } }],
  }), /actuation request is invalid/);
});

test("Windows SCM request compiler is transaction-bound and create-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-windows-scm-request-"));
  try {
    const transaction = windowsTransaction();
    const transactionPath = resolve(root, "service-transaction.json");
    const outputPath = resolve(root, "actuation-request.v1.bin");
    await writeFile(transactionPath, JSON.stringify(transaction));
    const options = { transactionPath, transactionDigest: transaction.transactionDigest, outputPath };
    const first = await compileWindowsScmActuationRequest(options);
    assert.equal(first.replayed, false);
    assert.equal(first.request.transactionDigest, transaction.transactionDigest);
    assert.deepEqual(decodeWindowsScmActuationRequest(await readFile(outputPath)), first.request);
    assert.equal((await compileWindowsScmActuationRequest(options)).replayed, true);
    assert.throws(() => parseWindowsScmActuationRequestArguments([
      "--transaction", "relative.json", "--transaction-digest", transaction.transactionDigest,
      "--output", outputPath,
    ]), /compilation input is invalid/);
    await assert.rejects(compileWindowsScmActuationRequest({
      ...options,
      transactionDigest: "f".repeat(64),
    }), /compilation input is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows SCM actuator finalizer binds independent Authenticode and scan evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-windows-scm-actuator-"));
  try {
    const binaryPath = resolve(root, "deviludo-windows-scm-native-actuator.exe");
    const evidencePath = resolve(root, "signing-evidence.json");
    const trustPolicyPath = resolve(root, "trust-policy.json");
    const outputPath = resolve(root, "actuator-manifest.json");
    const binary = Buffer.from("authenticode-signed-windows-scm-native-actuator\n");
    const evidence = {
      schemaVersion: "deviludo.windows-scm-native-actuator-signing-evidence.v1",
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
        signerIdentity: "CN=DeviLudo Windows Actuator Release",
        evidenceDigest: "5".repeat(64),
      },
    };
    await Promise.all([
      writeFile(binaryPath, binary),
      writeFile(evidencePath, JSON.stringify(evidence)),
      writeFile(trustPolicyPath, JSON.stringify(trustPolicy)),
    ]);
    const options = Object.freeze({
      actuatorVersion: "1.0.0",
      architecture: "x86_64",
      binaryPath,
      builtAt: "2026-07-22T05:00:00.000Z",
      evidencePath,
      outputPath,
      revision: 4,
      sourceDigest: "6".repeat(64),
      trustPolicyDigest,
      trustPolicyPath,
    });
    const claims = await prepareWindowsScmNativeActuatorClaims(options);
    assert.equal(claims.requestContractVersion, 1);
    assert.equal(claims.binaryDigest, digest(binary));
    assert.equal(claims.supplyChainEvidenceDigest, sha256Canonical(evidence));
    const calls = [];
    const signer = new MtlsWindowsScmNativeActuatorSigner({
      endpoint: "https://windows-scm-actuator-kms.internal:8443",
      keyId,
      tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
      request: async (input) => {
        calls.push(input);
        const body = JSON.parse(input.body);
        return { statusCode: 200, body: {
          schemaVersion: "deviludo.windows-scm-native-actuator-signing-response.v1",
          algorithm: "Ed25519",
          keyId,
          claimsDigest: body.claimsDigest,
          signature: sign(null, Buffer.from(body.signingInput, "base64url"), keyPair.privateKey).toString("base64url"),
        } };
      },
    });
    const finalized = await finalizeWindowsScmNativeActuator(options, {
      signer,
      now: new Date("2026-07-22T05:01:00.000Z"),
    });
    assert.equal(finalized.replayed, false);
    assert.equal(calls[0].url.href,
      "https://windows-scm-actuator-kms.internal:8443/v1/windows-scm-native-actuators/sign-ed25519");
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), finalized.manifest);
    assert.deepEqual(verifySignedWindowsScmNativeActuatorManifest(finalized.manifest, {
      trustPolicy,
      trustPolicyDigest,
      architecture: "x86_64",
      now: new Date("2026-07-22T05:01:00.000Z"),
    }), claims);
    assert.equal((await finalizeWindowsScmNativeActuator(options, {
      signer: { async sign() { throw new Error("exact replay must not call KMS"); } },
      now: new Date("2026-07-22T05:02:00.000Z"),
    })).replayed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows SCM actuator inputs are fixed-version and trust inspection redacts public-key material", () => {
  const argv = [
    "--actuator-version", "1.0.0",
    "--architecture", "x86_64",
    "--binary", "/private/release/deviludo-windows-scm-native-actuator.exe",
    "--built-at", "2026-07-22T05:00:00.000Z",
    "--evidence", "/private/release/evidence.json",
    "--output", "/private/release/manifest.json",
    "--revision", "4",
    "--source-digest", "6".repeat(64),
    "--trust-policy", "/private/release/trust-policy.json",
    "--trust-policy-digest", trustPolicyDigest,
  ];
  assert.equal(parseWindowsScmNativeActuatorFinalizationArguments(argv).revision, 4);
  assert.throws(() => parseWindowsScmNativeActuatorFinalizationArguments(
    argv.map((value) => value === "1.0.0" ? "latest" : value),
  ), /finalization input is invalid/);
  assert.throws(() => new MtlsWindowsScmNativeActuatorSigner({
    endpoint: "http://windows-scm-actuator-kms.internal",
    keyId,
    tls: { key: Buffer.alloc(64), cert: Buffer.alloc(64), ca: Buffer.alloc(64) },
  }), /finalization input is invalid/);
  const inspection = inspectWindowsScmNativeActuatorTrustPolicy(trustPolicy);
  assert.equal(inspection.policyDigest, trustPolicyDigest);
  assert.ok(!JSON.stringify(inspection).includes("publicKeySpkiBase64"));
  assert.deepEqual(parseWindowsScmNativeActuatorTrustInspectionArguments([
    "--trust-policy", "/private/release/trust-policy.json",
  ]), { trustPolicyPath: "/private/release/trust-policy.json" });
});

test("Windows SCM actuator source is a fixed ProgramData Win32 authority with no shell fallback", async () => {
  const [source, cmake] = await Promise.all([
    readFile(new URL("../services/runner-control/native/windows-scm-native-actuator.c", import.meta.url), "utf8"),
    readFile(new URL("../services/runner-control/native/CMakeLists.txt", import.meta.url), "utf8"),
  ]);
  for (const required of [
    "SHGetKnownFolderPath", "DeviLudoWindowsScmNativeActuatorV1", "FILE_FLAG_OPEN_REPARSE_POINT",
    "GetSecurityInfo", "GetEffectiveRightsFromAclW", "BCryptOpenAlgorithmProvider", "OpenSCManagerW", "CreateServiceW", "ChangeServiceConfigW",
    "ChangeServiceConfig2W", "RegSetValueExW", "StartServiceW", "QueryServiceStatusEx",
    "actuation-request.v1.bin", "pending-request.v1.bin", "active-request.v1.bin", "verify_service_parameters",
    "--apply", "--restore", "--probe", "--identity",
  ]) assert.match(source, new RegExp(required.replaceAll("(", "\\(")));
  assert.doesNotMatch(source, /\bsystem\s*\(|ShellExecute|cmd\.exe|powershell|sc\.exe|reg\.exe/i);
  assert.match(cmake, /add_executable\(deviludo-windows-scm-native-actuator/);
  assert.match(cmake, /advapi32 bcrypt shell32 ole32/);
});

function windowsTransaction() {
  const bridgePath = "C:\\Program Files\\DeviLudo\\deviludo-windows-scm-service-bridge.exe";
  const actuatorPath = "C:\\Program Files\\DeviLudo\\deviludo-windows-scm-native-actuator.exe";
  const targetPath = "C:\\Program Files\\DeviLudo\\deviludo-physical-runner.exe";
  const bridgeDigest = "1".repeat(64);
  const targetDigest = "2".repeat(64);
  const descriptor = {
    schemaVersion: "deviludo.windows-scm-service-descriptor.v1",
    serviceName: "DeviLudoPhysicalRunner",
    account: "NT SERVICE\\DeviLudoPhysicalRunner",
    binaryPathName: bridgePath,
    binaryPathDigest: bridgeDigest,
    targetExecutable: targetPath,
    targetDigest,
    arguments: [],
    startType: "AUTO_START",
    failureActions: [{ action: "RESTART", delaySeconds: 5 }],
    environment: { DEVILUDO_OPTIONAL_VALUE: "", NODE_ENV: "production" },
    bridgeContractVersion: 1,
    bridgeManifestDigest: "3".repeat(64),
    bridgeTrustPolicyDigest: "4".repeat(64),
    requiresServiceBridgeContractVersion: 1,
  };
  const rendered = `${canonicalJson(descriptor)}\n`;
  const core = {
    schemaVersion: "deviludo.runner-native-service-transaction.v1",
    status: "READY",
    platform: "windows",
    managerTool: actuatorPath,
    windowsActuator: {
      verified: true,
      component: "deviludo-windows-scm-native-actuator",
      path: actuatorPath,
      requestContractVersion: 1,
      binaryDigest: "5".repeat(64),
      manifestDigest: "6".repeat(64),
      trustPolicyDigest: "7".repeat(64),
    },
    definitions: [{
      component: "physical-runner",
      serviceId: "DeviLudoPhysicalRunner",
      account: "NT SERVICE\\DeviLudoPhysicalRunner",
      manager: "WINDOWS_SCM",
      format: "WINDOWS_SCM_DESCRIPTOR",
      destination: "SCM:DeviLudoPhysicalRunner",
      executable: bridgePath,
      executableDigest: bridgeDigest,
      targetExecutable: targetPath,
      targetExecutableDigest: targetDigest,
      rendered,
      renderedDigest: digest(rendered),
    }],
  };
  return Object.freeze({ ...core, transactionDigest: sha256Canonical(core) });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
