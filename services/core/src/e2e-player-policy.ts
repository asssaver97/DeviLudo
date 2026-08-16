import { createHash } from "node:crypto";
import type { AgentRuntimeKind } from "@/lib/product/contracts";

export const PLAYER_POLICY_STATUSES = ["CONTINUE", "GOAL_REACHED", "UNRECOVERABLE"] as const;
export type PlayerPolicyStatus = typeof PLAYER_POLICY_STATUSES[number];

export type PlayerPolicyAction = Readonly<Record<string, unknown> & { type: string }>;
export type PlayerPolicyDecision = Readonly<{
  status: PlayerPolicyStatus;
  observation: string;
  rationale: string;
  actions: readonly PlayerPolicyAction[];
}>;
export type PlayerPolicyResult = Readonly<{
  decision: PlayerPolicyDecision;
  inputTokens: number;
  outputTokens: number;
}>;

const VISION_SMOKE_CASES = Object.freeze([
  Object.freeze({
    left: "RED", right: "BLUE",
    png: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAZUlEQVR4nO3PQQ3AMBDAsHYaf8jrUFz9iQFEyv7WrGed0f47Wr+gAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAe0HEmsC/a0PiqEAAAAASUVORK5CYII=",
  }),
  Object.freeze({
    left: "BLUE", right: "YELLOW",
    png: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAZklEQVR4nO3PwQnAMAzAQAe6/8hpp3D1uRtAoDPzzqZ7z2r/Wa3/wEDNQM1AzUDNQM1AzUDNQM1AzUDNQM1AzUDNQM1AzUDNQM1AzUDNQM1AzUDNQM1AzUDNQM1AzUDNQM1AzUDtA2PvA/rQQD9HAAAAAElFTkSuQmCC",
  }),
]);

export type PlayerPolicyRequest = Readonly<{
  rolloutIndex: number;
  decisionIndex: number;
  screenshotBase64: string;
  screenshotSha256: string;
  goal: string;
  allowedActions: readonly ("KEYBOARD" | "POINTER" | "GAMEPAD")[];
  history: readonly Readonly<{ decisionIndex: number; observation: string; actions: readonly PlayerPolicyAction[]; result: string }>[];
  recovery: boolean;
}>;

export function playerPolicyIdempotencyInput(request: PlayerPolicyRequest) {
  // A node-level retry relaunches the game from a clean directory. Pixel
  // digests and visible-history summaries can legitimately differ between
  // those launches, while the frozen goal and allowed input surface cannot.
  // Reusing the keyed decision avoids duplicate provider charges and keeps a
  // retried rollout deterministic.
  return Object.freeze({ goal: request.goal, allowedActions: request.allowedActions });
}

export function parsePlayerPolicyRequest(value: unknown): PlayerPolicyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Player policy request must be an object");
  const request = value as Record<string, unknown>;
  if (!Number.isInteger(request.rolloutIndex) || Number(request.rolloutIndex) < 0 || Number(request.rolloutIndex) > 2
    || !Number.isInteger(request.decisionIndex) || Number(request.decisionIndex) < 0 || Number(request.decisionIndex) > 39
    || typeof request.screenshotBase64 !== "string" || request.screenshotBase64.length < 16 || request.screenshotBase64.length > 1_800_000
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
    return Object.freeze({ decisionIndex: Number(record.decisionIndex), observation: record.observation, result: record.result, actions: Object.freeze(actions) });
  });
  if (history.some((item, index) => item.decisionIndex >= Number(request.decisionIndex)
    || (index > 0 && item.decisionIndex <= history[index - 1]!.decisionIndex))) {
    throw invalid("Player policy history order is invalid");
  }
  return Object.freeze({
    rolloutIndex: Number(request.rolloutIndex), decisionIndex: Number(request.decisionIndex),
    screenshotBase64: request.screenshotBase64, screenshotSha256: request.screenshotSha256,
    goal: request.goal.trim(), allowedActions: Object.freeze(request.allowedActions as PlayerPolicyRequest["allowedActions"]),
    history: Object.freeze(history), recovery: request.recovery,
  });
}

