import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import type { AgentRuntimeKind } from "@/lib/product/contracts";
import { runCodexPrompt, type CodexPromptRunner } from "./codex-cli";

export const PLAYER_POLICY_STATUSES = ["CONTINUE", "GOAL_REACHED", "UNRECOVERABLE"] as const;
// A lossless 1280x720 PNG can exceed the old 1.3 MiB allowance for visually
// dense games. Keep one bounded raw frame below 4 MiB; Core validates its PNG
// header and dimensions, then performs the sole half-scale transform before
// attaching it to the Test Agent request.
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
export type PlayerPolicyResult = Readonly<{
  decision: PlayerPolicyDecision;
  inputTokens: number;
  outputTokens: number;
}>;

const VISION_SMOKE_CASES = Object.freeze([
  Object.freeze({
    expected: "RED",
    png: visionCalibrationPng([255, 0, 0]),
  }),
  Object.freeze({
    expected: "YELLOW",
    png: visionCalibrationPng([255, 255, 0]),
  }),
]);

/** Build the calibration images instead of embedding opaque PNG blobs. The
 * previous blobs had invalid IDAT CRC/zlib checksums, so every visual model
 * correctly rejected them and the E2E preflight reported a false negative. */
function visionCalibrationPng(color: readonly [number, number, number]): string {
  const width = 64;
  const height = 64;
  const channels = 3;
  const rowBytes = 1 + width * channels;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * channels;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function pngChunk(kind: "IHDR" | "IDAT" | "IEND", data: Buffer): Buffer {
  const type = Buffer.from(kind, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 8 + data.length);
  return chunk;
}

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
  codexRunner?: CodexPromptRunner;
}>): Promise<PlayerPolicyResult> {
  const prompt = policyPrompt(input.request);
  const fetchImpl = input.fetchImpl ?? fetch;
  const codexRunner = input.codexRunner ?? runCodexPrompt;
  const providerFrameBase64 = await downsamplePlayerFrame(input.request.screenshotBase64);
  let lastRaw = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let transportRetryUsed = false;
  let structuredRepairUsed = false;
  let lostImageRetries = 0;
  // These are independent recovery budgets: one transport/status retry, one
  // structured-output repair and up to three clean image reattachments. Keep
  // enough total attempts for all of them to occur in one decision instead of
  // letting an earlier transient failure silently consume the vision budget.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const correction = attempt === 0 || lastRaw.length === 0
      ? ""
      : `\nYour previous response was invalid: ${lastRaw.slice(0, 1_000)}\nReturn only the required JSON object.`;
    let response: Response;
    try {
      response = input.runtime === "CLAUDE_CODE"
        ? await fetchImpl(messagesEndpoint(input.baseUrl), {
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
              { type: "image", source: { type: "base64", media_type: "image/png", data: providerFrameBase64 } },
              { type: "text", text: prompt + correction },
            ] }],
            tools: [playerDecisionTool(input.request.allowedActions)],
            tool_choice: { type: "tool", name: "submit_player_decision" },
          }),
          signal: AbortSignal.timeout(75_000),
        })
        : new Response(JSON.stringify({ output_text: await codexRunner({
          authJson: input.apiKey,
          model: input.model,
          prompt: `${PLAYER_POLICY_SYSTEM}\n\n${prompt}${correction}`,
          imageBase64: providerFrameBase64,
          reasoningEffort: "low",
          timeoutMs: 75_000,
        }) }), { status: 200, headers: { "content-type": "application/json" } });
    } catch {
      lastRaw = "provider request failed";
      if (!transportRetryUsed) {
        transportRetryUsed = true;
        continue;
      }
      throw providerFailure("Test Agent provider request failed");
    }
    if (!response.ok) {
      if (!transportRetryUsed && (response.status === 408 || response.status === 425
        || response.status === 429 || response.status >= 500)) {
        transportRetryUsed = true;
        lastRaw = "provider temporarily unavailable";
        continue;
      }
      throw providerFailure(`Test Agent provider returned ${response.status}`);
    }
    const responseText = await response.text();
    let body: Record<string, unknown>;
    try { body = JSON.parse(responseText) as Record<string, unknown>; }
    catch {
      lastRaw = "provider returned a non-JSON response";
      if (!structuredRepairUsed) {
        structuredRepairUsed = true;
        continue;
      }
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
      assertDecisionExploresAfterNoProgress(decision, input.request);
      assertUnrecoverableFollowsRecovery(decision, input.request);
      return Object.freeze({
        decision,
        inputTokens,
        outputTokens,
      });
    }
    catch (error) {
      // The route has already passed the independent two-image calibration
      // before a VM is allocated. A single policy response can still lose its
      // image attachment at a flaky compatibility gateway, so resend the same
      // frame up to three times. Never accept that response: only a new response that passes
      // the screenshot-inspection assertion may drive native input.
      if (isVisionUnavailable(error)) {
        if (lostImageRetries >= 3) throw error;
        lostImageRetries += 1;
        // Resend as a clean multimodal request. Feeding the model its previous
        // "image unavailable" wording in the repair prompt makes otherwise
        // visual routes echo that statement instead of inspecting the newly
        // attached frame.
        lastRaw = "";
        continue;
      }
      if (structuredRepairUsed) {
        throw providerFailure(error instanceof Error ? error.message : "Test Agent returned invalid actions");
      }
      structuredRepairUsed = true;
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
  codexRunner?: CodexPromptRunner;
}>): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const codexRunner = input.codexRunner ?? runCodexPrompt;
  for (const testCase of VISION_SMOKE_CASES) {
    let response: Response;
    try {
      response = input.runtime === "CLAUDE_CODE"
        ? await fetchImpl(messagesEndpoint(input.baseUrl), {
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
          signal: AbortSignal.timeout(40_000),
        })
        : new Response(JSON.stringify({ output_text: await codexRunner({
          authJson: input.apiKey,
          model: input.model,
          prompt: `Inspect the attached calibration image; do not infer colors from text.\n\n${VISION_SMOKE_PROMPT}`,
          imageBase64: testCase.png,
          reasoningEffort: "low",
          timeoutMs: 40_000,
        }) }), { status: 200, headers: { "content-type": "application/json" } });
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
    if (observed.dominant !== testCase.expected) {
      throw visionUnavailable("Test Agent provider did not inspect the visual capability image");
    }
  }
}

