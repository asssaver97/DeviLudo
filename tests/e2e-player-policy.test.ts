import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  generateE2ePlayerDecision,
  parsePlayerPolicyDecision,
  parsePlayerPolicyRequest,
} from "@/services/core/src/e2e-player-policy";

const screenshotBytes = Buffer.alloc(33);
screenshotBytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
screenshotBytes.writeUInt32BE(13, 8);
screenshotBytes.write("IHDR", 12, "ascii");
screenshotBytes.writeUInt32BE(640, 16);
screenshotBytes.writeUInt32BE(360, 20);
const screenshotBase64 = screenshotBytes.toString("base64");
const screenshotSha256 = `sha256:${createHash("sha256").update(screenshotBytes).digest("hex")}`;

function request() {
  return {
    rolloutIndex: 1,
    decisionIndex: 7,
    screenshotBase64,
    screenshotSha256,
    goal: "Enter the game and complete one core gameplay loop.",
    allowedActions: ["KEYBOARD", "POINTER", "GAMEPAD"],
    history: [{
      decisionIndex: 6,
      observation: "The game menu is visible.",
      actions: [{ type: "click", x: 640, y: 360 }],
      result: "The play button became highlighted.",
    }],
    recovery: false,
  } as const;
}

function decision(actions: readonly Record<string, unknown>[] = [{ type: "click", x: 640, y: 360 }]) {
  return JSON.stringify({
    status: "CONTINUE",
    observation: "A playable menu is visible.",
    rationale: "Click the visible play control.",
    actions,
  });
}

describe("E2E Test Agent policy", () => {
  test("accepts a screenshot-only bounded request and rejects stale or oversized inputs", () => {
    const parsed = parsePlayerPolicyRequest(request());
    assert.equal(parsed.screenshotSha256, screenshotSha256);
    assert.equal(parsed.history.length, 1);
    assert.throws(() => parsePlayerPolicyRequest({ ...request(), screenshotSha256: `sha256:${"0".repeat(64)}` }), /invalid/i);
    assert.throws(() => parsePlayerPolicyRequest({ ...request(), rolloutIndex: 3 }), /invalid/i);
    assert.throws(() => parsePlayerPolicyRequest({ ...request(), decisionIndex: 40 }), /invalid/i);
    assert.throws(() => parsePlayerPolicyRequest({ ...request(), history: Array.from({ length: 7 }, (_, decisionIndex) => ({
      decisionIndex, observation: "visible", actions: [], result: "unchanged",
    })) }), /invalid/i);
    assert.throws(() => parsePlayerPolicyRequest({ ...request(), history: [{
      decisionIndex: 7, observation: "visible", actions: [], result: "unchanged",
    }] }), /order/i);
    assert.throws(() => parsePlayerPolicyRequest({ ...request(), history: [{
      decisionIndex: 6, observation: "visible", actions: [{ type: "click", x: 5000, y: 1 }], result: "changed",
    }] }), /unsafe action/i);
  });

  test("allows only bounded in-client keyboard, pointer and gamepad actions", () => {
    assert.equal(parsePlayerPolicyDecision(decision(), ["POINTER"]).actions.length, 1);
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "click", x: 1280, y: 10 }]), ["POINTER"]), /outside/i);
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "scroll", deltaY: 120 }]), ["POINTER"]), /scroll/i);
    assert.equal(parsePlayerPolicyDecision(decision([{ type: "drag", fromX: 10, fromY: 20, toX: 30, toY: 40, duration_ms: 200 }]), ["POINTER"]).actions[0]?.type, "drag");
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "drag", fromX: -1, fromY: 20, toX: 30, toY: 40, duration_ms: 200 }]), ["POINTER"]), /drag/i);
    assert.equal(parsePlayerPolicyDecision(decision([{ type: "text_input", text: "player one" }]), ["KEYBOARD"]).actions[0]?.type, "text_input");
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "text_input", text: "unsafe\ninput" }]), ["KEYBOARD"]), /text input/i);
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "click", x: 1, y: 1, shell: "open evil" }]), ["POINTER"]), /undeclared fields/i);
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "key_tap", key: "CMD+Q" }]), ["KEYBOARD"]), /key/i);
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "gamepad_axis", axis: "LEFT_X", value: 1.1 }]), ["GAMEPAD"]), /axis/i);
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "gamepad_button_tap", button: "A" }]), ["KEYBOARD"]), /allowed action space/i);
    assert.throws(() => parsePlayerPolicyDecision(decision(Array.from({ length: 5 }, () => ({ type: "click", x: 1, y: 1 }))), ["POINTER"]), /shape/i);
  });

  test("repairs malformed provider JSON once without exposing Probe or logs", async () => {
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      { output_text: "not-json", usage: { input_tokens: 11, output_tokens: 2 } },
      { output_text: decision(), usage: { input_tokens: 13, output_tokens: 7 } },
    ];
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "test-model",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(bodies.length, 2);
    assert.equal(result.decision.actions[0]?.type, "click");
    assert.equal(result.inputTokens, 24);
    assert.equal(result.outputTokens, 9);
    const providerInput = JSON.stringify(bodies);
    assert.doesNotMatch(providerInput, /uiProbe|godotLogs|stderr|stdout/i);
    assert.match(providerInput, /data:image\/png;base64/);
  });

  test("classifies provider failures as infrastructure errors", async () => {
    await assert.rejects(generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "test-model",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    }), (error: unknown) => {
      const value = error as Error & { code?: string; statusCode?: number };
      return value.code === "PLAYER_POLICY_PROVIDER" && value.statusCode === 503;
    });
  });
});