export async function generateE2ePlayerDecision(input: Readonly<{
  request: PlayerPolicyRequest;
  runtime: AgentRuntimeKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}>): Promise<PlayerPolicyResult> {
  const prompt = policyPrompt(input.request);
  const fetchImpl = input.fetchImpl ?? fetch;
  let lastRaw = "";
  let inputTokens = 0;
  let outputTokens = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const correction = attempt === 0 ? "" : `\nYour previous response was invalid: ${lastRaw.slice(0, 1_000)}\nReturn only the required JSON object.`;
    let response: Response;
    try {
      response = input.runtime === "CLAUDE_CODE"
        ? await fetchImpl(providerEndpoint(input.baseUrl, "messages"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.apiKey}`,
            "x-api-key": input.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: input.model, max_tokens: 1_200, temperature: 0.1,
            system: PLAYER_POLICY_SYSTEM,
            messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: input.request.screenshotBase64 } },
              { type: "text", text: prompt + correction },
            ] }],
            tools: [playerDecisionTool(input.request.allowedActions)],
            tool_choice: { type: "tool", name: "submit_player_decision" },
          }),
          signal: AbortSignal.timeout(25_000),
        })
        : await fetchImpl(providerEndpoint(input.baseUrl, "responses"), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
          body: JSON.stringify({
            model: input.model,
            instructions: PLAYER_POLICY_SYSTEM,
            input: [{ role: "user", content: [
              { type: "input_image", image_url: `data:image/png;base64,${input.request.screenshotBase64}` },
              { type: "input_text", text: prompt + correction },
            ] }], max_output_tokens: 1_200,
          }),
          signal: AbortSignal.timeout(25_000),
        });
    } catch {
      lastRaw = "provider request failed";
      if (attempt === 0) continue;
      throw providerFailure("Test Agent provider request failed");
    }
    if (!response.ok) throw providerFailure(`Test Agent provider returned ${response.status}`);
    const responseText = await response.text();
    let body: Record<string, unknown>;
    try { body = JSON.parse(responseText) as Record<string, unknown>; }
    catch {
      lastRaw = "provider returned a non-JSON response";
      if (attempt === 0) continue;
      throw providerFailure("Test Agent provider returned a non-JSON response");
    }
    const usage = body.usage && typeof body.usage === "object" && !Array.isArray(body.usage)
      ? body.usage as Record<string, unknown> : {};
    inputTokens += safeTokenCount(usage.input_tokens ?? usage.inputTokens);
    outputTokens += safeTokenCount(usage.output_tokens ?? usage.outputTokens);
    lastRaw = input.runtime === "CLAUDE_CODE"
      ? claudeDecisionPayload(body)
      : String(body.output_text ?? (body.output as readonly Record<string, unknown>[] | undefined)?.flatMap(item => item.content as readonly Record<string, unknown>[] ?? []).find(item => typeof item.text === "string")?.text ?? "");
    try {
      const decision = parsePlayerPolicyDecision(lastRaw, input.request.allowedActions);
      assertScreenshotWasInspected(decision.observation);
      assertUnrecoverableFollowsRecovery(decision, input.request);
      return Object.freeze({
        decision,
        inputTokens,
        outputTokens,
      });
    }
    catch (error) {
      // A provider that says it cannot see the image has already proved that
      // this model route is not usable for black-box play. Asking it to repair
      // the JSON encourages a text-only model to invent visible controls, which
      // turns an infrastructure capability problem into unsafe product input.
      if (isVisionUnavailable(error)) throw error;
      if (attempt === 1) {
        throw providerFailure(error instanceof Error ? error.message : "Test Agent returned invalid actions");
      }
      const reason = error instanceof Error ? error.message : "Test Agent returned invalid actions";
      lastRaw = `Validation error: ${reason}. Previous payload: ${lastRaw.slice(0, 700)}`;
    }
  }
  throw providerFailure("Test Agent did not return a decision");
}

/**
 * Proves that the configured Test Agent route receives image bytes before a
 * node pays the cost of cloning or booting an E2E VM. The expected colors are
 * deliberately absent from the prompt; two independent panels prevent a
 * text-only compatibility gateway from being accepted as a visual player.
 */
export async function verifyE2ePlayerVision(input: Readonly<{
  runtime: AgentRuntimeKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}>): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  for (const testCase of VISION_SMOKE_CASES) {
    let response: Response;
    try {
      response = input.runtime === "CLAUDE_CODE"
        ? await fetchImpl(providerEndpoint(input.baseUrl, "messages"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.apiKey}`,
            "x-api-key": input.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: input.model, max_tokens: 120, temperature: 0,
            messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: testCase.png } },
              { type: "text", text: VISION_SMOKE_PROMPT },
            ] }],
            tools: [VISION_SMOKE_TOOL],
            tool_choice: { type: "tool", name: "submit_vision_smoke" },
          }),
          signal: AbortSignal.timeout(25_000),
        })
        : await fetchImpl(providerEndpoint(input.baseUrl, "responses"), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
          body: JSON.stringify({
            model: input.model,
            instructions: "Inspect the attached calibration image; do not infer colors from text.",
            input: [{ role: "user", content: [
              { type: "input_image", image_url: `data:image/png;base64,${testCase.png}` },
              { type: "input_text", text: VISION_SMOKE_PROMPT },
            ] }],
            max_output_tokens: 120,
          }),
          signal: AbortSignal.timeout(25_000),
        });
    } catch {
      throw providerFailure("Test Agent visual capability request failed");
    }
    if (!response.ok) throw providerFailure(`Test Agent visual capability check returned ${response.status}`);
    let body: Record<string, unknown>;
    try { body = JSON.parse(await response.text()) as Record<string, unknown>; }
    catch { throw providerFailure("Test Agent visual capability check returned invalid JSON"); }
    const answer = input.runtime === "CLAUDE_CODE"
      ? claudeVisionSmokePayload(body)
      : String(body.output_text ?? (body.output as readonly Record<string, unknown>[] | undefined)
        ?.flatMap(item => item.content as readonly Record<string, unknown>[] ?? [])
        .find(item => typeof item.text === "string")?.text ?? "");
    const observed = parseVisionSmokeAnswer(answer);
    if (observed.left !== testCase.left || observed.right !== testCase.right) {
      throw visionUnavailable("Test Agent provider did not inspect the visual capability image");
    }
  }
}

