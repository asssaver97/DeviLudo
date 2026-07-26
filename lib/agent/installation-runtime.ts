import { sha256Canonical } from "../../services/runner-control/src/canonical";
import { isBuiltInAdapterVersion } from "./adapter-registry";

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Immutable proof that one catalog Installation has been materialized as the
 * exact production microVM runtime consumed by an Agent execution Worker.
 */
export interface AgentInstallationRuntimeBinding {
  readonly schemaVersion: "deviludo.agent-installation-runtime-binding.v1";
  readonly backend: "firecracker-jailer";
  readonly platform: "linux";
  readonly architecture: "amd64";
  readonly installationId: string;
  readonly workerPool: string;
  readonly agent: "claude-code" | "codex-cli";
  readonly exactAgentVersion: string;
  readonly adapterVersion: string;
  readonly workerImageDigest: string;
  readonly launcherReleaseId: string;
  readonly launcherReleaseDigest: string;
  readonly guestReleaseId: string;
  readonly guestReleaseDigest: string;
  readonly workerBindingDigest: string;
}

export interface AgentInstallationFleetHealth {
  readonly schemaVersion: "deviludo.agent-installation-fleet-health.v1";
  readonly registeredWorkers: number;
  readonly readyWorkers: number;
  readonly observedAt: string;
}

export type AgentInstallationRuntimeExpectation = Readonly<Partial<Pick<AgentInstallationRuntimeBinding,
  "installationId" | "workerPool" | "agent" | "exactAgentVersion" | "adapterVersion" | "workerImageDigest">>>;

export function parseAgentInstallationRuntimeBinding(
  value: unknown,
  expected: AgentInstallationRuntimeExpectation = {},
): AgentInstallationRuntimeBinding {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "backend", "platform", "architecture", "installationId", "workerPool", "agent",
    "exactAgentVersion", "adapterVersion", "workerImageDigest", "launcherReleaseId", "launcherReleaseDigest",
    "guestReleaseId", "guestReleaseDigest", "workerBindingDigest",
  ]);
  if (body.schemaVersion !== "deviludo.agent-installation-runtime-binding.v1"
    || body.backend !== "firecracker-jailer" || body.platform !== "linux" || body.architecture !== "amd64"
    || typeof body.installationId !== "string" || !SAFE_ID.test(body.installationId)
    || typeof body.workerPool !== "string" || !/^development-[a-z0-9][a-z0-9_-]{0,99}$/.test(body.workerPool)
    || body.agent !== "claude-code" && body.agent !== "codex-cli"
    || typeof body.exactAgentVersion !== "string" || !fixedVersion(body.exactAgentVersion)
    || typeof body.adapterVersion !== "string" || !fixedVersion(body.adapterVersion)
    || !isBuiltInAdapterVersion(body.agent, body.adapterVersion)
    || typeof body.workerImageDigest !== "string" || !IMAGE_DIGEST.test(body.workerImageDigest)
    || typeof body.launcherReleaseId !== "string" || !UUID.test(body.launcherReleaseId)
    || typeof body.guestReleaseId !== "string" || !UUID.test(body.guestReleaseId)
    || typeof body.launcherReleaseDigest !== "string" || !SHA256.test(body.launcherReleaseDigest)
    || typeof body.guestReleaseDigest !== "string" || !SHA256.test(body.guestReleaseDigest)
    || typeof body.workerBindingDigest !== "string" || !SHA256.test(body.workerBindingDigest)) invalid();
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && body[key] !== expectedValue) invalid();
  }
  return deepFreeze({
    schemaVersion: body.schemaVersion,
    backend: body.backend,
    platform: body.platform,
    architecture: body.architecture,
    installationId: body.installationId,
    workerPool: body.workerPool,
    agent: body.agent,
    exactAgentVersion: body.exactAgentVersion,
    adapterVersion: body.adapterVersion,
    workerImageDigest: body.workerImageDigest,
    launcherReleaseId: body.launcherReleaseId,
    launcherReleaseDigest: body.launcherReleaseDigest,
    guestReleaseId: body.guestReleaseId,
    guestReleaseDigest: body.guestReleaseDigest,
    workerBindingDigest: body.workerBindingDigest,
  });
}

export function parseAgentInstallationFleetHealth(
  value: unknown,
  options: Readonly<{ requireReadyWorker?: boolean }> = {},
): AgentInstallationFleetHealth {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "registeredWorkers", "readyWorkers", "observedAt"]);
  if (body.schemaVersion !== "deviludo.agent-installation-fleet-health.v1"
    || !Number.isSafeInteger(body.registeredWorkers) || (body.registeredWorkers as number) < 0
    || (body.registeredWorkers as number) > 100_000
    || !Number.isSafeInteger(body.readyWorkers) || (body.readyWorkers as number) < 0
    || (body.readyWorkers as number) > (body.registeredWorkers as number)
    || options.requireReadyWorker === true && (body.readyWorkers as number) < 1
    || typeof body.observedAt !== "string" || !canonicalTimestamp(body.observedAt)) invalid();
  return Object.freeze({
    schemaVersion: body.schemaVersion,
    registeredWorkers: body.registeredWorkers as number,
    readyWorkers: body.readyWorkers as number,
    observedAt: body.observedAt,
  });
}

export function agentInstallationRuntimeBindingDigest(value: AgentInstallationRuntimeBinding): string {
  return sha256Canonical(parseAgentInstallationRuntimeBinding(value));
}

export function sameAgentInstallationRuntimeBinding(
  left: AgentInstallationRuntimeBinding,
  right: AgentInstallationRuntimeBinding,
): boolean {
  return agentInstallationRuntimeBindingDigest(left) === agentInstallationRuntimeBindingDigest(right);
}

function fixedVersion(value: string): boolean {
  return VERSION.test(value) && !/(?:latest|stable|default)/i.test(value);
}
function canonicalTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(); const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function invalid(): never { throw new Error("Agent Installation runtime proof is invalid"); }