export function parsePlayerPolicyDecision(raw: string, allowedGroups: readonly string[]): PlayerPolicyDecision {
  const source = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(source) as Record<string, unknown>;
  if (Object.keys(value).some(key => !["screenIntegrity", "screenIntegrityReason", "status", "observation", "rationale", "actions"].includes(key))
    || !["PASS", "PRODUCT_DEFECT"].includes(String(value.screenIntegrity))
    || typeof value.screenIntegrityReason !== "string" || value.screenIntegrityReason.trim().length < 1 || value.screenIntegrityReason.length > 500
    || !PLAYER_POLICY_STATUSES.includes(value.status as PlayerPolicyStatus)
    || typeof value.observation !== "string" || value.observation.trim().length < 1 || value.observation.length > 500
    || typeof value.rationale !== "string" || value.rationale.trim().length < 1 || value.rationale.length > 500
    || !Array.isArray(value.actions) || value.actions.length > 4
    || (value.screenIntegrity === "PASS" && value.status === "CONTINUE" && value.actions.length < 1)
    || (value.screenIntegrity === "PRODUCT_DEFECT" && value.actions.length !== 0)) throw new Error("Test Agent decision shape is invalid");
  const actions = value.actions.map(action => validatePolicyAction(action, allowedGroups));
  return Object.freeze({
    screenIntegrity: value.screenIntegrity as PlayerPolicyDecision["screenIntegrity"],
    screenIntegrityReason: value.screenIntegrityReason.trim(),
    status: value.status as PlayerPolicyStatus,
    observation: value.observation.trim(),
    rationale: value.rationale.trim(),
    actions: Object.freeze(actions),
  });
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
    `The attached ${E2E_PROVIDER_WIDTH}x${E2E_PROVIDER_HEIGHT} image is an exact half-scale observation of the current ${E2E_PLAYER_WIDTH}x${E2E_PLAYER_HEIGHT} game client. Inspect this image before choosing actions.`,
    "Describe at least one concrete visual fact from the current image: visible text, color, shape, texture, or an element with its screen location. Generic claims that no control is discernible are invalid visual inspection.",
    "If the frame is still loading, ground that conclusion in a visible logo, progress indicator, background color, or other concrete pixel detail. Do not repeatedly wait on a rendered, unchanged interface.",
    "First make an independent screen-integrity judgment. A clean title/menu over passive artwork is valid. A title, start menu, save selector, or new-game dialog drawn over a visibly active board, HUD, tutorial, gameplay controls, in-progress world, or contradictory state is a PRODUCT_DEFECT. A crash dialog, error screen, missing essential UI, or unusable layout is also a PRODUCT_DEFECT.",
    "Never click through, dismiss, or work around a PRODUCT_DEFECT. Return no actions so the product fails and can be repaired. Only after screenIntegrity is PASS may you identify and operate the topmost interactive layer.",
    "This rollout starts with clean user data. Prefer a visible control that creates a fresh playable session over one that requires an existing save or prior progress.",
    "When a menu, modal, toolbar, or rectangular button is visible and POINTER is allowed, click the relevant visible control. Never send a keyboard key through a blocking overlay.",
    "Estimate bounds from the top-left origin of the unmodified observation, then multiply observed x/y coordinates by 2 when returning pointer actions.",
    "Before every pointer action, describe the visible target and its approximate left, top, right, and bottom pixel bounds in observation, then place the pointer inside those bounds.",
    "Do not guess SPACE, ENTER, movement keys, or other keyboard controls from the goal or game genre. Use a keyboard action only when the current frame visibly shows that exact key or a clear keyboard hint.",
    "Unreadable or non-English button text does not make the frame unavailable: use the visible control geometry and report its approximate position.",
    `Goal: ${request.goal}`,
    `Allowed action groups: ${request.allowedActions.join(", ")}`,
    request.recovery ? "The last actions made no progress. Choose a different recovery action from visible UI only." : "Choose the next short action chunk from the visible game frame.",
    `Recent history: ${JSON.stringify(request.history)}`,
    "Return only JSON: {\"screenIntegrity\":\"PASS|PRODUCT_DEFECT\",\"screenIntegrityReason\":\"brief independent visual judgment\",\"status\":\"CONTINUE|GOAL_REACHED|UNRECOVERABLE\",\"observation\":\"brief visible facts\",\"rationale\":\"brief action reason\",\"actions\":[up to 4 actions]}.",
    "Action JSON forms: wait(duration_ms), key_tap/key_hold(key,duration_ms), text_input(text), click/double_click(x,y), scroll(x,y,deltaY), drag(fromX,fromY,toX,toY,duration_ms), gamepad_button_tap/gamepad_button_hold(button,duration_ms), gamepad_axis(axis,value), gamepad_trigger(trigger,value), gamepad_release_all.",
    "UNRECOVERABLE is only valid after the runner has entered recovery mode. If the frame is still loading or no safe control is clear before recovery, CONTINUE with a short wait and inspect the next frame.",
    `Pointer actions use integer coordinates directly in this same ${E2E_PLAYER_WIDTH}x${E2E_PLAYER_HEIGHT} client. The screenshot, action history, and returned inputs all share this one coordinate space. Never use OS shortcuts. Use only action groups listed above.`,
  ].join("\n");
}

