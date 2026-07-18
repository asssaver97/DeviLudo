import type { KeyObject } from "node:crypto";
import type { TargetPlatform } from "../../../lib/domain/types";
import { verifyCanonical } from "../../runner-control/src/canonical";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const RUNNER_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface SteamNativeBridgeClaims {
  readonly kind: "deviludo-steam-native-bridge";
  readonly version: 1;
  readonly revision: number;
  readonly runnerId: string;
  readonly platform: TargetPlatform;
  readonly connectorVersion: string;
  readonly bridgeVersion: string;
  readonly controllerContractVersion: 1;
  readonly binaryDigest: string;
  readonly automationPolicyDigest: string;
  readonly supplyChainEvidenceDigest: string;
  readonly builtAt: string;
}

export interface SignedSteamNativeBridgeManifest {
  readonly keyId: string;
  readonly claims: SteamNativeBridgeClaims;
  readonly signature: string;
}

/** Verifies the immutable bridge artifact identity before the executable is ever probed. */
export function verifySignedSteamNativeBridgeManifest(
  value: unknown,
  options: Readonly<{
    keyId: string;
    publicKey: KeyObject;
    runnerId: string;
    platform: TargetPlatform;
    connectorVersion: string;
    now?: Date;
  }>,
): SteamNativeBridgeClaims {
  if (!SAFE_ID.test(options.keyId) || options.publicKey.asymmetricKeyType !== "ed25519"
    || !RUNNER_ID.test(options.runnerId) || !fixedVersion(options.connectorVersion)) invalid();
  const envelope = record(value);
  exactKeys(envelope, ["keyId", "claims", "signature"]);
  const claims = record(envelope.claims) as unknown as SteamNativeBridgeClaims;
  if (envelope.keyId !== options.keyId || typeof envelope.signature !== "string"
    || envelope.signature.length < 40 || envelope.signature.length > 512
    || !verifyCanonical(options.publicKey, claims, envelope.signature)) invalid();
  const body = record(claims);
  exactKeys(body, [
    "kind", "version", "revision", "runnerId", "platform", "connectorVersion", "bridgeVersion",
    "controllerContractVersion", "binaryDigest", "automationPolicyDigest", "supplyChainEvidenceDigest", "builtAt",
  ]);
  const builtAt = Date.parse(claims.builtAt);
  const now = options.now ?? new Date();
  if (claims.kind !== "deviludo-steam-native-bridge" || claims.version !== 1
    || !Number.isSafeInteger(claims.revision) || claims.revision < 1
    || claims.runnerId !== options.runnerId || claims.platform !== options.platform
    || claims.connectorVersion !== options.connectorVersion || !fixedVersion(claims.bridgeVersion)
    || claims.controllerContractVersion !== 1 || !SHA256.test(claims.binaryDigest)
    || !SHA256.test(claims.automationPolicyDigest) || !SHA256.test(claims.supplyChainEvidenceDigest)
    || !Number.isFinite(builtAt) || !Number.isFinite(now.getTime())
    || builtAt > now.getTime() + MAX_CLOCK_SKEW_MS) invalid();
  return deepFreeze({ ...claims });
}

function fixedVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}

function deepFreeze<T>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return value;
}

function invalid(): never { throw new Error("Steam native bridge manifest is invalid"); }
