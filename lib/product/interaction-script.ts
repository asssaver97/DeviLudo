// Real desktop input protocol used by the guest GUI drivers.

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
  | (ActionEventBase & { type: "text_input"; targetId: string; text: string })
  | (ActionEventBase & { type: "gamepad_button_tap"; button: GamepadButton })
  | (ActionEventBase & { type: "gamepad_button_hold"; button: GamepadButton; duration_ms: number })
  | (ActionEventBase & { type: "gamepad_axis"; axis: GamepadAxis; value: number; duration_ms?: number })
  | (ActionEventBase & { type: "gamepad_trigger"; trigger: "LEFT" | "RIGHT"; value: number; duration_ms?: number })
  | (ActionEventBase & { type: "gamepad_release_all" });

export const GAMEPAD_BUTTONS = [
  "A", "B", "X", "Y", "BACK", "GUIDE", "START", "LEFT_STICK", "RIGHT_STICK",
  "LEFT_SHOULDER", "RIGHT_SHOULDER", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT",
] as const;
export type GamepadButton = typeof GAMEPAD_BUTTONS[number];
export const GAMEPAD_AXES = ["LEFT_X", "LEFT_Y", "RIGHT_X", "RIGHT_Y"] as const;
export type GamepadAxis = typeof GAMEPAD_AXES[number];

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
  events: readonly InteractionEvent[];
}>;

export const CORE_START_ASSERTIONS = Object.freeze([
  Object.freeze({ source: "STATE", key: "screen_mode", operator: "EQUALS", value: "MENU" }),
  Object.freeze({ source: "STATE", key: "session_active", operator: "EQUALS", value: false }),
  Object.freeze({ source: "STATE", key: "gameplay_input_enabled", operator: "EQUALS", value: false }),
  Object.freeze({ source: "STATE", key: "blocking_layer_count", operator: "EQUALS", value: 0 }),
] as const satisfies readonly ProbeAssertion[]);

export const CORE_READY_ASSERTIONS = Object.freeze([
  Object.freeze({ source: "STATE", key: "screen_mode", operator: "EQUALS", value: "PLAYING" }),
  Object.freeze({ source: "STATE", key: "session_active", operator: "EQUALS", value: true }),
  Object.freeze({ source: "STATE", key: "gameplay_input_enabled", operator: "EQUALS", value: true }),
  Object.freeze({ source: "STATE", key: "blocking_layer_count", operator: "EQUALS", value: 0 }),
] as const satisfies readonly ProbeAssertion[]);

export function validateInteractionScript(value: unknown): value is InteractionScript {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const script = value as Record<string, unknown>;
  if (Object.hasOwn(script, "version") || Object.hasOwn(script, "schemaVersion")
    || !Array.isArray(script.events) || script.events.length < 1 || script.events.length > MAX_INTERACTION_EVENTS) return false;

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
      if (["gamepad_button_tap", "gamepad_button_hold"].includes(e.type)
        && !GAMEPAD_BUTTONS.includes(e.button as GamepadButton)) return false;
      if (e.type === "gamepad_button_hold" && !validDuration(e.duration_ms)) return false;
      if (e.type === "gamepad_axis" && (!GAMEPAD_AXES.includes(e.axis as GamepadAxis)
        || !validUnitInput(e.value) || (e.duration_ms !== undefined && !validDuration(e.duration_ms)))) return false;
      if (e.type === "gamepad_trigger" && (!['LEFT', 'RIGHT'].includes(String(e.trigger))
        || !validTriggerInput(e.value) || (e.duration_ms !== undefined && !validDuration(e.duration_ms)))) return false;
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

/**
 * A core journey is a lifecycle proof, not a bag of conveniently named
 * checkpoints. This deliberately fixes the event order and the common Probe
 * state that every shipped game must expose. It prevents a menu drawn over an
 * already-running game from passing merely because both states exist at some
 * point in the script.
 */
export function validateCoreJourneyLifecycle(script: InteractionScript): boolean {
  const events = script.events.filter(event => event.type !== "wait");
  const indexes = (role: CheckpointRole) => events
    .map((event, index) => event.type === "checkpoint" && event.role === role ? index : -1)
    .filter(index => index >= 0);
  const starts = indexes("START");
  const ready = indexes("READY");
  const progress = indexes("PROGRESS");
  const completion = indexes("COMPLETION");
  if (starts.length !== 1 || ready.length !== 1 || progress.length !== 1 || completion.length !== 1
    || starts[0] !== 0) return false;

  const startEvent = events[starts[0]!] as Extract<InteractionEvent, { type: "checkpoint" }>;
  const readyEvent = events[ready[0]!] as Extract<InteractionEvent, { type: "checkpoint" }>;
  if (startEvent.visualMode !== "STABLE_REPLAY" || readyEvent.visualMode !== "STABLE_REPLAY"
    || !containsAssertions(startEvent.assertions, CORE_START_ASSERTIONS)
    || !containsAssertions(readyEvent.assertions, CORE_READY_ASSERTIONS)) return false;

  const actions = events
    .map((event, index) => isActionEventType(event.type) ? { event: event as InteractionActionEvent, index } : null)
    .filter((entry): entry is { event: InteractionActionEvent; index: number } => entry !== null);
  const startActions = actions.filter(entry => entry.event.intent === "START_SESSION");
  const primaryActions = actions.filter(entry => entry.event.intent === "PRIMARY_ACTION");
  const completeActions = actions.filter(entry => entry.event.intent === "COMPLETE_LOOP");
  if (startActions.length !== 1 || primaryActions.length < 1 || completeActions.length < 1) return false;
  const startAction = startActions[0]!;
  const primary = primaryActions[0]!;
  const complete = completeActions.at(-1)!;
  if (!(starts[0]! < startAction.index && startAction.index < ready[0]!
    && ready[0]! < primary.index && primary.index < progress[0]!
    && progress[0]! < complete.index && complete.index < completion[0]!)) return false;
  if (actions.some(entry => entry.index < startAction.index && entry.event.intent !== "NAVIGATION")) return false;
  if (actions.some(entry => entry.index > startAction.index && entry.index < ready[0]!)) return false;
  return containsAssertions(startAction.event.postconditions, CORE_READY_ASSERTIONS);
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
  return [
    "key_tap", "key_hold", "click", "double_click", "drag", "scroll", "text_input",
    "gamepad_button_tap", "gamepad_button_hold", "gamepad_axis", "gamepad_trigger", "gamepad_release_all",
  ].includes(value);
}

function containsAssertions(actual: readonly ProbeAssertion[], required: readonly ProbeAssertion[]): boolean {
  return required.every(expected => actual.some(candidate => candidate.source === expected.source
    && candidate.key === expected.key && candidate.targetId === expected.targetId
    && candidate.property === expected.property && candidate.operator === expected.operator
    && candidate.value === expected.value));
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

function validUnitInput(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

function validTriggerInput(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validDelay(value: unknown, required: boolean): boolean {
  if (value === undefined) return !required;
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 300_000;
}
