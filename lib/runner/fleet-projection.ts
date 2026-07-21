export const RUNNER_FLEET_PROJECTION_SCHEMA_VERSION = "deviludo.runner-fleet-projection.v1" as const;

export type RunnerPlatform = "linux" | "macos" | "windows";
export type RunnerArchitecture = "arm64" | "x86_64";
export type RunnerRegistrationState = "DRAINING" | "OFFLINE" | "ONLINE" | "QUARANTINED";
export type RunnerLeaseState = "EXPIRED" | "FAILED" | "INVALIDATED" | "LEASED" | "PASSED" | "RUNNING";
export type RunnerConnectivity = "DRAINING" | "OFFLINE" | "QUARANTINED" | "READY" | "STALE";

export interface ProjectRunnerProjection {
  readonly runnerId: string;
  readonly platform: RunnerPlatform;
  readonly architecture: RunnerArchitecture;
  readonly capabilityDigest: string;
  readonly registrationState: RunnerRegistrationState;
  readonly connectivity: RunnerConnectivity;
  readonly lastSeenAt: string;
  readonly certificateNotAfter: string;
  readonly attemptId: string;
  readonly leaseState: RunnerLeaseState;
  readonly fencingToken: string;
  readonly leaseExpiresAt: string;
  readonly updatedAt: string;
}

export interface RunnerFleetProjection {
  readonly schemaVersion: typeof RUNNER_FLEET_PROJECTION_SCHEMA_VERSION;
  readonly tenantId: string;
  readonly projectId: string;
  readonly observedAt: string;
  readonly runners: readonly ProjectRunnerProjection[];
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RUNNER_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,19}$/;
const FRESHNESS_MS = 5 * 60_000;

export function parseRunnerFleetProjection(
  value: unknown,
  binding?: Readonly<{ tenantId: string; projectId: string }>,
): RunnerFleetProjection {
  const body = exact(value, ["observedAt", "projectId", "runners", "schemaVersion", "tenantId"]);
  if (body.schemaVersion !== RUNNER_FLEET_PROJECTION_SCHEMA_VERSION
    || typeof body.tenantId !== "string" || !UUID.test(body.tenantId)
    || typeof body.projectId !== "string" || !UUID.test(body.projectId)
    || binding && (body.tenantId !== binding.tenantId || body.projectId !== binding.projectId)
    || typeof body.observedAt !== "string" || !Number.isFinite(Date.parse(body.observedAt))
    || !Array.isArray(body.runners) || body.runners.length > 3) invalid();
  const observedAt = new Date(body.observedAt).toISOString();
  const runners = body.runners.map((value) => parseRunner(value, observedAt));
  const platforms = runners.map((runner) => runner.platform);
  if (new Set(platforms).size !== platforms.length
    || JSON.stringify(platforms) !== JSON.stringify([...platforms].sort())) invalid();
  return Object.freeze({
    schemaVersion: RUNNER_FLEET_PROJECTION_SCHEMA_VERSION,
    tenantId: body.tenantId,
    projectId: body.projectId,
    observedAt,
    runners: Object.freeze(runners),
  });
}

export function runnerConnectivity(input: Readonly<{
  registrationState: RunnerRegistrationState;
  lastSeenAt: string;
  certificateNotAfter: string;
}>, observedAt: string): RunnerConnectivity {
  const observed = Date.parse(observedAt);
  const lastSeen = Date.parse(input.lastSeenAt);
  const certificateExpiry = Date.parse(input.certificateNotAfter);
  if (![observed, lastSeen, certificateExpiry].every(Number.isFinite)) invalid();
  if (input.registrationState === "DRAINING") return "DRAINING";
  if (input.registrationState === "QUARANTINED") return "QUARANTINED";
  if (input.registrationState === "OFFLINE" || certificateExpiry <= observed) return "OFFLINE";
  return lastSeen >= observed - FRESHNESS_MS && lastSeen <= observed + 5_000 ? "READY" : "STALE";
}

function parseRunner(value: unknown, observedAt: string): ProjectRunnerProjection {
  const item = exact(value, [
    "architecture", "attemptId", "capabilityDigest", "certificateNotAfter", "connectivity",
    "fencingToken", "lastSeenAt", "leaseExpiresAt", "leaseState", "platform", "registrationState",
    "runnerId", "updatedAt",
  ]);
  const platform = oneOf(item.platform, ["linux", "macos", "windows"] as const);
  const architecture = oneOf(item.architecture, ["arm64", "x86_64"] as const);
  const registrationState = oneOf(item.registrationState, ["DRAINING", "OFFLINE", "ONLINE", "QUARANTINED"] as const);
  const leaseState = oneOf(item.leaseState, ["EXPIRED", "FAILED", "INVALIDATED", "LEASED", "PASSED", "RUNNING"] as const);
  if (typeof item.runnerId !== "string" || !RUNNER_ID.test(item.runnerId)
    || typeof item.capabilityDigest !== "string" || !SHA256.test(item.capabilityDigest)
    || typeof item.attemptId !== "string" || !UUID.test(item.attemptId)
    || typeof item.fencingToken !== "string" || !POSITIVE_INTEGER.test(item.fencingToken)) invalid();
  const lastSeenAt = iso(item.lastSeenAt);
  const certificateNotAfter = iso(item.certificateNotAfter);
  const leaseExpiresAt = iso(item.leaseExpiresAt);
  const updatedAt = iso(item.updatedAt);
  const connectivity = runnerConnectivity({ registrationState, lastSeenAt, certificateNotAfter }, observedAt);
  if (item.connectivity !== connectivity) invalid();
  return Object.freeze({
    runnerId: item.runnerId,
    platform,
    architecture,
    capabilityDigest: item.capabilityDigest,
    registrationState,
    connectivity,
    lastSeenAt,
    certificateNotAfter,
    attemptId: item.attemptId,
    leaseState,
    fencingToken: item.fencingToken,
    leaseExpiresAt,
    updatedAt,
  });
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort())) invalid();
  return result;
}
function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) invalid();
  return value as T[number];
}
function iso(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid();
  return new Date(value).toISOString();
}
function invalid(): never { throw new Error("Runner fleet projection is invalid"); }