export function parsePlayerPolicyDecision(raw: string, allowedGroups: readonly string[]): PlayerPolicyDecision {
  const source = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(source) as Record<string, unknown>;
  if (!PLAYER_POLICY_STATUSES.includes(value.status as PlayerPolicyStatus)
    || typeof value.observation !== "string" || value.observation.trim().length < 1 || value.observation.length > 500
    || typeof value.rationale !== "string" || value.rationale.trim().length < 1 || value.rationale.length > 500
    || !Array.isArray(value.actions) || value.actions.length > 4
    || (value.status === "CONTINUE" && value.actions.length < 1)) throw new Error("Test Agent decision shape is invalid");
  const actions = value.actions.map(action => validatePolicyAction(action, allowedGroups));
  return Object.freeze({ status: value.status as PlayerPolicyStatus, observation: value.observation.trim(), rationale: value.rationale.trim(), actions: Object.freeze(actions) });
}

function validatePolicyAction(
  value: unknown,
  groups: readonly string[],
): PlayerPolicyAction {
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
    || ![...keyboard, ...pointer, ...gamepad, ...passive].includes(action.type)) throw new Error("Test Agent action is outside the allowed action space");
  if (action.type === "wait" && (!Number.isInteger(action.duration_ms) || Number(action.duration_ms) < 100 || Number(action.duration_ms) > 2_000)) throw new Error("Test Agent wait is unsafe");
  if (["key_tap", "key_hold"].includes(action.type) && (typeof action.key !== "string" || !/^(?:KEY_)?(?:[A-Z0-9]|SPACE|ENTER|TAB|ESCAPE|LEFT|RIGHT|UP|DOWN|MINUS|EQUAL)$/.test(action.key))) throw new Error("Test Agent key is invalid");
  if (action.type === "key_hold" && (!Number.isInteger(action.duration_ms) || Number(action.duration_ms) < 1 || Number(action.duration_ms) > 2_000)) throw new Error("Test Agent key hold is unsafe");
  if (action.type === "text_input" && (typeof action.text !== "string" || action.text.length < 1 || action.text.length > 80
    || /[\u0000-\u001f\u007f]/u.test(action.text))) throw new Error("Test Agent text input is unsafe");
  if (["click", "double_click"].includes(action.type) && (!Number.isInteger(action.x) || Number(action.x) < 0 || Number(action.x) >= E2E_PLAYER_WIDTH || !Number.isInteger(action.y) || Number(action.y) < 0 || Number(action.y) >= E2E_PLAYER_HEIGHT)) throw new Error("Test Agent pointer target is outside the game frame");
  if (action.type === "scroll" && (!Number.isInteger(action.x) || Number(action.x) < 0 || Number(action.x) >= E2E_PLAYER_WIDTH
    || !Number.isInteger(action.y) || Number(action.y) < 0 || Number(action.y) >= E2E_PLAYER_HEIGHT
    || !Number.isInteger(action.deltaY) || Number(action.deltaY) === 0 || Math.abs(Number(action.deltaY)) > 1_200)) throw new Error("Test Agent scroll is unsafe");
  if (action.type === "drag" && (![action.fromX, action.toX].every(item => Number.isInteger(item) && Number(item) >= 0 && Number(item) < E2E_PLAYER_WIDTH)
    || ![action.fromY, action.toY].every(item => Number.isInteger(item) && Number(item) >= 0 && Number(item) < E2E_PLAYER_HEIGHT)
    || !Number.isInteger(action.duration_ms) || Number(action.duration_ms) < 1 || Number(action.duration_ms) > 2_000)) {
    throw new Error("Test Agent drag is unsafe");
  }
  if (["gamepad_button_tap", "gamepad_button_hold"].includes(action.type) && !["A", "B", "X", "Y", "BACK", "GUIDE", "START", "LEFT_STICK", "RIGHT_STICK", "LEFT_SHOULDER", "RIGHT_SHOULDER", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"].includes(String(action.button))) throw new Error("Test Agent gamepad button is invalid");
  if (action.type === "gamepad_button_hold" && (!Number.isInteger(action.duration_ms) || Number(action.duration_ms) < 1 || Number(action.duration_ms) > 2_000)) throw new Error("Test Agent gamepad hold is unsafe");
  if (action.type === "gamepad_axis" && (!["LEFT_X", "LEFT_Y", "RIGHT_X", "RIGHT_Y"].includes(String(action.axis)) || typeof action.value !== "number" || action.value < -1 || action.value > 1)) throw new Error("Test Agent gamepad axis is invalid");
  if (action.type === "gamepad_trigger" && (!["LEFT", "RIGHT"].includes(String(action.trigger)) || typeof action.value !== "number" || action.value < 0 || action.value > 1)) throw new Error("Test Agent trigger is invalid");
  const allowedFields: Record<string, readonly string[]> = {
    wait: ["type", "duration_ms"],
    key_tap: ["type", "key"], key_hold: ["type", "key", "duration_ms"], text_input: ["type", "text"],
    click: ["type", "x", "y"], double_click: ["type", "x", "y"], scroll: ["type", "x", "y", "deltaY"],
    drag: ["type", "fromX", "fromY", "toX", "toY", "duration_ms"],
    gamepad_button_tap: ["type", "button"], gamepad_button_hold: ["type", "button", "duration_ms"],
    gamepad_axis: ["type", "axis", "value"], gamepad_trigger: ["type", "trigger", "value"], gamepad_release_all: ["type"],
  };
  const actionType = action.type as string;
  if (Object.keys(action).some(field => !allowedFields[actionType]!.includes(field))) throw new Error("Test Agent action contains undeclared fields");
  return Object.freeze({ ...action, type: actionType });
}

function policyPrompt(request: PlayerPolicyRequest): string {
  return [
    `The attached ${E2E_PLAYER_WIDTH}x${E2E_PLAYER_HEIGHT} image is the exact current game client. Inspect this image before choosing actions.`,
    "Describe concrete controls or gameplay elements visible in the current image. Do not claim that the frame is unavailable when visible UI exists.",
    "Highest priority: identify the topmost interactive layer. If a dialog, menu, mode selector, save selector, tutorial, consent prompt, or overlay blocks the underlying game, complete that layer before sending gameplay input.",
    "This rollout starts with clean user data. Prefer a visible control that creates a fresh playable session over one that requires an existing save or prior progress.",
    "When a menu, modal, toolbar, or rectangular button is visible and POINTER is allowed, click the relevant visible control. Never send a keyboard key through a blocking overlay.",
    "Thin cyan guide lines are drawn at every x and y multiple of 80 pixels without changing the 1280x720 coordinate space. Count from the top-left origin and use the nearest guide lines to estimate the visible target center.",
    "Before every pointer action, describe the visible target and its approximate left, top, right, and bottom pixel bounds in observation, then place the pointer inside those bounds.",
    "Do not guess SPACE, ENTER, movement keys, or other keyboard controls from the goal or game genre. Use a keyboard action only when the current frame visibly shows that exact key or a clear keyboard hint.",
    "Unreadable or non-English button text does not make the frame unavailable: use the visible control geometry and report its approximate position.",
    `Goal: ${request.goal}`,
    `Allowed action groups: ${request.allowedActions.join(", ")}`,
    request.recovery ? "The last actions made no progress. Choose a different recovery action from visible UI only." : "Choose the next short action chunk from the visible game frame.",
    `Recent history: ${JSON.stringify(request.history)}`,
    "Return only JSON: {\"status\":\"CONTINUE|GOAL_REACHED|UNRECOVERABLE\",\"observation\":\"brief visible facts\",\"rationale\":\"brief action reason\",\"actions\":[up to 4 actions]}.",
    "Action JSON forms: wait(duration_ms), key_tap/key_hold(key,duration_ms), text_input(text), click/double_click(x,y), scroll(x,y,deltaY), drag(fromX,fromY,toX,toY,duration_ms), gamepad_button_tap/gamepad_button_hold(button,duration_ms), gamepad_axis(axis,value), gamepad_trigger(trigger,value), gamepad_release_all.",
    "UNRECOVERABLE is only valid after the runner has entered recovery mode. If the frame is still loading or no safe control is clear before recovery, CONTINUE with a short wait and inspect the next frame.",
    `Pointer actions use integer coordinates directly in this same ${E2E_PLAYER_WIDTH}x${E2E_PLAYER_HEIGHT} client. The screenshot, action history, and returned inputs all share this one coordinate space. Never use OS shortcuts. Use only action groups listed above.`,
  ].join("\n");
}

const PLAYER_POLICY_SYSTEM = [
  "You are a black-box game player. You only see the attached live pixels and may only return safe player inputs.",
  "Never infer or request internal game state.",
  "Resolve any visible topmost blocking interaction layer before attempting actions in the obscured game beneath it.",
  "Ground every action in something visible in the current frame, not in assumptions about the game genre.",
].join(" ");

const VISION_SMOKE_PROMPT = [
  "The attached synthetic calibration image contains two equal vertical solid-color panels.",
  "Report the left and right panel colors using only RED, GREEN, BLUE, YELLOW, or UNAVAILABLE.",
  "If the image is unavailable, report UNAVAILABLE for both fields.",
  "Return only the required structured result.",
].join(" ");

const VISION_SMOKE_TOOL = Object.freeze({
  name: "submit_vision_smoke",
  description: "Report the two colors actually visible in the calibration image.",
  input_schema: {
    type: "object", additionalProperties: false,
    properties: {
      left: { type: "string", enum: ["RED", "GREEN", "BLUE", "YELLOW", "UNAVAILABLE"] },
      right: { type: "string", enum: ["RED", "GREEN", "BLUE", "YELLOW", "UNAVAILABLE"] },
    },
    required: ["left", "right"],
  },
});

function claudeDecisionPayload(body: Record<string, unknown>): string {
  const content = Array.isArray(body.content) ? body.content as readonly Record<string, unknown>[] : [];
  const tool = content.find(item => item.type === "tool_use" && item.name === "submit_player_decision"
    && item.input && typeof item.input === "object" && !Array.isArray(item.input));
  if (tool) return JSON.stringify(tool.input);
  return String(content.find(item => item.type === "text")?.text ?? "");
}

function claudeVisionSmokePayload(body: Record<string, unknown>): string {
  const content = Array.isArray(body.content) ? body.content as readonly Record<string, unknown>[] : [];
  const tool = content.find(item => item.type === "tool_use" && item.name === "submit_vision_smoke"
    && item.input && typeof item.input === "object" && !Array.isArray(item.input));
  if (tool) return JSON.stringify(tool.input);
  return String(content.find(item => item.type === "text")?.text ?? "");
}

function parseVisionSmokeAnswer(raw: string): Readonly<{ left: string; right: string }> {
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["left", "right"].includes(key))
      || typeof value.left !== "string" || typeof value.right !== "string") {
      throw new Error("invalid shape");
    }
    return Object.freeze({ left: value.left.toUpperCase(), right: value.right.toUpperCase() });
  } catch {
    throw visionUnavailable("Test Agent provider did not return a grounded visual capability result");
  }
}