const PLAYER_POLICY_SYSTEM = [
  "You are a black-box game player. You only see the attached live pixels and may only return safe player inputs.",
  "Never infer or request internal game state.",
  "Judge whether the visible screen is a coherent shippable player state before taking any action. Never normalize or click through visibly contradictory lifecycle layers.",
  "Resolve a legitimate topmost interaction layer before attempting actions in the unobscured game beneath it.",
  "Ground every action in something visible in the current frame, not in assumptions about the game genre.",
].join(" ");

const VISION_SMOKE_PROMPT = [
  "The attached synthetic calibration image is one solid-color square.",
  "Report its dominant color using only RED, GREEN, BLUE, YELLOW, or UNAVAILABLE.",
  "If the image is unavailable, report UNAVAILABLE.",
  'Return only JSON exactly shaped {"dominant":"<COLOR>"}; do not rename or add fields.',
].join(" ");

const VISION_SMOKE_TOOL = Object.freeze({
  name: "submit_vision_smoke",
  description: "Report the two colors actually visible in the calibration image.",
  input_schema: {
    type: "object", additionalProperties: false,
    properties: {
      dominant: { type: "string", enum: ["RED", "GREEN", "BLUE", "YELLOW", "UNAVAILABLE"] },
    },
    required: ["dominant"],
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

function parseVisionSmokeAnswer(raw: string): Readonly<{ dominant: string }> {
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => key !== "dominant")
      || typeof value.dominant !== "string") {
      throw new Error("invalid shape");
    }
    return Object.freeze({ dominant: value.dominant.toUpperCase() });
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
        screenIntegrity: { type: "string", enum: ["PASS", "PRODUCT_DEFECT"] },
        screenIntegrityReason: { type: "string", minLength: 1, maxLength: 500 },
        status: { type: "string", enum: PLAYER_POLICY_STATUSES },
        observation: { type: "string", minLength: 1, maxLength: 500 },
        rationale: { type: "string", minLength: 1, maxLength: 500 },
        actions: { type: "array", maxItems: 4, items: { oneOf: actionVariants } },
      },
      required: ["screenIntegrity", "screenIntegrityReason", "status", "observation", "rationale", "actions"],
    },
  });
}

