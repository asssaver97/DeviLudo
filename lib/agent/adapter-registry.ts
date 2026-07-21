import type { AgentKind } from "./types";
import { AGENT_REGISTRY } from "./registry";

/** Exact Adapter versions compiled into this control-plane release. */
export const BUILT_IN_ADAPTER_VERSIONS: Readonly<Record<AgentKind, string>> = Object.freeze({
  "claude-code": AGENT_REGISTRY["claude-code"].adapterVersion,
  "codex-cli": AGENT_REGISTRY["codex-cli"].adapterVersion,
});

export function builtInAdapterVersion(agent: AgentKind): string {
  return BUILT_IN_ADAPTER_VERSIONS[agent];
}

export function isBuiltInAdapterVersion(agent: AgentKind, version: string): boolean {
  return builtInAdapterVersion(agent) === version;
}

export interface AdapterCompatibility {
  readonly min: string;
  readonly maxExclusive: string;
}

const STABLE_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * V1 validates one exact compiled Adapter. It is represented as a half-open
 * compatibility interval so AgentVersion receipts can evolve to real ranges
 * without weakening today's exact binding.
 */
export function exactAdapterCompatibility(version: string): AdapterCompatibility {
  const match = STABLE_SEMVER.exec(version);
  if (!match) throw new Error("Adapter compatibility requires a stable exact SemVer");
  const nextPatch = Number(match[3]) + 1;
  if (!Number.isSafeInteger(nextPatch)) throw new Error("Adapter patch version is out of range");
  return Object.freeze({ min: version, maxExclusive: `${match[1]}.${match[2]}.${nextPatch}` });
}

export function isExactAdapterCompatibility(
  validatedAdapterVersion: string,
  compatibility: AdapterCompatibility,
): boolean {
  try {
    const expected = exactAdapterCompatibility(validatedAdapterVersion);
    return compatibility.min === expected.min && compatibility.maxExclusive === expected.maxExclusive;
  } catch {
    return false;
  }
}

export function isAdapterVersionAttested(
  requestedAdapterVersion: string,
  validatedAdapterVersion: string,
  compatibility: AdapterCompatibility,
): boolean {
  return requestedAdapterVersion === validatedAdapterVersion
    && isExactAdapterCompatibility(validatedAdapterVersion, compatibility);
}
