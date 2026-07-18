import { createPublicKey, type KeyObject } from "node:crypto";
import { open } from "node:fs/promises";
import type { TargetPlatform } from "../../../lib/domain/types";
import { signCanonical, verifyCanonical } from "./canonical";
import type {
  RegisteredRunner,
  RunnerAdmissionPolicy,
  RunnerCapabilities,
  TlsRunnerIdentity,
} from "./contracts";
import type { RunnerTenantAssignmentPolicy } from "./postgres-ingress";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const RUNNER_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_VALIDITY_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const TARGET_PLATFORMS = new Set<TargetPlatform>(["windows", "linux", "macos"]);

export interface RunnerFleetEntry {
  readonly runnerId: string;
  readonly spiffeId: string;
  readonly certificateFingerprint: string;
  readonly capabilityDigest: string;
  readonly platform: TargetPlatform;
  readonly tenantIds: readonly string[];
  readonly steamClientConnectorIdentity: Readonly<{
    readonly spiffeId: string;
    readonly certificateFingerprint: string;
  }> | null;
}

export interface RunnerFleetClaims {
  readonly kind: "deviludo-runner-fleet";
  readonly version: 1;
  readonly revision: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly runners: readonly RunnerFleetEntry[];
}

export interface SignedRunnerFleetManifest {
  readonly keyId: string;
  readonly claims: RunnerFleetClaims;
  readonly signature: string;
}

export interface RunnerFleetManifestLoader {
  load(): Promise<unknown>;
}

/** Signs the exact fleet claims used by the Runner admission boundary. */
export function signRunnerFleetManifest(
  keyId: string,
  privateKey: KeyObject,
  claims: RunnerFleetClaims,
): SignedRunnerFleetManifest {
  if (!SAFE_ID.test(keyId) || privateKey.asymmetricKeyType !== "ed25519") invalid();
  validateClaims(claims, new Date(claims.issuedAt));
  return deepFreeze({ keyId, claims, signature: signCanonical(privateKey, claims) });
}

/** Reads an atomically replaceable manifest without following application input paths. */
export class FileRunnerFleetManifestLoader implements RunnerFleetManifestLoader {
  constructor(private readonly path: string) {
    if (!path.startsWith("/") || path.length > 4_096 || /\0/.test(path)) invalid();
  }

  async load(): Promise<unknown> {
    const file = await open(this.path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) invalid();
      return JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown;
    } finally {
      await file.close();
    }
  }
}

/**
 * One short-lived, signed source controls both certificate admission and
 * Runner-to-tenant assignment. It is reloaded and verified for every decision.
 */
export class SignedRunnerFleetPolicy implements RunnerAdmissionPolicy, RunnerTenantAssignmentPolicy {
  constructor(
    private readonly loader: RunnerFleetManifestLoader,
    private readonly publicKeys: ReadonlyMap<string, KeyObject>,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (publicKeys.size < 1 || publicKeys.size > 10) invalid();
    for (const [keyId, key] of publicKeys) {
      if (!SAFE_ID.test(keyId) || key.asymmetricKeyType !== "ed25519") invalid();
    }
  }

  async authorize(input: {
    readonly identity: TlsRunnerIdentity;
    readonly capabilities: RunnerCapabilities;
  } | {
    readonly identity: TlsRunnerIdentity;
    readonly runner: RegisteredRunner;
    readonly tenantId: string;
  }): Promise<boolean> {
    const claims = await this.#verifiedClaims();
    const runner = "capabilities" in input ? input.capabilities : input.runner;
    const entry = claims.runners.find((candidate) => candidate.runnerId === runner.runnerId);
    if (!entry || !matchesEntry(entry, input.identity, runner)) return false;
    return "tenantId" in input ? entry.tenantIds.includes(input.tenantId.toLowerCase()) : true;
  }

  /**
   * Authorizes a server-signed job at a secondary Runner service without
   * requiring that service to trust a mutable registration row.
   */
  async authorizeJob(input: {
    readonly identity: TlsRunnerIdentity;
    readonly runnerId: string;
    readonly platform: TargetPlatform;
    readonly capabilityDigest: string;
    readonly tenantId: string;
    readonly workload?: "runner" | "steam-client-connector";
  }): Promise<boolean> {
    const claims = await this.#verifiedClaims();
    const entry = claims.runners.find((candidate) => candidate.runnerId === input.runnerId);
    return !!entry
      && matchesJobEntry(entry, input.identity, input.workload ?? "runner", {
        runnerId: input.runnerId,
        platform: input.platform,
        capabilityDigest: input.capabilityDigest,
      })
      && entry.tenantIds.includes(input.tenantId.toLowerCase());
  }

  async probe(): Promise<void> {
    await this.#verifiedClaims();
  }

  async #verifiedClaims(): Promise<RunnerFleetClaims> {
    const envelope = parseEnvelope(await this.loader.load());
    const key = this.publicKeys.get(envelope.keyId);
    if (!key || !verifyCanonical(key, envelope.claims, envelope.signature)) {
      throw new Error("Runner fleet manifest signature is invalid");
    }
    validateClaims(envelope.claims, this.now());
    return envelope.claims;
  }
}

