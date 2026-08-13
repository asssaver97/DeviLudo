// Real desktop input protocol used by the guest GUI drivers.

export const INTERACTION_SCRIPT_VERSION = "3" as const;
export const GAME_CLIENT_WIDTH = 1280 as const;
export const GAME_CLIENT_HEIGHT = 720 as const;
export const MAX_INTERACTION_EVENTS = 200 as const;

export const CHECKPOINT_ROLES = ["START", "READY", "ACTION", "PROGRESS", "COMPLETION"] as const;
export type CheckpointRole = typeof CHECKPOINT_ROLES[number];

export const ACTION_INTENTS = [
  "START_SESSION",
  "NAVIGATION",
  "PRIMARY_ACTION",
  "FEATURE_ACTION",
  "COMPLETE_LOOP",
] as const;
export type ActionIntent = typeof ACTION_INTENTS[number];

export const PROBE_ASSERTION_OPERATORS = [
  "EQUALS",
  "NOT_EQUALS",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUALS",
  "LESS_THAN",
  "LESS_THAN_OR_EQUALS",
  "CONTAINS",
  "EXISTS",
  "CHANGED",
] as const;
export type ProbeAssertionOperator = typeof PROBE_ASSERTION_OPERATORS[number];

export type ProbeAssertion = Readonly<{
  source: "STATE" | "PROGRESS" | "CONTROL" | "SCENE";
  key?: string;
  targetId?: string;
  property?: "visible" | "enabled" | "text" | "value";
  operator: ProbeAssertionOperator;
  value?: string | number | boolean;
}>;

export type ActionMetadata = Readonly<{
  stepId: string;
  intent: ActionIntent;
  coversRequirementIds: readonly string[];
  postconditions: readonly ProbeAssertion[];
}>;

type TimedEvent = Readonly<{ delay_ms?: number }>;
type ActionEventBase = TimedEvent & ActionMetadata;

export type InteractionActionEvent =
  | (ActionEventBase & { type: "key_tap"; key: string })
  | (ActionEventBase & { type: "key_hold"; key: string; duration_ms: number })
  | (ActionEventBase & { type: "click"; targetId: string; button?: "LEFT" | "RIGHT" | "MIDDLE" })
  | (ActionEventBase & { type: "double_click"; targetId: string; button?: "LEFT" | "RIGHT" | "MIDDLE" })
  | (ActionEventBase & { type: "drag"; fromTargetId: string; toTargetId: string; duration_ms: number; button?: "LEFT" })
  | (ActionEventBase & { type: "scroll"; targetId: string; deltaY: number })
  | (ActionEventBase & { type: "text_input"; targetId: string; text: string });

export type InteractionEvent =
  | InteractionActionEvent
  | { type: "wait"; delay_ms: number }
  | {
    type: "checkpoint";
    id: string;
    role: CheckpointRole;
    delay_ms?: number;
    assertions: readonly ProbeAssertion[];
    visualMode: "DYNAMIC" | "STABLE_REPLAY";
    changeTargetId?: string;
    referenceImage?: string;
    threshold?: number;
    expectedOutput?: string;
  };

export type InteractionScript = Readonly<{
  version: typeof INTERACTION_SCRIPT_VERSION;
  events: readonly InteractionEvent[];
}>;

export function validateInteractionScript(value: unknown): value is InteractionScript {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const script = value as Record<string, unknown>;
  if (script.version !== INTERACTION_SCRIPT_VERSION) return false;
  if (!Array.isArray(script.events) || script.events.length < 1 || script.events.length > MAX_INTERACTION_EVENTS) return false;

  const checkpointIds = new Set<string>();
  const stepIds = new Set<string>();
  for (const event of script.events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const e = event as Record<string, unknown>;
    if (typeof e.type !== "string" || !validDelay(e.delay_ms, e.type === "wait")) return false;

    if (isActionEventType(e.type)) {
      if (!validateActionMetadata(e, stepIds)) return false;
      if (e.type === "key_tap" && !isSupportedKeyboardKey(e.key)) return false;
      if (e.type === "key_hold" && (!isSupportedKeyboardKey(e.key) || !validDuration(e.duration_ms))) return false;
      if (["click", "double_click", "scroll", "text_input"].includes(e.type) && !isStableId(e.targetId)) return false;
      if (["click", "double_click"].includes(e.type) && e.button !== undefined
        && !["LEFT", "RIGHT", "MIDDLE"].includes(String(e.button))) return false;
      if (e.type === "drag" && (!isStableId(e.fromTargetId) || !isStableId(e.toTargetId)
        || !validDuration(e.duration_ms) || (e.button !== undefined && e.button !== "LEFT"))) return false;
      if (e.type === "scroll" && (!Number.isInteger(e.deltaY) || Number(e.deltaY) === 0 || Math.abs(Number(e.deltaY)) > 10_000)) return false;
      if (e.type === "text_input" && (typeof e.text !== "string" || e.text.length < 1 || e.text.length > 1_000)) return false;
      continue;
    }

    if (e.type === "wait") continue;
    if (e.type !== "checkpoint"
      || typeof e.id !== "string" || !isStableId(e.id) || checkpointIds.has(e.id)
      || typeof e.role !== "string" || !CHECKPOINT_ROLES.includes(e.role as CheckpointRole)
      || !Array.isArray(e.assertions) || e.assertions.length < 1 || e.assertions.length > 32
      || !e.assertions.every(validateProbeAssertion)
      || !["DYNAMIC", "STABLE_REPLAY"].includes(String(e.visualMode))) return false;
    if (e.changeTargetId !== undefined && !isStableId(e.changeTargetId)) return false;
    if (e.visualMode === "DYNAMIC" && ["ACTION", "PROGRESS", "COMPLETION"].includes(String(e.role))
      && !isStableId(e.changeTargetId)) return false;
    checkpointIds.add(e.id);
    if (e.referenceImage !== undefined && !isSafeProjectPngPath(e.referenceImage)) return false;
    if (e.expectedOutput !== undefined
      && (typeof e.expectedOutput !== "string" || e.expectedOutput !== checkpointOutputMarker(e.id))) return false;
    if (e.threshold !== undefined
      && (typeof e.threshold !== "number" || !Number.isFinite(e.threshold) || e.threshold < 0 || e.threshold > 1)) return false;
  }
  return true;
}

