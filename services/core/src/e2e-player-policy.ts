import { createHash } from "node:crypto";

export const PLAYER_POLICY_STATUSES = ["CONTINUE", "GOAL_REACHED", "UNRECOVERABLE"] as const;
export const MAX_PLAYER_POLICY_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_PLAYER_POLICY_REQUEST_BYTES = 6 * 1024 * 1024;
export type PlayerPolicyStatus = typeof PLAYER_POLICY_STATUSES[number];

export type PlayerPolicyAction = Readonly<Record<string, unknown> & { type: string }>;
export type PlayerPolicyDecision = Readonly<{
  screenIntegrity: "PASS" | "PRODUCT_DEFECT";
  screenIntegrityReason: string;
  status: PlayerPolicyStatus;
  observation: string;
  rationale: string;
  actions: readonly PlayerPolicyAction[];
}>;

export type PlayerPolicyRequest = Readonly<{
  rolloutIndex: number;
  decisionIndex: number;
  screenshotBase64: string;
  screenshotSha256: string;
  goal: string;
  allowedActions: readonly ("KEYBOARD" | "POINTER" | "GAMEPAD")[];
  history: readonly Readonly<{
    decisionIndex: number;
    observation: string;
    actions: readonly PlayerPolicyAction[];
    result: string;
  }>[];
  recovery: boolean;
}>;

export function playerPolicyIdempotencyInput(request: PlayerPolicyRequest) {
  return Object.freeze({ goal: request.goal, allowedActions: request.allowedActions });
}

export function parsePlayerPolicyRequest(value: unknown): PlayerPolicyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Player policy request must be an object");
  const request = value as Record<string, unknown>;
  if (!Number.isInteger(request.rolloutIndex) || Number(request.rolloutIndex) < 0 || Number(request.rolloutIndex) > 2
    || !Number.isInteger(request.decisionIndex) || Number(request.decisionIndex) < 0 || Number(request.decisionIndex) > 39
    || typeof request.screenshotBase64 !== "string" || request.screenshotBase64.length < 16
    || request.screenshotBase64.length > Math.ceil(MAX_PLAYER_POLICY_SCREENSHOT_BYTES * 4 / 3) + 4
    || typeof request.screenshotSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(request.screenshotSha256)
    || digestBase64(request.screenshotBase64) !== request.screenshotSha256
    || typeof request.goal !== "string" || request.goal.trim().length < 10 || request.goal.length > 4_000
    || !Array.isArray(request.allowedActions) || request.allowedActions.length < 1
    || request.allowedActions.some(action => !["KEYBOARD", "POINTER", "GAMEPAD"].includes(String(action)))
    || new Set(request.allowedActions).size !== request.allowedActions.length
    || !Array.isArray(request.history) || request.history.length > 6
    || typeof request.recovery !== "boolean") throw invalid("Player policy request is invalid");
  const history = request.history.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid("Player policy history is invalid");
    const record = item as Record<string, unknown>;
    if (!Number.isInteger(record.decisionIndex) || typeof record.observation !== "string" || record.observation.length > 500
      || typeof record.result !== "string" || record.result.length > 500 || !Array.isArray(record.actions) || record.actions.length > 4) {
      throw invalid("Player policy history is invalid");
    }
    const actions = record.actions.map(action => {
      try { return validatePolicyAction(action, request.allowedActions as readonly string[]); }
      catch { throw invalid("Player policy history contains an unsafe action"); }
    });
    return Object.freeze({
      decisionIndex: Number(record.decisionIndex),
      observation: record.observation,
      result: record.result,
      actions: Object.freeze(actions),
    });
  });
  if (history.some((item, index) => item.decisionIndex >= Number(request.decisionIndex)
    || (index > 0 && item.decisionIndex <= history[index - 1]!.decisionIndex))) {
    throw invalid("Player policy history order is invalid");
  }
  return Object.freeze({
    rolloutIndex: Number(request.rolloutIndex),
    decisionIndex: Number(request.decisionIndex),
    screenshotBase64: request.screenshotBase64,
    screenshotSha256: request.screenshotSha256,
    goal: request.goal.trim(),
    allowedActions: Object.freeze(request.allowedActions as PlayerPolicyRequest["allowedActions"]),
    history: Object.freeze(history),
    recovery: request.recovery,
  });
}

export function parsePlayerPolicyDecision(raw: string, allowedGroups: readonly string[]): PlayerPolicyDecision {
  const source = raw.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  const value = JSON.parse(source) as Record<string, unknown>;
  if (Object.keys(value).some(key => !["screenIntegrity", "screenIntegrityReason", "status", "observation", "rationale", "actions"].includes(key))
    || !["PASS", "PRODUCT_DEFECT"].includes(String(value.screenIntegrity))
    || typeof value.screenIntegrityReason !== "string" || value.screenIntegrityReason.trim().length < 1 || value.screenIntegrityReason.length > 500
    || !PLAYER_POLICY_STATUSES.includes(value.status as PlayerPolicyStatus)
    || typeof value.observation !== "string" || value.observation.trim().length < 1 || value.observation.length > 500
    || typeof value.rationale !== "string" || value.rationale.trim().length < 1 || value.rationale.length > 500
    || !Array.isArray(value.actions) || value.actions.length > 4
    || (value.screenIntegrity === "PASS" && value.status === "CONTINUE" && value.actions.length < 1)
    || (value.screenIntegrity === "PRODUCT_DEFECT" && value.actions.length !== 0)) {
    throw new Error("Test Agent decision shape is invalid");
  }
  return Object.freeze({
    screenIntegrity: value.screenIntegrity as PlayerPolicyDecision["screenIntegrity"],
    screenIntegrityReason: value.screenIntegrityReason.trim(),
    status: value.status as PlayerPolicyStatus,
    observation: value.observation.trim(),
    rationale: value.rationale.trim(),
    actions: Object.freeze(value.actions.map(action => validatePolicyAction(action, allowedGroups))),
  });
}

