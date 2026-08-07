// Input simulation protocol for interactive E2E tests

export const INTERACTION_SCRIPT_VERSION = "1" as const;

export type InteractionEvent =
  | { type: "key_press"; key: string; delay_ms?: number }
  | { type: "key_release"; key: string; delay_ms?: number }
  | { type: "mouse_move"; x: number; y: number; delay_ms?: number }
  | { type: "mouse_click"; button: "LEFT" | "RIGHT" | "MIDDLE"; delay_ms?: number }
  | { type: "wait"; delay_ms: number };

export type InteractionScript = Readonly<{
  version: typeof INTERACTION_SCRIPT_VERSION;
  events: readonly InteractionEvent[];
}>;

export function validateInteractionScript(value: unknown): value is InteractionScript {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const script = value as Record<string, unknown>;
  if (script.version !== INTERACTION_SCRIPT_VERSION) return false;
  if (!Array.isArray(script.events)) return false;

  return script.events.every(event => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const e = event as Record<string, unknown>;

    if (typeof e.type !== "string") return false;

    switch (e.type) {
      case "key_press":
      case "key_release":
        return typeof e.key === "string" && (e.delay_ms === undefined || typeof e.delay_ms === "number");
      case "mouse_move":
        return typeof e.x === "number" && typeof e.y === "number" && (e.delay_ms === undefined || typeof e.delay_ms === "number");
      case "mouse_click":
        return typeof e.button === "string" && ["LEFT", "RIGHT", "MIDDLE"].includes(e.button) && (e.delay_ms === undefined || typeof e.delay_ms === "number");
      case "wait":
        return typeof e.delay_ms === "number";
      default:
        return false;
    }
  });
}