const E2E_PLAYER_WIDTH = 1280;
const E2E_PLAYER_HEIGHT = 720;
const E2E_PROVIDER_WIDTH = 640;
const E2E_PROVIDER_HEIGHT = 360;
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

function messagesEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/messages`.replace(/\/{2,}/g, "/");
  return url.href;
}

function digestBase64(value: string): string {
  let bytes: Buffer;
  try { bytes = Buffer.from(value, "base64"); } catch { throw invalid("Screenshot encoding is invalid"); }
  if (bytes.length < 33 || bytes.length > MAX_PLAYER_POLICY_SCREENSHOT_BYTES || bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== E2E_PLAYER_WIDTH || bytes.readUInt32BE(20) !== E2E_PLAYER_HEIGHT) {
    throw invalid("Screenshot encoding is invalid");
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function downsamplePlayerFrame(value: string): Promise<string> {
  try {
    const resized = await sharp(Buffer.from(value, "base64"), { limitInputPixels: E2E_PLAYER_WIDTH * E2E_PLAYER_HEIGHT })
      .resize(E2E_PROVIDER_WIDTH, E2E_PROVIDER_HEIGHT, { fit: "fill", kernel: "lanczos3" })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    return resized.toString("base64");
  } catch {
    throw providerFailure("Core could not prepare the downsampled Test Agent frame");
  }
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
    /\b(?:prompt|message|input|context)\b.{0,120}\b(?:does|did)\s+not\b.{0,60}\b(?:include|provide|show|contain|present)\b.{0,60}\b(?:image|frame|pixels?)\b/i,
    /\b(?:cannot|can't|unable to)\b.{0,80}\b(?:see|view|access|inspect|identify|verify)\b.{0,80}\b(?:image|frame|pixels?|ui|controls?|geometry)\b/i,
    /\bno\b.{0,100}\b(?:controls?|buttons?|menus?|dialogs?|ui|gameplay elements?|interactive layers?|keyboard hints?|pointer targets?)\b.{0,80}\b(?:discernible|identifiable|grounded|verifiable|verified|visible)\b/i,
    /\bno\b.{0,100}\b(?:controls?|control labels?|buttons?|menus?|dialogs?|ui|gameplay elements?|interactive layers?|keyboard hints?|pointer targets?|target bounds?)\b.{0,100}\b(?:available|exposed|visible|discernible|identifiable|identified|grounded|verifiable|verified|provided|present)\b/i,
    /\bno\b.{0,50}\b(?:discernible|identifiable|grounded|verifiable|verified|visible)\b.{0,100}\b(?:pixels?|controls?|buttons?|menus?|dialogs?|ui|gameplay elements?|interactive layers?|keyboard hints?|pointer targets?)\b/i,
    /\b(?:controls?|buttons?|menus?|dialogs?|ui|gameplay elements?|interactive layers?|keyboard hints?|pointer targets?)\b.{0,100}\b(?:cannot|can't|unable to|not)\b.{0,60}\b(?:discerned|identified|grounded|verified)\b/i,
    /(?:当前|本次)?.{0,20}(?:消息|输入|对话|上下文).{0,30}(?:未|没有).{0,20}(?:呈现|提供|包含|给出).{0,30}(?:可读取|可见|可访问)?.{0,20}(?:截图|图像|像素|游戏画面|游戏截图)/u,
    /(?:画面|帧|截图).{0,20}未.{0,20}(?:消息|输入|对话|上下文).{0,20}(?:呈现|提供|包含|给出).{0,30}(?:可读取|可见|可访问)?.{0,20}(?:截图|图像|像素|游戏画面|游戏截图)/u,
    /(?:无法|不能|未能).{0,40}(?:查看|看到|访问|检查|核验|确认|识别|读取).{0,40}(?:画面|图像|截图|帧|像素|界面|控件)/u,
    /(?:画面|图像|截图|帧|像素|界面|可见内容).{0,40}(?:信息|内容)?.{0,20}(?:不足以|不足|不可用|未提供|无法访问|无法查看).{0,50}(?:确认|识别|判断|核验|安全)/u,
    /(?:未见|看不到|没有).{0,50}(?:可见|明确|可确认|可识别|可依据|可读取).{0,40}(?:按钮|控件|菜单|弹窗|界面|元素|目标|提示|像素)/u,
  ].some(pattern => pattern.test(observation));
  if (unavailable) throw visionUnavailable("Test Agent model did not inspect the attached game screenshot");
}

function assertUnrecoverableFollowsRecovery(decision: PlayerPolicyDecision, request: PlayerPolicyRequest): void {
  if (decision.screenIntegrity === "PASS" && decision.status === "UNRECOVERABLE" && !request.recovery) {
    throw new Error("Test Agent cannot declare UNRECOVERABLE before recovery mode");
  }
}

function assertDecisionExploresAfterNoProgress(decision: PlayerPolicyDecision, request: PlayerPolicyRequest): void {
  const recent = request.history.slice(-3).filter(item => /no verified progress/i.test(item.result));
  if (recent.length === 0 || decision.status !== "CONTINUE") return;
  const previousActions = recent.flatMap(item => item.actions);
  if (decision.actions.every(action => action.type === "wait")
    && recent.at(-1)?.actions.every(action => action.type === "wait")) {
    throw new Error("Test Agent repeated a wait after no verified progress; inspect the current pixels and choose a different visible action");
  }
  for (const action of decision.actions) {
    if (previousActions.some(previous => equivalentNoProgressAction(action, previous))) {
      throw new Error("Test Agent repeated an action that made no verified progress; choose a different visible control or input");
    }
  }
}

function equivalentNoProgressAction(left: PlayerPolicyAction, right: PlayerPolicyAction): boolean {
  const pointerTypes = new Set(["click", "double_click"]);
  if (pointerTypes.has(left.type) && pointerTypes.has(right.type)) {
    return typeof left.x === "number" && typeof left.y === "number"
      && typeof right.x === "number" && typeof right.y === "number"
      && Math.abs(left.x - right.x) <= 32 && Math.abs(left.y - right.y) <= 32;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}
function safeTokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}