function playerDecisionTool(allowedGroups: PlayerPolicyRequest["allowedActions"]): Readonly<Record<string, unknown>> {
  const action = (type: string, properties: Record<string, unknown>, required: string[]) => Object.freeze({
    type: "object", additionalProperties: false,
    properties: { type: { const: type }, ...properties },
    required: ["type", ...required],
  });
  const actionVariants: Record<string, unknown>[] = [
    action("wait", { duration_ms: { type: "integer", minimum: 100, maximum: 2_000 } }, ["duration_ms"]),
  ];
  if (allowedGroups.includes("KEYBOARD")) actionVariants.push(
    action("key_tap", { key: { type: "string", enum: PLAYER_POLICY_KEYS } }, ["key"]),
    action("key_hold", { key: { type: "string", enum: PLAYER_POLICY_KEYS }, duration_ms: { type: "integer", minimum: 1, maximum: 2_000 } }, ["key", "duration_ms"]),
    action("text_input", { text: { type: "string", minLength: 1, maxLength: 80 } }, ["text"]),
  );
  if (allowedGroups.includes("POINTER")) actionVariants.push(
    action("click", { x: frameCoordinate(E2E_PLAYER_WIDTH, "horizontal pixel from the left edge"), y: frameCoordinate(E2E_PLAYER_HEIGHT, "vertical pixel from the top edge") }, ["x", "y"]),
    action("double_click", { x: frameCoordinate(E2E_PLAYER_WIDTH, "horizontal pixel from the left edge"), y: frameCoordinate(E2E_PLAYER_HEIGHT, "vertical pixel from the top edge") }, ["x", "y"]),
    action("scroll", { x: frameCoordinate(E2E_PLAYER_WIDTH, "horizontal pixel from the left edge"), y: frameCoordinate(E2E_PLAYER_HEIGHT, "vertical pixel from the top edge"), deltaY: {
      oneOf: [{ type: "integer", minimum: -1_200, maximum: -1 }, { type: "integer", minimum: 1, maximum: 1_200 }],
    } }, ["x", "y", "deltaY"]),
    action("drag", {
      fromX: frameCoordinate(E2E_PLAYER_WIDTH, "starting horizontal pixel from the left edge"), fromY: frameCoordinate(E2E_PLAYER_HEIGHT, "starting vertical pixel from the top edge"),
      toX: frameCoordinate(E2E_PLAYER_WIDTH, "ending horizontal pixel from the left edge"), toY: frameCoordinate(E2E_PLAYER_HEIGHT, "ending vertical pixel from the top edge"),
      duration_ms: { type: "integer", minimum: 1, maximum: 2_000 },
    }, ["fromX", "fromY", "toX", "toY", "duration_ms"]),
  );
  if (allowedGroups.includes("GAMEPAD")) actionVariants.push(
    action("gamepad_button_tap", { button: { type: "string", enum: PLAYER_POLICY_GAMEPAD_BUTTONS } }, ["button"]),
    action("gamepad_button_hold", { button: { type: "string", enum: PLAYER_POLICY_GAMEPAD_BUTTONS }, duration_ms: { type: "integer", minimum: 1, maximum: 2_000 } }, ["button", "duration_ms"]),
    action("gamepad_axis", { axis: { type: "string", enum: PLAYER_POLICY_GAMEPAD_AXES }, value: { type: "number", minimum: -1, maximum: 1 } }, ["axis", "value"]),
    action("gamepad_trigger", { trigger: { type: "string", enum: PLAYER_POLICY_GAMEPAD_TRIGGERS }, value: { type: "number", minimum: 0, maximum: 1 } }, ["trigger", "value"]),
    action("gamepad_release_all", {}, []),
  );
  return Object.freeze({
    name: "submit_player_decision",
    description: "Submit the next safe black-box player action decision.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        status: { type: "string", enum: PLAYER_POLICY_STATUSES },
        observation: { type: "string", minLength: 1, maxLength: 500 },
        rationale: { type: "string", minLength: 1, maxLength: 500 },
        actions: { type: "array", maxItems: 4, items: { oneOf: actionVariants } },
      },
      required: ["status", "observation", "rationale", "actions"],
    },
  });
}

