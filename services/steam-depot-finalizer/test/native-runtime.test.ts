import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { steamCanonicalDigest } from "../../steam-publisher/src/artifacts";
import {
  signedDepotObjectKey,
  signingEvidenceObjectKey,
} from "../../steam-publisher/src/depot-finalization";
import { parseSteamDepotFinalizationRequest } from "../src/contract";
import type { SteamDepotFinalizationRequest } from "../src/contracts";
import { LockedNativeSteamDepotFinalizer, type NativeSteamDepotProcess } from "../src/locked-native-finalizer";
import { steamDepotFinalizerConfigFromEnv } from "../src/run-service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";

test("locked native finalizer pins runtime, argv, files and credential-free environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-depot-finalizer-"));
  const executable = join(root, "native-finalizer");
  const policyFile = join(root, "policy.json");
  const workRoot = join(root, "work");
  await Promise.all([
    writeFile(executable, "signed-native-binary", { mode: 0o700 }),
    writeFile(policyFile, '{"schemaVersion":"deviludo.steam-depot-signing-policy.v1"}', { mode: 0o400 }),
    mkdir(workRoot, { mode: 0o700 }),
  ]);
  await chmod(executable, 0o700);
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const process: NativeSteamDepotProcess = async (_executable, args, options) => {
    calls.push({ args, env: options.env });
    if (args[0] === "probe") {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          schemaVersion: "deviludo.native-steam-depot-finalizer-probe.v1",
          status: "READY",
          policyDigest: digest(await readFile(policyFile)),
          supportedSchemes: ["LINUX_SIGSTORE", "MACOS_DEVELOPER_ID", "WINDOWS_AUTHENTICODE"],
        }),
      };
    }
    const requestPath = args[args.indexOf("--request-file") + 1]!;
    const receiptPath = args[args.indexOf("--receipt-file") + 1]!;
    const request = parseSteamDepotFinalizationRequest(JSON.parse(await readFile(requestPath, "utf8")) as unknown);
    await writeFile(receiptPath, JSON.stringify(receipt(request)), { flag: "wx", mode: 0o400 });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const finalizer = new LockedNativeSteamDepotFinalizer({
    executable,
    executableDigest: digest(await readFile(executable)),
    policyFile,
    policyDigest: digest(await readFile(policyFile)),
    workRoot,
    process,
  });
  await finalizer.probe();
  const request = finalizationRequest();
  const finalized = await finalizer.finalize(request);
  const replay = await finalizer.finalize(request);
  assert.deepEqual(replay, finalized);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.args.slice(0, 3), ["finalize", "--policy-file", policyFile]);
  assert.equal(calls[1]?.args.includes("--request-file"), true);
  assert.equal(calls[1]?.args.includes("--receipt-file"), true);
  assert.deepEqual(Object.keys(calls[1]?.env ?? {}).sort(), [
    "HOME", "LANG", "NODE_ENV", "TEMP", "TMP", "TMPDIR", "USERPROFILE",
  ]);
  assert.equal(JSON.stringify(calls).match(/password|api.?key|authorization|bearer|config\.vdf/i), null);
});

test("runtime digest drift stops before the native signing process", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-depot-tamper-"));
  const executable = join(root, "native-finalizer");
  const policyFile = join(root, "policy.json");
  const workRoot = join(root, "work");
  await Promise.all([
    writeFile(executable, "binary-v1", { mode: 0o700 }),
    writeFile(policyFile, "policy-v1", { mode: 0o400 }),
    mkdir(workRoot, { mode: 0o700 }),
  ]);
  await chmod(executable, 0o700);
  let calls = 0;
  const finalizer = new LockedNativeSteamDepotFinalizer({
    executable,
    executableDigest: digest(await readFile(executable)),
    policyFile,
    policyDigest: digest(await readFile(policyFile)),
    workRoot,
    process: async () => { calls += 1; return { exitCode: 1, stdout: "", stderr: "" }; },
  });
  await chmod(policyFile, 0o600);
  await writeFile(policyFile, "policy-v2");
  await assert.rejects(finalizer.finalize(finalizationRequest()), /runtime digest/);
  assert.equal(calls, 0);
});