export function validateProbeAssertion(value: unknown): value is ProbeAssertion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const assertion = value as Record<string, unknown>;
  if (!PROBE_ASSERTION_OPERATORS.includes(assertion.operator as ProbeAssertionOperator)
    || !["STATE", "PROGRESS", "CONTROL", "SCENE"].includes(String(assertion.source))) return false;
  if (assertion.source === "STATE" || assertion.source === "PROGRESS") {
    if (!isStablePath(assertion.key) || assertion.targetId !== undefined || assertion.property !== undefined) return false;
  } else if (assertion.source === "CONTROL") {
    if (!isStableId(assertion.targetId)
      || !["visible", "enabled", "text", "value"].includes(String(assertion.property))
      || assertion.key !== undefined) return false;
  } else if (assertion.key !== undefined || assertion.targetId !== undefined || assertion.property !== undefined) return false;
  const requiresValue = !["EXISTS", "CHANGED"].includes(String(assertion.operator));
  if (requiresValue !== Object.hasOwn(assertion, "value")) return false;
  return assertion.value === undefined || ["string", "number", "boolean"].includes(typeof assertion.value);
}

export function checkpointOutputMarker(checkpointId: unknown): string {
  return `DEVILUDO_E2E_CHECKPOINT:${String(checkpointId)}`;
}

export function isSupportedKeyboardKey(value: unknown): value is string {
  return typeof value === "string"
    && /^(?:KEY_)?(?:[A-Z0-9]|SPACE|ENTER|TAB|ESCAPE|LEFT|RIGHT|UP|DOWN|MINUS|EQUAL)$/.test(value);
}

export function interactionCheckpointCount(script: InteractionScript): number {
  return script.events.filter(event => event.type === "checkpoint").length;
}

export function interactionActionEvents(script: InteractionScript): readonly InteractionActionEvent[] {
  return script.events.filter((event): event is InteractionActionEvent => isActionEventType(event.type));
}

export function interactionHasUserAction(script: InteractionScript): boolean {
  return interactionActionEvents(script).length > 0;
}

export function isSafeProjectPngPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 5 && value.length <= 240
    && value.toLowerCase().endsWith(".png")
    && !value.startsWith("/") && !value.startsWith("res://")
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value)
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*\.png$/i.test(value);
}

function validateActionMetadata(event: Record<string, unknown>, stepIds: Set<string>): boolean {
  if (!isStableId(event.stepId) || stepIds.has(String(event.stepId))
    || !ACTION_INTENTS.includes(event.intent as ActionIntent)
    || !Array.isArray(event.coversRequirementIds)
    || event.coversRequirementIds.length > 500
    || event.coversRequirementIds.some(id => !isStableId(id))
    || new Set(event.coversRequirementIds).size !== event.coversRequirementIds.length
    || !Array.isArray(event.postconditions) || event.postconditions.length < 1 || event.postconditions.length > 32
    || !event.postconditions.every(validateProbeAssertion)) return false;
  stepIds.add(String(event.stepId));
  return true;
}

function isActionEventType(value: string): value is InteractionActionEvent["type"] {
  return ["key_tap", "key_hold", "click", "double_click", "drag", "scroll", "text_input"].includes(value);
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}

function isStablePath(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
}

function validDuration(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 300_000;
}

function validDelay(value: unknown, required: boolean): boolean {
  if (value === undefined) return !required;
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 300_000;
}
