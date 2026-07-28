export type MacCapacityEvent = Readonly<{
  intent: Readonly<{ intentId: string; operationKey: string; desiredHosts: 0 | 1 }>;
  state: "REGISTERED" | "RELEASED" | "MANUAL_INTERVENTION_REQUIRED";
  activeOperationKey: string | null;
  hostId: string | null;
  instanceId: string | null;
  runnerId: string | null;
  allocatedAt: string | null;
  minimumReleaseAt: string | null;
  rollback: boolean;
}>;

export function parseMacCapacityEvent(value: string): MacCapacityEvent {
  if (typeof value !== "string" || value.length < 20 || value.length > 32_768 || /[\0]/.test(value)) invalid();
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
  const body = parsed as Record<string, unknown>;
  const intent = body.intent as Record<string, unknown> | undefined;
  const state = body.state;
  if (!intent || Array.isArray(intent)
    || !exactKeys(intent, ["desiredHosts", "intentId", "minimumReleaseAt", "operationKey", "requestedAt", "schemaVersion"])
    || intent.schemaVersion !== "deviludo.macos-capacity-intent.v1"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(String(intent.intentId ?? ""))
    || !/^capacity:[a-f0-9]{64}$/.test(String(intent.operationKey ?? ""))
    || ![0, 1].includes(intent.desiredHosts as number)
    || !optionalDate(intent.requestedAt)
    || !new Set(["REGISTERED", "RELEASED", "MANUAL_INTERVENTION_REQUIRED"]).has(String(state))) invalid();
  if (intent.desiredHosts === 1) {
    const requestedAt = optionalDate(intent.requestedAt);
    const intentReleaseAt = optionalDate(intent.minimumReleaseAt);
    if (!requestedAt || !intentReleaseAt || Date.parse(intentReleaseAt) < Date.parse(requestedAt) + 86_400_000) invalid();
  } else if (intent.minimumReleaseAt !== null) invalid();
  assertEventShape(body, state as MacCapacityEvent["state"]);
  const hostId = optional(body.hostId, /^h-[a-f0-9]{8,17}$/);
  const instanceId = optional(body.instanceId, /^i-[a-f0-9]{8,17}$/);
  const runnerId = optional(body.runnerId, /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/);
  const activeOperationKey = optional(body.activeOperationKey, /^capacity:[a-f0-9]{64}$/);
  const allocatedAt = optionalDate(body.allocatedAt);
  const minimumReleaseAt = optionalDate(body.minimumReleaseAt);
  if (state === "REGISTERED" && (!hostId || !instanceId || !runnerId || !allocatedAt || !minimumReleaseAt
    || Date.parse(minimumReleaseAt) < Date.parse(allocatedAt) + 86_400_000)) invalid();
  if (state === "MANUAL_INTERVENTION_REQUIRED" && !activeOperationKey) invalid();
  if (body.rollback !== undefined && typeof body.rollback !== "boolean") invalid();
  return Object.freeze({
    intent: Object.freeze({ intentId: String(intent.intentId), operationKey: String(intent.operationKey), desiredHosts: intent.desiredHosts as 0 | 1 }),
    state: state as MacCapacityEvent["state"], activeOperationKey, hostId, instanceId, runnerId, allocatedAt,
    minimumReleaseAt, rollback: body.rollback === true,
  });
}

function optional(value: unknown, shape: RegExp): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !shape.test(value)) invalid();
  return value;
}
function optionalDate(value: unknown): string | null {
  const date = optional(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  if (date && (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date)) invalid();
  return date;
}
function assertEventShape(body: Record<string, unknown>, state: MacCapacityEvent["state"]): void {
  if (state === "REGISTERED") {
    if (!exactKeys(body, ["allocatedAt", "checks", "exhausted", "hostId", "instanceId", "intent", "minimumReleaseAt", "registered", "runnerId", "state"])
      || body.registered !== true || body.exhausted !== false || !boundedCounter(body.checks, 1, 30)) invalid();
    return;
  }
  if (state === "MANUAL_INTERVENTION_REQUIRED") {
    if (!exactKeys(body, ["activeOperationKey", "checks", "drained", "exhausted", "hostId", "instanceId", "intent", "minimumReleaseAt", "state"])
      || body.drained !== false || body.exhausted !== true || !boundedCounter(body.checks, 1, 120)) invalid();
    return;
  }
  const release = exactKeys(body, ["activeOperationKey", "hostId", "instanceId", "intent", "minimumReleaseAt", "rollback", "state"])
    && typeof body.rollback === "boolean" && typeof body.activeOperationKey === "string" && optionalDate(body.minimumReleaseAt) !== null;
  const empty = exactKeys(body, ["checks", "drained", "intent", "minimumReleaseAt", "state"])
    && body.drained === true && boundedCounter(body.checks, 0, 120);
  const idempotent = exactKeys(body, ["idempotent", "intent", "rollback", "state"])
    && body.idempotent === true && typeof body.rollback === "boolean";
  if (!release && !empty && !idempotent) invalid();
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function boundedCounter(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
function invalid(): never { throw new Error("AWS Mac capacity event is invalid"); }
