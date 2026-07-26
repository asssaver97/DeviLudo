import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { isBuiltInAdapterVersion } from "../../../lib/agent/adapter-registry";
import type { AgentMicrovmGuestReleaseClaims } from "./native-microvm-guest-release";

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_BINDING_BYTES = 64 * 1024;

/**
 * Root-owned, immutable placement authority for one production Worker process.
 * A single signed Guest can serve several logical Installations only when all
 * of them resolve to the exact same Agent/CLI/Adapter/WorkerImage identity.
 */
export interface AgentExecutionWorkerBinding {
  readonly schemaVersion: "deviludo.agent-execution-worker-binding.v1";
  readonly workerPool: string;
  readonly installationIds: readonly string[];
  readonly agent: "claude-code" | "codex-cli";
  readonly exactAgentVersion: string;
  readonly adapterVersion: string;
  readonly workerImageDigest: string;
}

export function parseAgentExecutionWorkerBinding(value: unknown): AgentExecutionWorkerBinding {
  if (!plainRecord(value) || !exactKeys(value, [
    "schemaVersion", "workerPool", "installationIds", "agent", "exactAgentVersion", "adapterVersion",
    "workerImageDigest",
  ]) || value.schemaVersion !== "deviludo.agent-execution-worker-binding.v1"
    || typeof value.workerPool !== "string" || !/^development-[a-z0-9][a-z0-9_-]{0,99}$/.test(value.workerPool)
    || !Array.isArray(value.installationIds) || value.installationIds.length < 1 || value.installationIds.length > 32
    || value.installationIds.some((item) => typeof item !== "string" || !SAFE_ID.test(item))
    || new Set(value.installationIds).size !== value.installationIds.length
    || JSON.stringify(value.installationIds) !== JSON.stringify([...value.installationIds].sort())
    || (value.agent !== "claude-code" && value.agent !== "codex-cli")
    || !fixedVersion(value.exactAgentVersion) || !fixedVersion(value.adapterVersion)
    || !isBuiltInAdapterVersion(value.agent, value.adapterVersion)
    || typeof value.workerImageDigest !== "string" || !IMAGE_DIGEST.test(value.workerImageDigest)) invalid();
  return deepFreeze({
    schemaVersion: value.schemaVersion,
    workerPool: value.workerPool,
    installationIds: [...value.installationIds] as string[],
    agent: value.agent,
    exactAgentVersion: value.exactAgentVersion,
    adapterVersion: value.adapterVersion,
    workerImageDigest: value.workerImageDigest,
  });
}

export function assertAgentExecutionWorkerGuestBinding(
  binding: AgentExecutionWorkerBinding,
  guest: Pick<AgentMicrovmGuestReleaseClaims,
    "agent" | "exactAgentVersion" | "adapterVersion" | "workerImageDigest">,
): AgentExecutionWorkerBinding {
  const value = parseAgentExecutionWorkerBinding(binding);
  if (!plainRecord(guest) || guest.agent !== value.agent || guest.exactAgentVersion !== value.exactAgentVersion
    || guest.adapterVersion !== value.adapterVersion || guest.workerImageDigest !== value.workerImageDigest) invalid();
  return value;
}

export async function agentExecutionWorkerBindingFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AgentExecutionWorkerBinding> {
  const path = absolute(required(env, "DEVILUDO_AGENT_EXECUTION_WORKER_BINDING_FILE"));
  const expectedDigest = required(env, "DEVILUDO_AGENT_EXECUTION_WORKER_BINDING_DIGEST");
  if (!SHA256.test(expectedDigest)) invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_BINDING_BYTES || (before.mode & 0o022) !== 0) invalid();
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || createHash("sha256").update(bytes).digest("hex") !== expectedDigest) invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
    return parseAgentExecutionWorkerBinding(parsed);
  } finally { await file.close(); }
}

function fixedVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value);
}
function absolute(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /[\0\r\n]/.test(value)) invalid();
  return value;
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function invalid(): never { throw new Error("Agent execution Worker binding is invalid"); }