function validatePolicyAction(value: unknown, groups: readonly string[]): PlayerPolicyAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Test Agent action is invalid");
  const action = value as Record<string, unknown>;
  const keyboard = ["key_tap", "key_hold", "text_input"];
  const pointer = ["click", "double_click", "scroll", "drag"];
  const gamepad = ["gamepad_button_tap", "gamepad_button_hold", "gamepad_axis", "gamepad_trigger", "gamepad_release_all"];
  const passive = ["wait"];
  if (typeof action.type !== "string"
    || (keyboard.includes(action.type) && !groups.includes("KEYBOARD"))
    || (pointer.includes(action.type) && !groups.includes("POINTER"))
    || (gamepad.includes(action.type) && !groups.includes("GAMEPAD"))
    || ![...keyboard, ...pointer, ...gamepad, ...passive].includes(action.type)) {
    throw new Error("Test Agent action is outside the allowed action space");
  }
  if (action.type === "wait" && (!Number.isInteger(action.duration_ms) || Number(action.duration_ms) < 100 || Number(action.duration_ms) > 2_000)) throw new Error("Test Agent wait is unsafe");
  if (["key_tap", "key_hold"].includes(action.type) && (typeof action.key !== "string"
    || !/^(?:KEY_)?(?:[A-Z0-9]|SPACE|ENTER|TAB|ESCAPE|LEFT|RIGHT|UP|DOWN|MINUS|EQUAL)$/.test(action.key))) throw new Error("Test Agent key is invalid");
  if (action.type === "key_hold" && (!Number.isInteger(action.duration_ms) || Number(action.duration_ms) < 1 || Number(action.duration_ms) > 2_000)) throw new Error("Test Agent key hold is unsafe");
  if (action.type === "text_input" && (typeof action.text !== "string" || action.text.length < 1 || action.text.length > 80
    || /[\u0000-\u001f\u007f]/u.test(action.text))) throw new Error("Test Agent text input is unsafe");
  if (["click", "double_click"].includes(action.type) && (!coordinate(action.x, 1280) || !coordinate(action.y, 720))) throw new Error("Test Agent pointer target is outside the game frame");
  if (action.type === "scroll" && (!coordinate(action.x, 1280) || !coordinate(action.y, 720)
    || !Number.isInteger(action.deltaY) || Number(action.deltaY) === 0 || Math.abs(Number(action.deltaY)) > 1_200)) throw new Error("Test Agent scroll is unsafe");
  if (action.type === "drag" && (![action.fromX, action.toX].every(item => coordinate(item, 1280))
    || ![action.fromY, action.toY].every(item => coordinate(item, 720))
    || !Number.isInteger(action.duration_ms) || Number(action.duration_ms) < 1 || Number(action.duration_ms) > 2_000)) throw new Error("Test Agent drag is unsafe");
  if (["gamepad_button_tap", "gamepad_button_hold"].includes(action.type)
    && !["A", "B", "X", "Y", "BACK", "GUIDE", "START", "LEFT_STICK", "RIGHT_STICK", "LEFT_SHOULDER", "RIGHT_SHOULDER", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"].includes(String(action.button))) throw new Error("Test Agent gamepad button is invalid");
  if (action.type === "gamepad_button_hold" && (!Number.isInteger(action.duration_ms) || Number(action.duration_ms) < 1 || Number(action.duration_ms) > 2_000)) throw new Error("Test Agent gamepad hold is unsafe");
  if (action.type === "gamepad_axis" && (!["LEFT_X", "LEFT_Y", "RIGHT_X", "RIGHT_Y"].includes(String(action.axis))
    || typeof action.value !== "number" || action.value < -1 || action.value > 1)) throw new Error("Test Agent gamepad axis is invalid");
  if (action.type === "gamepad_trigger" && (!["LEFT", "RIGHT"].includes(String(action.trigger))
    || typeof action.value !== "number" || action.value < 0 || action.value > 1)) throw new Error("Test Agent trigger is invalid");
  const allowedFields: Record<string, readonly string[]> = {
    wait: ["type", "duration_ms"],
    key_tap: ["type", "key"], key_hold: ["type", "key", "duration_ms"], text_input: ["type", "text"],
    click: ["type", "x", "y"], double_click: ["type", "x", "y"], scroll: ["type", "x", "y", "deltaY"],
    drag: ["type", "fromX", "fromY", "toX", "toY", "duration_ms"],
    gamepad_button_tap: ["type", "button"], gamepad_button_hold: ["type", "button", "duration_ms"],
    gamepad_axis: ["type", "axis", "value"], gamepad_trigger: ["type", "trigger", "value"], gamepad_release_all: ["type"],
  };
  const actionType = action.type;
  if (Object.keys(action).some(field => !allowedFields[actionType]!.includes(field))) throw new Error("Test Agent action contains undeclared fields");
  return Object.freeze({ ...action, type: actionType });
}

function coordinate(value: unknown, maximum: number): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < maximum;
}

function digestBase64(value: string): string {
  let bytes: Buffer;
  try { bytes = Buffer.from(value, "base64"); } catch { throw invalid("Screenshot encoding is invalid"); }
  if (bytes.length < 33 || bytes.length > MAX_PLAYER_POLICY_SCREENSHOT_BYTES
    || bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== 1280 || bytes.readUInt32BE(20) !== 720) {
    throw invalid("Screenshot encoding is invalid");
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "INVALID_PLAYER_POLICY_REQUEST", statusCode: 400 });
}
