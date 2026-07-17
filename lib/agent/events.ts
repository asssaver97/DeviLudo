import type {
  AgentDiagnostics,
  AgentEvent,
  AgentEventType,
  AgentRunResult,
  RunHandle,
} from "./types";

type JsonObject = Record<string, unknown>;

export function parseCodexEvent(line: string, timestamp = new Date().toISOString()): AgentEvent | null {
  const raw = parseLine(line, timestamp);
  if (!raw) return null;
  if (isSyntheticWarning(raw)) return raw.syntheticWarning;

  const type = stringValue(raw.type) ?? "unknown";
  const item = objectValue(raw.item);
  const usage = objectValue(raw.usage) ?? objectValue(objectValue(raw.turn)?.usage);

  if (type === "thread.started") {
    return event("session", timestamp, {
      sessionId: stringValue(raw.thread_id),
      rawType: type,
    });
  }
  if (type === "turn.started") return event("turn", timestamp, { rawType: type });
  if (type === "turn.completed") {
    return event("completed", timestamp, {
      rawType: type,
      ...usageFields(usage),
    });
  }
  if (type === "turn.failed" || type === "error") {
    return event("failed", timestamp, {
      rawType: type,
      message: safeDiagnostic(raw.error ?? raw.message),
    });
  }
  if (type.includes("warning")) {
    return event("warning", timestamp, {
      rawType: type,
      message: safeDiagnostic(raw.message),
    });
  }

  if (type.startsWith("item.") && item) {
    const itemType = stringValue(item.type) ?? "item";
    const path =
      stringValue(item.path) ??
      stringValue(item.file_path) ??
      stringValue(objectValue(item.change)?.path);
    if (itemType.includes("file") || path) {
      return event("file_change", timestamp, {
        rawType: type,
        path: path ? safePath(path) : undefined,
        message: safeDiagnostic(item.status),
      });
    }
    return event("tool", timestamp, {
      rawType: type,
      toolName: itemType,
      message: safeDiagnostic(item.status),
    });
  }

  if (usage) return event("usage", timestamp, { rawType: type, ...usageFields(usage) });
  return event("turn", timestamp, { rawType: type });
}

export function parseClaudeEvent(line: string, timestamp = new Date().toISOString()): AgentEvent | null {
  const raw = parseLine(line, timestamp);
  if (!raw) return null;
  if (isSyntheticWarning(raw)) return raw.syntheticWarning;

  const type = stringValue(raw.type) ?? "unknown";
  const message = objectValue(raw.message);
  const content = arrayValue(message?.content);
  const toolUse = content.map(objectValue).find((block) => block?.type === "tool_use");

  if (type === "system") {
    return event("session", timestamp, {
      rawType: `${type}.${stringValue(raw.subtype) ?? "event"}`,
      sessionId: stringValue(raw.session_id),
    });
  }
  if (type === "result") {
    const failed = raw.is_error === true || stringValue(raw.subtype)?.includes("error");
    return event(failed ? "failed" : "completed", timestamp, {
      rawType: `${type}.${stringValue(raw.subtype) ?? "event"}`,
      sessionId: stringValue(raw.session_id),
      message: safeDiagnostic(raw.result ?? raw.error),
      costUsd: numberValue(raw.total_cost_usd),
      ...usageFields(objectValue(raw.usage)),
    });
  }
  if (type === "rate_limit_event" || type.includes("warning")) {
    return event("warning", timestamp, {
      rawType: type,
      message: safeDiagnostic(raw.message),
    });
  }
  if (toolUse) {
    const input = objectValue(toolUse.input);
    const toolName = stringValue(toolUse.name) ?? "tool";
    const path = stringValue(input?.file_path) ?? stringValue(input?.path);
    const fileTool = ["edit", "write", "multiedit", "notebookedit"].includes(
      toolName.toLowerCase(),
    );
    return event(fileTool ? "file_change" : "tool", timestamp, {
      rawType: type,
      toolName,
      path: path ? safePath(path) : undefined,
    });
  }
  if (type === "assistant" || type === "user" || type === "stream_event") {
    return event("turn", timestamp, { rawType: type });
  }
  return event("turn", timestamp, { rawType: type });
}

export function collectRunResult(events: readonly AgentEvent[]): AgentRunResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sessionId: string | undefined;
  let terminal: AgentEvent | undefined;
  const changedFiles = new Set<string>();
  const warnings: string[] = [];

  for (const current of events) {
    if (current.sessionId) sessionId = current.sessionId;
    inputTokens += current.inputTokens ?? 0;
    outputTokens += current.outputTokens ?? 0;
    costUsd += current.costUsd ?? 0;
    if (current.type === "file_change" && current.path) changedFiles.add(current.path);
    if (current.type === "warning" && current.message) warnings.push(current.message);
    if (current.type === "completed" || current.type === "failed") terminal = current;
  }

  return Object.freeze({
    status: terminal?.type === "completed" ? "completed" : "failed",
    sessionId,
    summary: terminal?.message,
    usage: Object.freeze({ inputTokens, outputTokens, costUsd }),
    changedFiles: Object.freeze([...changedFiles].sort()),
    warnings: Object.freeze(warnings),
  });
}

export function collectRunDiagnostics(
  _handle: RunHandle,
  events: readonly AgentEvent[],
): AgentDiagnostics {
  const messages = events
    .filter((current) => current.type === "warning" || current.type === "failed")
    .flatMap((current) => (current.message ? [current.message] : []));
  return Object.freeze({
    eventCount: events.length,
    warningCount: events.filter((current) => current.type === "warning").length,
    lastEventType: events.at(-1)?.type,
    messages: Object.freeze(messages),
  });
}

function parseLine(
  line: string,
  timestamp: string,
): JsonObject | { readonly syntheticWarning: AgentEvent } | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as JsonObject;
  } catch {
    return {
      syntheticWarning: event("warning", timestamp, {
        message: "Agent emitted a malformed JSON event; content was discarded",
        rawType: "adapter.parse_error",
      }),
    };
  }
}

function isSyntheticWarning(
  value: JsonObject | { readonly syntheticWarning: AgentEvent },
): value is { readonly syntheticWarning: AgentEvent } {
  return (
    "syntheticWarning" in value &&
    typeof value.syntheticWarning === "object" &&
    value.syntheticWarning !== null &&
    "type" in value.syntheticWarning
  );
}

function event(
  type: AgentEventType,
  timestamp: string,
  fields: Omit<AgentEvent, "type" | "timestamp">,
): AgentEvent {
  return Object.freeze({ type, timestamp, ...fields });
}

function usageFields(usage?: JsonObject): Pick<
  AgentEvent,
  "inputTokens" | "outputTokens" | "costUsd"
> {
  return {
    inputTokens:
      numberValue(usage?.input_tokens) ?? numberValue(usage?.inputTokens),
    outputTokens:
      numberValue(usage?.output_tokens) ?? numberValue(usage?.outputTokens),
    costUsd:
      numberValue(usage?.cost_usd) ?? numberValue(usage?.costUsd),
  };
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").slice(0, 500);
}

export function safeDiagnostic(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/\b(sk|api|key|token)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 2_000);
}
