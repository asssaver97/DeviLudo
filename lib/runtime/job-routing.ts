import {
  assertPoolOperatingSystem,
  expectedOperatingSystem,
  type ServerOperatingSystem,
  type ServerPoolKind,
} from "./server-pools";

export const JOB_KINDS = [
  "AGENT_TURN",
  "BUILD",
  "E2E_PLATFORM_RUN",
  "STEAM_PUBLISH",
] as const;

export type JobKind = typeof JOB_KINDS[number];
export type CoreJobKind = Extract<JobKind, "AGENT_TURN" | "BUILD" | "STEAM_PUBLISH">;
export type E2eJobKind = "E2E_PLATFORM_RUN";

const E2E_POOL_BY_OS: Readonly<Record<ServerOperatingSystem, ServerPoolKind>> = Object.freeze({
  linux: "E2E_LINUX",
  windows: "E2E_WINDOWS",
  macos: "E2E_MACOS",
});

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

export function routeJob(kind: JobKind, targetOperatingSystem?: ServerOperatingSystem): ServerPoolKind {
  if (kind === "AGENT_TURN" || kind === "BUILD" || kind === "STEAM_PUBLISH") {
    if (targetOperatingSystem !== undefined) throw new Error(`${kind} cannot target an E2E operating system`);
    return "CORE";
  }
  if (targetOperatingSystem === undefined) throw new Error(`${kind} requires a target operating system`);
  return E2E_POOL_BY_OS[targetOperatingSystem];
}

export function assertJobPlacement(input: Readonly<{
  kind: JobKind;
  poolKind: ServerPoolKind;
  targetOperatingSystem?: ServerOperatingSystem;
}>): void {
  const expected = routeJob(input.kind, input.targetOperatingSystem);
  if (input.poolKind !== expected) throw new Error(`${input.kind} must run in ${expected}`);
  if (input.targetOperatingSystem) assertPoolOperatingSystem(input.poolKind, input.targetOperatingSystem);
}

export function jobCapabilities(kind: JobKind): readonly string[] {
  if (kind === "E2E_PLATFORM_RUN") return Object.freeze(["GAME_RUNTIME", "TRUSTED_REIMAGE"]);
  if (kind === "AGENT_TURN") return Object.freeze(["PROJECT_RUNTIME", "ROLE_SCOPED_MCP"]);
  if (kind === "BUILD") return Object.freeze(["RESTRICTED_CONTAINER", "BUILD_TOOLCHAIN"]);
  return Object.freeze(["RESTRICTED_CONTAINER", "STEAMCMD"]);
}

export function isExclusiveJob(kind: JobKind): boolean {
  return kind === "E2E_PLATFORM_RUN";
}

export function poolOperatingSystem(poolKind: ServerPoolKind): ServerOperatingSystem {
  return expectedOperatingSystem(poolKind);
}