export function runnerFleetPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: () => Date = () => new Date(),
): SignedRunnerFleetPolicy {
  const manifestPath = requiredEnv(env, "DEVILUDO_RUNNER_FLEET_MANIFEST_FILE");
  const keyId = requiredEnv(env, "DEVILUDO_RUNNER_FLEET_KEY_ID");
  const publicKey = createPublicKey(requiredEnv(env, "DEVILUDO_RUNNER_FLEET_PUBLIC_KEY"));
  return new SignedRunnerFleetPolicy(
    new FileRunnerFleetManifestLoader(manifestPath),
    new Map([[keyId, publicKey]]),
    now,
  );
}

function parseEnvelope(value: unknown): SignedRunnerFleetManifest {
  const envelope = record(value);
  exactKeys(envelope, ["keyId", "claims", "signature"]);
  if (typeof envelope.keyId !== "string" || !SAFE_ID.test(envelope.keyId)
    || typeof envelope.signature !== "string" || envelope.signature.length < 40 || envelope.signature.length > 512) invalid();
  const claims = record(envelope.claims);
  return { keyId: envelope.keyId, claims: claims as unknown as RunnerFleetClaims, signature: envelope.signature };
}

function validateClaims(claims: RunnerFleetClaims, at: Date): void {
  const body = record(claims);
  exactKeys(body, ["kind", "version", "revision", "issuedAt", "expiresAt", "runners"]);
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  if (claims.kind !== "deviludo-runner-fleet" || claims.version !== 1
    || !Number.isSafeInteger(claims.revision) || claims.revision < 1
    || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(at.getTime())
    || issuedAt > at.getTime() + CLOCK_SKEW_MS || expiresAt <= at.getTime()
    || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS
    || !Array.isArray(claims.runners) || claims.runners.length > 1_000) invalid();
  let previousRunnerId = "";
  for (const entry of claims.runners) {
    const candidate = record(entry);
    exactKeys(candidate, [
      "runnerId", "spiffeId", "certificateFingerprint", "capabilityDigest", "platform", "tenantIds",
      "steamClientConnectorIdentity",
    ]);
    if (!RUNNER_ID.test(entry.runnerId) || entry.runnerId <= previousRunnerId
      || !validSpiffeId(entry.spiffeId) || !SHA256.test(entry.certificateFingerprint)
      || !SHA256.test(entry.capabilityDigest) || !TARGET_PLATFORMS.has(entry.platform)
      || !Array.isArray(entry.tenantIds) || entry.tenantIds.length > 10_000) invalid();
    if (entry.steamClientConnectorIdentity !== null) {
      const connector = record(entry.steamClientConnectorIdentity);
      exactKeys(connector, ["spiffeId", "certificateFingerprint"]);
      if (!validSpiffeId(entry.steamClientConnectorIdentity.spiffeId)
        || !SHA256.test(entry.steamClientConnectorIdentity.certificateFingerprint)
        || (entry.steamClientConnectorIdentity.spiffeId === entry.spiffeId
          && entry.steamClientConnectorIdentity.certificateFingerprint === entry.certificateFingerprint)) invalid();
    }
    previousRunnerId = entry.runnerId;
    let previousTenant = "";
    for (const tenantId of entry.tenantIds) {
      const normalized = typeof tenantId === "string" ? tenantId.toLowerCase() : "";
      if (!UUID.test(normalized) || normalized <= previousTenant || tenantId !== normalized) invalid();
      previousTenant = normalized;
    }
  }
}

function matchesEntry(
  entry: RunnerFleetEntry,
  identity: TlsRunnerIdentity,
  runner: Pick<RunnerCapabilities, "runnerId" | "platform" | "capabilityDigest">,
): boolean {
  return entry.runnerId === runner.runnerId
    && entry.spiffeId === identity.spiffeId
    && entry.certificateFingerprint === identity.certificateFingerprint
    && entry.capabilityDigest === runner.capabilityDigest
    && entry.platform === runner.platform;
}

function matchesJobEntry(
  entry: RunnerFleetEntry,
  identity: TlsRunnerIdentity,
  workload: "runner" | "steam-client-connector",
  runner: Pick<RunnerCapabilities, "runnerId" | "platform" | "capabilityDigest">,
): boolean {
  const identityMatches = workload === "runner"
    ? entry.spiffeId === identity.spiffeId && entry.certificateFingerprint === identity.certificateFingerprint
    : entry.steamClientConnectorIdentity !== null
      && entry.steamClientConnectorIdentity.spiffeId === identity.spiffeId
      && entry.steamClientConnectorIdentity.certificateFingerprint === identity.certificateFingerprint;
  return identityMatches
    && entry.runnerId === runner.runnerId
    && entry.capabilityDigest === runner.capabilityDigest
    && entry.platform === runner.platform;
}

function validSpiffeId(value: string): boolean {
  try {
    const url = new URL(value);
    return value.length <= 512 && url.protocol === "spiffe:" && !!url.hostname
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(): never {
  throw new Error("Runner fleet manifest is invalid");
}
