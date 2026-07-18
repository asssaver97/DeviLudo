import { createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { sourceSnapshotClientFromEnv } from "../../artifact-preparer/src/source-snapshot-client";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { AgentBaselineSourceSnapshotPort } from "./baseline-source";
import { LockedNativeMicrovmAgentExecutor } from "./native-microvm-executor";
import { PostgresAgentDevelopmentWorkPackage } from "./postgres-work-package";
import { agentExecutionWorkerFromEnv } from "./run-worker";
import { scmCandidatePublisherFromEnv } from "./scm-candidate-client";
import type { EphemeralRunTokenSecretStore } from "./token-broker";

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
  const pool = postgresWorkflowPoolFromEnv(serviceEnv);
  try {
    const [snapshots, candidates, publicKeyBytes] = await Promise.all([sourceSnapshotClientFromEnv(env),
      scmCandidatePublisherFromEnv(env), bytes(env, "DEVILUDO_AGENT_MICROVM_ATTESTATION_PUBLIC_KEY_FILE")]);
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
      timeoutMs: seconds(env.DEVILUDO_AGENT_MICROVM_TIMEOUT_SECONDS, 900, 60, 900) * 1_000,
      attestationKeyId: safeId(env, "DEVILUDO_AGENT_MICROVM_ATTESTATION_KEY_ID"),
      attestationPublicKey: publicKey,
      sources,
      packages,
    });
    const worker = await agentExecutionWorkerFromEnv(executor, candidates, secrets, serviceEnv, pool);
    return Object.freeze({ ...worker, executor, candidates, packages, sources, snapshots });
  } catch (error) { await pool.close().catch(() => undefined); throw error; }
}

async function bytes(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const file = await open(absolute(env, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) throw new Error(`${name} is invalid`);
    return await file.readFile(); } finally { await file.close(); }
}
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
