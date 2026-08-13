import {
  assertPoolOperatingSystem,
  expectedOperatingSystem,
  type ServerOperatingSystem,
  type ServerPoolKind,
} from "./server-pools";

export const JOB_KINDS = [
  "AGENT_GENERATION",
  "PROJECT_DOCUMENT_MAINTENANCE",
  "ARTIFACT_BUILD",
  "STEAM_PUBLISH",
  "E2E_TEST",
  "ARTIFACT_SIGN",
  "STEAM_CLEAN_INSTALL",
] as const;

export type JobKind = typeof JOB_KINDS[number];
export type CoreJobKind = Extract<JobKind, "AGENT_GENERATION" | "PROJECT_DOCUMENT_MAINTENANCE" | "ARTIFACT_BUILD" | "STEAM_PUBLISH">;
export type E2eJobKind = "E2E_TEST";

const E2E_POOL_BY_OS: Readonly<Record<ServerOperatingSystem, ServerPoolKind>> = Object.freeze({
  linux: "E2E_LINUX",
  windows: "E2E_WINDOWS",
  macos: "E2E_MACOS",
});

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

export function routeJob(kind: JobKind, targetOperatingSystem?: ServerOperatingSystem): ServerPoolKind {
  if (kind === "ARTIFACT_SIGN" || kind === "STEAM_CLEAN_INSTALL") {
    throw new Error(`${kind} is a retired historical job kind`);
  }
  if (kind === "AGENT_GENERATION" || kind === "PROJECT_DOCUMENT_MAINTENANCE" || kind === "ARTIFACT_BUILD" || kind === "STEAM_PUBLISH") {
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
  if (kind === "ARTIFACT_SIGN" || kind === "STEAM_CLEAN_INSTALL") {
    throw new Error(`${kind} is a retired historical job kind`);
  }
  if (kind === "E2E_TEST") return Object.freeze(["GAME_RUNTIME", "TRUSTED_REIMAGE"]);
  if (kind === "AGENT_GENERATION") return Object.freeze(["MICROVM", "NETWORK_POLICY"]);
  if (kind === "PROJECT_DOCUMENT_MAINTENANCE") return Object.freeze(["MICROVM", "NETWORK_POLICY"]);
  if (kind === "ARTIFACT_BUILD") return Object.freeze(["RESTRICTED_CONTAINER", "BUILD_TOOLCHAIN"]);
  return Object.freeze(["RESTRICTED_CONTAINER", "STEAMCMD"]);
}

export function isExclusiveJob(kind: JobKind): boolean {
  return kind === "E2E_TEST";
}

export function poolOperatingSystem(poolKind: ServerPoolKind): ServerOperatingSystem {
  return expectedOperatingSystem(poolKind);
}
