// Real desktop input protocol used by the guest GUI drivers.

export const INTERACTION_SCRIPT_VERSION = "2" as const;
export const GAME_CLIENT_WIDTH = 1280 as const;
export const GAME_CLIENT_HEIGHT = 720 as const;
export const MAX_INTERACTION_EVENTS = 200 as const;

export const CHECKPOINT_ROLES = ["START", "KEY_STATE", "COMPLETION"] as const;
export type CheckpointRole = typeof CHECKPOINT_ROLES[number];

export type InteractionEvent =
  | { type: "key_press"; key: string; delay_ms?: number }
  | { type: "key_release"; key: string; delay_ms?: number }
  | { type: "mouse_move"; x: number; y: number; delay_ms?: number }
  | { type: "mouse_click"; button: "LEFT" | "RIGHT" | "MIDDLE"; delay_ms?: number }
  | { type: "wait"; delay_ms: number }
  | {
    type: "checkpoint";
    id: string;
    role: CheckpointRole;
    delay_ms?: number;
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
  for (const event of script.events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const e = event as Record<string, unknown>;
    if (typeof e.type !== "string" || !validDelay(e.delay_ms, e.type === "wait")) return false;

    switch (e.type) {
      case "key_press":
      case "key_release":
        if (!isSupportedKeyboardKey(e.key)) return false;
        break;
      case "mouse_move":
        if (!Number.isInteger(e.x) || !Number.isInteger(e.y)
          || Number(e.x) < 0 || Number(e.x) >= GAME_CLIENT_WIDTH
          || Number(e.y) < 0 || Number(e.y) >= GAME_CLIENT_HEIGHT) return false;
        break;
      case "mouse_click":
        if (typeof e.button !== "string" || !["LEFT", "RIGHT", "MIDDLE"].includes(e.button)) return false;
        break;
      case "wait":
        break;
      case "checkpoint": {
        if (typeof e.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(e.id)
          || typeof e.role !== "string" || !CHECKPOINT_ROLES.includes(e.role as CheckpointRole)
          || checkpointIds.has(e.id)) return false;
        checkpointIds.add(e.id);
        if (e.referenceImage !== undefined && !isSafeProjectPngPath(e.referenceImage)) return false;
        if (e.expectedOutput !== undefined
          && (typeof e.expectedOutput !== "string" || e.expectedOutput !== checkpointOutputMarker(e.id))) return false;
        if (e.threshold !== undefined
          && (typeof e.threshold !== "number" || !Number.isFinite(e.threshold) || e.threshold < 0 || e.threshold > 1)) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
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

export function interactionHasUserAction(script: InteractionScript): boolean {
  return script.events.some(event => event.type === "key_press" || event.type === "mouse_click");
}

export function isSafeProjectPngPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 5 && value.length <= 240
    && value.toLowerCase().endsWith(".png")
    && !value.startsWith("/") && !value.startsWith("res://")
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value)
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*\.png$/i.test(value);
}

function validDelay(value: unknown, required: boolean): boolean {
  if (value === undefined) return !required;
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 300_000;
}
