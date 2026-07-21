import { createHash } from "node:crypto";
import { safeDiagnostic } from "./events";
import type {
  AgentEventType,
  AgentFailureDiagnostic,
  AgentFailureKind,
  AgentFailureStage,
} from "./types";
import type { ProcessDiagnostics } from "../../services/agent-worker/src/contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DIAGNOSTIC_ID = /^diag-[a-f0-9]{64}$/;
const SIGNAL = /^SIG[A-Z0-9]+$/;
const EVENT_TYPES = new Set<AgentEventType>([
  "session", "turn", "tool", "file_change", "usage", "warning", "completed", "failed",
]);
const STAGES = new Set<AgentFailureStage>([
  "PREPARING_WORKSPACE", "STARTING_RELAY", "STARTING_AGENT", "RUNNING_AGENT",
  "VALIDATING_RESULT", "BUILDING_CANDIDATE",
]);
const KINDS = new Set<AgentFailureKind>([
  "AGENT_REPORTED_FAILURE", "TIMEOUT", "CANCELLED", "RUNTIME_SETUP_FAILURE", "GUEST_VALIDATION_FAILURE",
]);

export function createAgentFailureDiagnostic(input: Readonly<{
  runId: string;
  attemptId: string;
  stage: AgentFailureStage;
  error: unknown;
  process: ProcessDiagnostics | null;
}>): AgentFailureDiagnostic {
  if (!UUID.test(input.runId) || !UUID.test(input.attemptId) || !STAGES.has(input.stage)) invalid();
  const process = input.process;
  const kind = failureKind(input.stage, process);
  const messages = sanitizedMessages([
    ...(process?.adapter.messages ?? []),
    safeExecutionError(input.error),
  ]);
  const core = Object.freeze({
    schemaVersion: "deviludo.agent-failure-diagnostic.v1" as const,
    runId: input.runId,
    attemptId: input.attemptId,
    kind,
    stage: input.stage,
    exitCode: process?.exitCode ?? null,
    signal: process?.signal ?? null,
    timedOut: process?.timedOut ?? false,
    cancelled: process?.cancelled ?? false,
    durationMs: process?.durationMs ?? 0,
    droppedJsonLines: process?.droppedJsonLines ?? 0,
    eventCount: process?.adapter.eventCount ?? 0,
    warningCount: process?.adapter.warningCount ?? 0,
    lastEventType: process?.adapter.lastEventType ?? null,
    messages,
  });
  const diagnosticId = `diag-${createHash("sha256").update(canonicalJson(core)).digest("hex")}`;
  return Object.freeze({ ...core, diagnosticId });
}

export function validateAgentFailureDiagnostic(value: unknown): AgentFailureDiagnostic {
  const body = record(value);
  const keys = ["schemaVersion", "diagnosticId", "runId", "attemptId", "kind", "stage", "exitCode", "signal",
    "timedOut", "cancelled", "durationMs", "droppedJsonLines", "eventCount", "warningCount", "lastEventType", "messages"];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(keys.sort())
    || body.schemaVersion !== "deviludo.agent-failure-diagnostic.v1"
    || typeof body.diagnosticId !== "string" || !DIAGNOSTIC_ID.test(body.diagnosticId)
    || typeof body.runId !== "string" || !UUID.test(body.runId)
    || typeof body.attemptId !== "string" || !UUID.test(body.attemptId)
    || typeof body.kind !== "string" || !KINDS.has(body.kind as AgentFailureKind)
    || typeof body.stage !== "string" || !STAGES.has(body.stage as AgentFailureStage)
    || body.exitCode !== null && (!Number.isSafeInteger(body.exitCode) || (body.exitCode as number) < -1 || (body.exitCode as number) > 255)
    || body.signal !== null && (typeof body.signal !== "string" || !SIGNAL.test(body.signal))
    || typeof body.timedOut !== "boolean" || typeof body.cancelled !== "boolean"
    || !boundedInteger(body.durationMs, 0, 7 * 24 * 60 * 60_000)
    || !boundedInteger(body.droppedJsonLines, 0, 1_000_000)
    || !boundedInteger(body.eventCount, 0, 10_000_000)
    || !boundedInteger(body.warningCount, 0, 10_000_000)
    || body.lastEventType !== null && (typeof body.lastEventType !== "string" || !EVENT_TYPES.has(body.lastEventType as AgentEventType))
    || !Array.isArray(body.messages) || body.messages.length > 8
    || body.messages.some((entry) => typeof entry !== "string" || !entry || entry.length > 2_000
      || safeDiagnostic(entry) !== entry)) invalid();
  const { diagnosticId, ...core } = body;
  const expected = `diag-${createHash("sha256").update(canonicalJson(core)).digest("hex")}`;
  if (diagnosticId !== expected) invalid();
  return Object.freeze({ ...body, messages: Object.freeze([...(body.messages as string[])]) }) as unknown as AgentFailureDiagnostic;
}

function failureKind(stage: AgentFailureStage, process: ProcessDiagnostics | null): AgentFailureKind {
  if (process?.timedOut) return "TIMEOUT";
  if (process?.cancelled) return "CANCELLED";
  if (process && (process.adapter.lastEventType === "failed" || process.exitCode !== 0)) return "AGENT_REPORTED_FAILURE";
  if (stage === "STARTING_RELAY" || stage === "STARTING_AGENT" || stage === "RUNNING_AGENT") return "RUNTIME_SETUP_FAILURE";
  return "GUEST_VALIDATION_FAILURE";
}

function sanitizedMessages(values: readonly string[]): readonly string[] {
  const messages = values.flatMap((value) => {
    const safe = safeDiagnostic(value)?.trim();
    return safe ? [safe] : [];
  });
  return Object.freeze([...new Set(messages)].slice(0, 8));
}

function safeExecutionError(error: unknown): string {
  if (!(error instanceof Error)) return "Isolated Agent execution failed";
  // Native validation errors are a closed vocabulary created by this guest.
  // Other thrown messages may originate in a dependency or upstream response,
  // so retain only their bounded class instead of copying arbitrary text.
  if (/^Native Agent microVM guest [A-Za-z0-9 ._-]{1,180} is invalid$/.test(error.message)) {
    return error.message;
  }
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name) ? error.name : "Error";
  return `Isolated Agent execution failed (${name})`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol"
    || typeof value === "number" && !Number.isFinite(value)) invalid();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}
function invalid(): never { throw new Error("Agent failure diagnostic is invalid"); }
