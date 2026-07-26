import { createHash, createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { sourceSnapshotClientFromEnv } from "../../artifact-preparer/src/source-snapshot-client";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { AgentBaselineSourceSnapshotPort } from "./baseline-source";
import { LockedNativeMicrovmAgentExecutor } from "./native-microvm-executor";
import { verifyConfiguredAgentMicrovmGuestRelease } from "./native-microvm-guest-release";
import { verifySignedAgentMicrovmLauncherRelease } from "./native-microvm-launcher-release";
import { parseNativeMicrovmLauncherConfig } from "./native-microvm-launcher";
import { PostgresAgentDevelopmentWorkPackage } from "./postgres-work-package";
import { agentExecutionWorkerFromEnv } from "./run-worker";
import { scmCandidatePublisherFromEnv } from "./scm-candidate-client";
import type { EphemeralRunTokenSecretStore } from "./token-broker";
import { guestCredentialImageIssuerFromEnv } from "./guest-credential-client";
import { agentExecutionWorkerBindingFromEnv, assertAgentExecutionWorkerGuestBinding } from "./worker-binding";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

/**
 * Production composition excluding the Vault implementation. The secret store
 * is deliberately injected so this module cannot silently fall back to memory
 * or place a DLRT in process environment variables.
 */
export async function nativeAgentExecutionWorkerFromEnv(secrets: EphemeralRunTokenSecretStore,
  env: Readonly<Record<string, string | undefined>> = process.env) {
  const serviceEnv = Object.freeze({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "agent-execution-worker" });
  const verifiedRuntime = await verifyAgentMicrovmWorkerRuntimeFromEnv(env);
  const binding = assertAgentExecutionWorkerGuestBinding(await agentExecutionWorkerBindingFromEnv(env), verifiedRuntime.guest);
  const pool = postgresWorkflowPoolFromEnv(serviceEnv);
  try {
    const [snapshots, candidates, publicKeyBytes, credentialIssuer] = await Promise.all([sourceSnapshotClientFromEnv(env),
      scmCandidatePublisherFromEnv(env), bytes(env, "DEVILUDO_AGENT_MICROVM_ATTESTATION_PUBLIC_KEY_FILE"),
      guestCredentialImageIssuerFromEnv(env)]);
    const publicKey = createPublicKey(publicKeyBytes);
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") throw new Error("microVM attestation key is invalid");
    const packages = new PostgresAgentDevelopmentWorkPackage(pool);
    const sources = new AgentBaselineSourceSnapshotPort(snapshots);
    const executor = new LockedNativeMicrovmAgentExecutor({
      executable: absolute(env, "DEVILUDO_AGENT_MICROVM_EXECUTABLE"),
      executableDigest: digest(env, "DEVILUDO_AGENT_MICROVM_EXECUTABLE_DIGEST"),
      configFile: absolute(env, "DEVILUDO_AGENT_MICROVM_CONFIG_FILE"),
      configDigest: digest(env, "DEVILUDO_AGENT_MICROVM_CONFIG_DIGEST"),
      workRoot: absolute(env, "DEVILUDO_AGENT_MICROVM_WORK_ROOT"),
      inferenceGatewayUrl: required(env, "DEVILUDO_AGENT_INFERENCE_GATEWAY_URL"),
      timeoutMs: seconds(env.DEVILUDO_AGENT_MICROVM_TIMEOUT_SECONDS, 7_200, 60, 86_400) * 1_000,
      heartbeatIntervalMs: seconds(env.DEVILUDO_AGENT_MICROVM_HEARTBEAT_SECONDS, 30, 5, 120) * 1_000,
      attestationKeyId: safeId(env, "DEVILUDO_AGENT_MICROVM_ATTESTATION_KEY_ID"),
      attestationPublicKey: publicKey, credentialIssuer,
      sources,
      packages,
    });
    const worker = await agentExecutionWorkerFromEnv(executor, candidates, secrets, serviceEnv, pool, binding);
    return Object.freeze({ ...worker, executor, candidates, packages, sources, snapshots });
  } catch (error) { await pool.close().catch(() => undefined); throw error; }
}

/** Refuses database and Broker access until the complete launcher release is authorized. */
export async function verifyAgentMicrovmLauncherRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): Promise<import("./native-microvm-launcher-release").AgentMicrovmLauncherReleaseClaims> {
  return (await verifyAgentMicrovmWorkerRuntimeFromEnv(env, now)).launcher;
}

export async function verifyAgentMicrovmWorkerRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
) {
  const launcherPath = absolute(env, "DEVILUDO_AGENT_MICROVM_EXECUTABLE");
  const configPath = absolute(env, "DEVILUDO_AGENT_MICROVM_CONFIG_FILE");
  const buildReceiptPath = absolute(env, "DEVILUDO_AGENT_MICROVM_BUILD_RECEIPT_FILE");
  const [launcher, configBytes, buildReceiptBytes, releaseBytes, trustPolicyBytes] = await Promise.all([
    hashedFile(launcherPath, 1024 * 1024 * 1024),
    boundedBytes(configPath, 1024 * 1024),
    boundedBytes(buildReceiptPath, 1024 * 1024),
    boundedBytes(absolute(env, "DEVILUDO_AGENT_MICROVM_RELEASE_FILE"), 1024 * 1024),
    boundedBytes(absolute(env, "DEVILUDO_AGENT_MICROVM_TRUST_POLICY_FILE"), 1024 * 1024),
  ]);
  const executableDigest = digest(env, "DEVILUDO_AGENT_MICROVM_EXECUTABLE_DIGEST");
  const configDigest = digest(env, "DEVILUDO_AGENT_MICROVM_CONFIG_DIGEST");
  if (launcher.digest !== executableDigest || sha256(configBytes) !== configDigest) throw new Error("microVM launcher runtime is invalid");
  let config: unknown; let release: unknown; let trustPolicy: unknown;
  try {
    config = JSON.parse(configBytes.toString("utf8"));
    release = JSON.parse(releaseBytes.toString("utf8"));
    trustPolicy = JSON.parse(trustPolicyBytes.toString("utf8"));
  } catch { throw new Error("microVM launcher runtime is invalid"); }
  const launcherClaims = verifySignedAgentMicrovmLauncherRelease(release, {
    trustPolicy,
    trustPolicyDigest: digest(env, "DEVILUDO_AGENT_MICROVM_TRUST_POLICY_DIGEST"),
    platformVersion: required(env, "DEVILUDO_PLATFORM_VERSION"),
    launcherDigest: executableDigest,
    buildReceiptDigest: sha256(buildReceiptBytes),
    config,
    configDigest,
    now,
  });
  const parsedConfig = parseNativeMicrovmLauncherConfig(config);
  const runtimeFiles = await Promise.all([
    hashedFile(parsedConfig.firecrackerExecutable, 1024 * 1024 * 1024),
    hashedFile(parsedConfig.jailerExecutable, 1024 * 1024 * 1024),
    hashedFile(parsedConfig.kernelImage, 1024 * 1024 * 1024),
    hashedFile(parsedConfig.rootfsImage, 64 * 1024 * 1024 * 1024),
    hashedFile(parsedConfig.mke2fsExecutable, 1024 * 1024 * 1024),
    hashedFile(parsedConfig.debugfsExecutable, 1024 * 1024 * 1024),
  ]);
  const expected = [parsedConfig.firecrackerDigest, parsedConfig.jailerDigest, parsedConfig.kernelDigest,
    parsedConfig.rootfsDigest, parsedConfig.mke2fsDigest, parsedConfig.debugfsDigest];
  if (runtimeFiles.some((file, index) => file.digest !== expected[index])) throw new Error("microVM launcher runtime is invalid");
  const guest = await verifyConfiguredAgentMicrovmGuestRelease({
    releaseFile: parsedConfig.rootfsReleaseFile, releaseDigest: parsedConfig.rootfsReleaseDigest,
    trustPolicyFile: parsedConfig.rootfsTrustPolicyFile, trustPolicyDigest: parsedConfig.rootfsTrustPolicyDigest,
    platformVersion: parsedConfig.platformVersion, rootfsDigest: parsedConfig.rootfsDigest, now,
  });
  return Object.freeze({ launcher: launcherClaims, guest });
}

async function bytes(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const file = await open(absolute(env, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) throw new Error(`${name} is invalid`);
    return await file.readFile(); } finally { await file.close(); }
}
async function boundedBytes(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > maximum || (before.mode & 0o022) !== 0) throw new Error("microVM launcher runtime is invalid");
    const value = await file.readFile();
    const after = await file.stat();
    if (value.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("microVM launcher runtime is invalid");
    return value;
  } finally { await file.close(); }
}
async function hashedFile(path: string, maximum: number): Promise<Readonly<{ digest: string; sizeBytes: number }>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum || (before.mode & 0o022) !== 0) throw new Error("microVM launcher runtime is invalid");
    const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, before.size - offset), offset);
      if (bytesRead < 1) throw new Error("microVM launcher runtime is invalid");
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("microVM launcher runtime is invalid");
    return Object.freeze({ digest: hash.digest("hex"), sizeBytes: before.size });
  } finally { await file.close(); }
}
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function absolute(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = required(env, name);
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || value.includes("\0")) throw new Error(`${name} is invalid`); return value; }
function digest(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = required(env, name);
  if (!SHA256.test(value)) throw new Error(`${name} is invalid`); return value; }
function safeId(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = required(env, name);
  if (!SAFE_ID.test(value)) throw new Error(`${name} is invalid`); return value; }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`); return value; }
function seconds(value: string | undefined, fallback: number, min: number, max: number): number { if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10); if (!Number.isSafeInteger(parsed) || String(parsed) !== value || parsed < min || parsed > max) throw new Error("microVM timeout is invalid"); return parsed; }
