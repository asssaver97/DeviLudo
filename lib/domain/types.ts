export type ISODateTime = string;
export type Sha256 = string;
export type EntityId = string;

export const AGENT_KINDS = ["claude-code", "codex-cli"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const TARGET_PLATFORMS = ["windows", "linux", "macos"] as const;
export type TargetPlatform = (typeof TARGET_PLATFORMS)[number];

export type ActorType = "USER" | "ADMIN" | "SERVICE" | "RUNNER";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** Freeze a JSON-like aggregate so callers cannot mutate a locked run in memory. */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value as DeepReadonly<T>;
}

export function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort()) as readonly T[];
}

export function assertSha256(value: string, field: string): asserts value is Sha256 {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${field} must be a 64-character SHA-256 hex digest`);
  }
}

export function assertGitSha(value: string): void {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error("commitSha must be a full 40-character Git SHA");
  }
}
