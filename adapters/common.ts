import {
  collectRunDiagnostics,
  collectRunResult,
} from "../lib/agent/events";
import { assertPinnedModelId } from "../lib/agent/providers";
import { assertProfileConsistency } from "../lib/agent/profiles";
import type {
  AgentDiagnostics,
  AgentEvent,
  AgentProfileRevision,
  AgentRunResult,
  CancellationRequest,
  RunContext,
  RunHandle,
} from "../lib/agent/types";

const FORBIDDEN_ARGUMENTS = new Set([
  "--yolo",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "--sandbox-danger-full-access",
]);

export function assertAdapterInputs(
  expectedAgent: AgentProfileRevision["agent"],
  context: RunContext,
  profile: AgentProfileRevision,
): void {
  assertProfileConsistency(profile);
  if (profile.agent !== expectedAgent) throw new Error("Profile uses the wrong runtime adapter");
  if (!context.runRoot.startsWith("/") || context.runRoot.includes("/../")) {
    throw new Error("Run root must be an absolute normalized path");
  }
  if (!context.runTokenSecretRef) throw new Error("Run token SecretRef is required");
  for (const model of Object.values(profile.models)) assertPinnedModelId(model);
}

export function assertSafeArgv(args: readonly string[]): void {
  for (const arg of args) {
    const normalized = arg.toLowerCase().split("=")[0] ?? arg.toLowerCase();
    if (FORBIDDEN_ARGUMENTS.has(normalized) || normalized.includes("dangerously-skip")) {
      throw new Error(`Forbidden agent permission argument: ${arg}`);
    }
  }
}

export function runtimePath(runRoot: string, relative: string): string {
  if (
    !runRoot.startsWith("/") ||
    relative.startsWith("/") ||
    relative.split("/").includes("..")
  ) {
    throw new Error("Unsafe runtime path");
  }
  return `${runRoot.replace(/\/$/, "")}/${relative}`;
}

export function cancellation(handle: RunHandle): CancellationRequest {
  return Object.freeze({
    executorHandle: handle.executorHandle,
    signal: "SIGTERM",
    gracePeriodMs: 10_000,
    then: "SIGKILL",
  });
}

export function result(events: readonly AgentEvent[]): AgentRunResult {
  return collectRunResult(events);
}

export function diagnostics(
  handle: RunHandle,
  events: readonly AgentEvent[],
): AgentDiagnostics {
  return collectRunDiagnostics(handle, events);
}

export function assertWorkspace(workspace: string): void {
  if (!workspace.startsWith("/") || workspace.includes("/../")) {
    throw new Error("Workspace must be an absolute normalized path");
  }
}