test("production configuration loads only file-mounted TLS and fixed native artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-depot-config-"));
  const files = {
    key: join(root, "server.key"),
    certificate: join(root, "server.crt"),
    ca: join(root, "client-ca.crt"),
    executable: join(root, "native-finalizer"),
    policy: join(root, "policy.json"),
    work: join(root, "work"),
  };
  await Promise.all([
    writeFile(files.key, "k".repeat(64), { mode: 0o400 }),
    writeFile(files.certificate, "c".repeat(64), { mode: 0o400 }),
    writeFile(files.ca, "a".repeat(64), { mode: 0o400 }),
    writeFile(files.executable, "native", { mode: 0o700 }),
    writeFile(files.policy, "policy", { mode: 0o400 }),
    mkdir(files.work, { mode: 0o700 }),
  ]);
  const env = {
    NODE_ENV: "production",
    DEVILUDO_STEAM_DEPOT_FINALIZER_PLATFORM: "linux",
    DATABASE_URL: "postgresql://deviludo@postgres.internal/deviludo",
    DEVILUDO_STEAM_DEPOT_FINALIZER_VERSION: "1.0.0",
    DEVILUDO_STEAM_DEPOT_FINALIZER_BINARY_DIGEST: "1".repeat(64),
    DEVILUDO_STEAM_DEPOT_FINALIZER_ALLOWED_SPIFFE_IDS: '["spiffe://deviludo.internal/steam-workflow-executor"]',
    DEVILUDO_STEAM_DEPOT_FINALIZER_TLS_KEY_FILE: files.key,
    DEVILUDO_STEAM_DEPOT_FINALIZER_TLS_CERT_FILE: files.certificate,
    DEVILUDO_STEAM_DEPOT_FINALIZER_CLIENT_CA_FILE: files.ca,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE: files.executable,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_EXECUTABLE_DIGEST: "2".repeat(64),
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_POLICY_FILE: files.policy,
    DEVILUDO_STEAM_DEPOT_FINALIZER_NATIVE_POLICY_DIGEST: "3".repeat(64),
    DEVILUDO_STEAM_DEPOT_FINALIZER_WORK_ROOT: files.work,
  };
  const config = await steamDepotFinalizerConfigFromEnv(env);
  assert.equal(config.port, 4855);
  assert.equal(config.platform, "linux");
  assert.deepEqual(config.supportedSchemes, ["LINUX_SIGSTORE"]);
  assert.deepEqual([...config.allowedSpiffeIds], ["spiffe://deviludo.internal/steam-workflow-executor"]);
  assert.equal(config.tlsKey.toString(), "k".repeat(64));
  assert.equal(config.nativeTimeoutMs, 3_000_000);
  assert.equal(config.leaseMs, 3_300_000);
  await assert.rejects(steamDepotFinalizerConfigFromEnv({ ...env, NODE_ENV: "development" }), /production/);
  await assert.rejects(steamDepotFinalizerConfigFromEnv({
    ...env,
    DEVILUDO_STEAM_DEPOT_FINALIZER_ALLOWED_SPIFFE_IDS:
      '["spiffe://deviludo.internal/web","spiffe://deviludo.internal/steam-workflow-executor"]',
  }), /sorted/);
});

function finalizationRequest(): SteamDepotFinalizationRequest {
  const sourceArtifactDigest = "a".repeat(64);
  const core = Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalization.v1" as const,
    operationKey: `steam-depot-finalize:${releaseId}:windows`,
    tenantId,
    projectId,
    releaseId,
    mainCommitSha: "1".repeat(40),
    evidenceBundleDigest: "2".repeat(64),
    platform: "windows" as const,
    sourceObjectKey: `tenants/${tenantId}/projects/${projectId}/runner-artifacts/${attemptId}/windows/production-export/${sourceArtifactDigest}`,
    sourceArtifactDigest,
  });
  return parseSteamDepotFinalizationRequest({ ...core, requestDigest: steamCanonicalDigest(core) });
}

function receipt(request: SteamDepotFinalizationRequest) {
  const artifactDigest = "3".repeat(64);
  const signingEvidenceDigest = "4".repeat(64);
  return {
    schemaVersion: "deviludo.steam-depot-finalization-receipt.v1" as const,
    operationKey: request.operationKey,
    requestDigest: request.requestDigest,
    tenantId: request.tenantId,
    projectId: request.projectId,
    releaseId: request.releaseId,
    mainCommitSha: request.mainCommitSha,
    evidenceBundleDigest: request.evidenceBundleDigest,
    platform: request.platform,
    sourceArtifactDigest: request.sourceArtifactDigest,
    artifactObjectKey: signedDepotObjectKey(
      request.tenantId, request.projectId, request.releaseId, request.platform, artifactDigest,
    ),
    artifactDigest,
    signingScheme: "WINDOWS_AUTHENTICODE" as const,
    signingIdentityDigest: "5".repeat(64),
    signingEvidenceObjectKey: signingEvidenceObjectKey(
      request.tenantId, request.projectId, request.releaseId, request.platform, signingEvidenceDigest,
    ),
    signingEvidenceDigest,
    notarizationEvidenceObjectKey: null,
    notarizationEvidenceDigest: null,
  };
}

function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