const E2E_PLAYER_WIDTH = 1280;
const E2E_PLAYER_HEIGHT = 720;
const PLAYER_POLICY_KEYS = Object.freeze([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  "SPACE", "ENTER", "TAB", "ESCAPE", "LEFT", "RIGHT", "UP", "DOWN", "MINUS", "EQUAL",
]);
const PLAYER_POLICY_GAMEPAD_BUTTONS = Object.freeze([
  "A", "B", "X", "Y", "BACK", "GUIDE", "START", "LEFT_STICK", "RIGHT_STICK",
  "LEFT_SHOULDER", "RIGHT_SHOULDER", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT",
]);
const PLAYER_POLICY_GAMEPAD_AXES = Object.freeze(["LEFT_X", "LEFT_Y", "RIGHT_X", "RIGHT_Y"]);
const PLAYER_POLICY_GAMEPAD_TRIGGERS = Object.freeze(["LEFT", "RIGHT"]);
function frameCoordinate(maximum: number, description: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: "integer", minimum: 0, maximum: maximum - 1, description });
}

function providerEndpoint(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/${endpoint}`.replace(/\/{2,}/g, "/");
  return url.href;
}

function digestBase64(value: string): string {
  let bytes: Buffer;
  try { bytes = Buffer.from(value, "base64"); } catch { throw invalid("Screenshot encoding is invalid"); }
  if (bytes.length < 33 || bytes.length > 1_300_000 || bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== E2E_PLAYER_WIDTH || bytes.readUInt32BE(20) !== E2E_PLAYER_HEIGHT) {
    throw invalid("Screenshot encoding is invalid");
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function invalid(message: string): Error { return Object.assign(new Error(message), { code: "INVALID_PLAYER_POLICY_REQUEST", statusCode: 400 }); }
function providerFailure(message: string): Error { return Object.assign(new Error(message), { code: "PLAYER_POLICY_PROVIDER", statusCode: 503 }); }
function visionUnavailable(message: string): Error { return Object.assign(new Error(message), { code: "PLAYER_POLICY_VISION_UNAVAILABLE", statusCode: 503 }); }
function isVisionUnavailable(error: unknown): error is Error & { code: "PLAYER_POLICY_VISION_UNAVAILABLE" } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "PLAYER_POLICY_VISION_UNAVAILABLE");
}
function assertScreenshotWasInspected(observation: string): void {
  const unavailable = [
    /\bno\b.{0,120}\b(?:pixels?|images?|frames?|game ui|client ui|visible ui|interactive controls?)\b.{0,120}\b(?:included|available|accessible|provided|present|visible|exposed|rendered)\b/i,
    /\b(?:pixels?|images?|frames?|game ui|client ui|visible ui|interactive controls?)\b.{0,120}\b(?:is|are|was|were|does|do|did)?\s*(?:not|n't)\b.{0,80}\b(?:included|available|accessible|provided|present|visible|exposed|rendered|shown)\b/i,
    /\b(?:frame|image|view|context|frame description|supplied view)\b.{0,120}\b(?:does|do|did|is|are|was|were)?\s*(?:not|n't)\b.{0,60}\b(?:expose|include|provide|show|contain|present)\b/i,
    /\b(?:cannot|can't|unable to)\b.{0,80}\b(?:see|view|access|inspect|identify|verify)\b.{0,80}\b(?:image|frame|pixels?|ui|controls?|geometry)\b/i,
  ].some(pattern => pattern.test(observation));
  if (unavailable) throw visionUnavailable("Test Agent model did not inspect the attached game screenshot");
}

function assertUnrecoverableFollowsRecovery(decision: PlayerPolicyDecision, request: PlayerPolicyRequest): void {
  if (decision.status === "UNRECOVERABLE" && !request.recovery) {
    throw new Error("Test Agent cannot declare UNRECOVERABLE before recovery mode");
  }
}
function safeTokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}
