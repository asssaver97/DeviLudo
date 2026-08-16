import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import {
  generateE2ePlayerDecision,
  parsePlayerPolicyDecision,
  parsePlayerPolicyRequest,
  playerPolicyIdempotencyInput,
  verifyE2ePlayerVision,
} from "@/services/core/src/e2e-player-policy";

test("E2E node preserves the complete player-policy provider budget", async () => {
  const source = await readFile(new URL("../services/e2e-node/src/core-client.ts", import.meta.url), "utf8");
  assert.match(source, /path\.includes\("\/player-policy"\) \? 60_000 : 10_000/);
});

const screenshotBytes = Buffer.alloc(33);
screenshotBytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
screenshotBytes.writeUInt32BE(13, 8);
screenshotBytes.write("IHDR", 12, "ascii");
screenshotBytes.writeUInt32BE(1280, 16);
screenshotBytes.writeUInt32BE(720, 20);
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
  test("proves visual input with two synthetic color challenges", async () => {
    const bodies: Record<string, unknown>[] = [];
    const answers = [
      { left: "RED", right: "BLUE" },
      { left: "BLUE", right: "YELLOW" },
    ];
    await verifyE2ePlayerVision({
      runtime: "CLAUDE_CODE",
      baseUrl: "https://provider.example",
      apiKey: "secret",
      model: "visual-model",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ content: [{
          type: "tool_use", name: "submit_vision_smoke", input: answers.shift(),
        }] }), { status: 200 });
      },
    });
    assert.equal(bodies.length, 2);
    const first = JSON.stringify(bodies[0]);
    const second = JSON.stringify(bodies[1]);
    assert.match(first, /"type":"image"/);
    assert.match(second, /"type":"image"/);
    assert.notEqual(first, second);
    assert.doesNotMatch(first, /expected|left panel is|right panel is/i);
  });

  test("rejects a text-only route during visual preflight", async () => {
    let calls = 0;
    await assert.rejects(verifyE2ePlayerVision({
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "text-only-model",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          output_text: JSON.stringify({ left: "UNAVAILABLE", right: "UNAVAILABLE" }),
        }), { status: 200 });
      },
    }), (error: unknown) => (error as { code?: string }).code === "PLAYER_POLICY_VISION_UNAVAILABLE");
    assert.equal(calls, 1);
  });

  test("reuses a decision across a clean node retry with different pixels", () => {
    const first = parsePlayerPolicyRequest(request());
    const changedScreenshot = Buffer.from(screenshotBytes);
    changedScreenshot[32] = 1;
    const retried = parsePlayerPolicyRequest({
      ...request(),
      screenshotBase64: changedScreenshot.toString("base64"),
      screenshotSha256: `sha256:${createHash("sha256").update(changedScreenshot).digest("hex")}`,
      history: [],
      recovery: true,
    });
    assert.deepEqual(playerPolicyIdempotencyInput(retried), playerPolicyIdempotencyInput(first));
  });

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

  test("uses one exact client coordinate space for screenshots, history and model decisions", () => {
    const parsed = parsePlayerPolicyRequest({
      ...request(),
      history: [{
        decisionIndex: 6,
        observation: "A generic full-window control was visible.",
        actions: [{ type: "click", x: 1279, y: 719 }],
        result: "The visible frame changed.",
      }],
    });
    assert.deepEqual(parsed.history[0]?.actions[0], { type: "click", x: 1279, y: 719 });
    assert.throws(() => parsePlayerPolicyRequest({
      ...request(),
      history: [{
        decisionIndex: 6,
        observation: "A generic full-window control was visible.",
        actions: [{ type: "click", x: 1280, y: 719 }],
        result: "unchanged",
      }],
    }), /unsafe action/i);
    assert.deepEqual(
      parsePlayerPolicyDecision(decision([{ type: "click", x: 1279, y: 719 }]), ["POINTER"]).actions[0],
      { type: "click", x: 1279, y: 719 },
    );
  });

  test("allows only bounded in-client keyboard, pointer and gamepad actions", () => {
    assert.equal(parsePlayerPolicyDecision(decision(), ["POINTER"]).actions.length, 1);
    assert.equal(parsePlayerPolicyDecision(decision([{ type: "click", x: 1279, y: 719 }]), ["POINTER"]).actions.length, 1);
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "click", x: 1280, y: 10 }]), ["POINTER"]), /outside/i);
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "scroll", deltaY: 120 }]), ["POINTER"]), /scroll/i);
    assert.equal(parsePlayerPolicyDecision(decision([{ type: "drag", fromX: 10, fromY: 20, toX: 30, toY: 40, duration_ms: 200 }]), ["POINTER"]).actions[0]?.type, "drag");
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "drag", fromX: -1, fromY: 20, toX: 30, toY: 40, duration_ms: 200 }]), ["POINTER"]), /drag/i);
    assert.equal(parsePlayerPolicyDecision(decision([{ type: "text_input", text: "player one" }]), ["KEYBOARD"]).actions[0]?.type, "text_input");
    assert.equal(parsePlayerPolicyDecision(decision([{ type: "wait", duration_ms: 1_000 }]), ["POINTER"]).actions[0]?.type, "wait");
    assert.throws(() => parsePlayerPolicyDecision(decision([{ type: "wait", duration_ms: 99 }]), ["POINTER"]), /wait/i);
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
    assert.match(providerInput, /attached 1280x720 image is the exact current game client/);
    assert.match(providerInput, /share this one coordinate space/);
    assert.match(providerInput, /guide lines are drawn at every x and y multiple of 80 pixels/);
    assert.match(providerInput, /approximate left, top, right, and bottom pixel bounds/);
    assert.match(providerInput, /topmost interactive layer/);
    assert.match(providerInput, /starts with clean user data/);
    assert.match(providerInput, /fresh playable session/);
    assert.match(providerInput, /Never send a keyboard key through a blocking overlay/);
    assert.match(providerInput, /Do not guess SPACE, ENTER, movement keys/);
    assert.deepEqual(result.decision.actions[0], { type: "click", x: 640, y: 360 });
  });

  test("tells the provider why a structured decision needs repair", async () => {
    const bodies: Record<string, unknown>[] = [];
    const invalidDecision = JSON.stringify({
      status: "CONTINUE", observation: "The launch menu is visible.",
      rationale: "I should continue.", actions: [],
    });
    let calls = 0;
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "test-model",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        calls += 1;
        return new Response(JSON.stringify({ output_text: calls === 1 ? invalidDecision : decision() }), { status: 200 });
      },
    });
    assert.equal(result.decision.actions[0]?.type, "click");
    assert.match(JSON.stringify(bodies[1]), /Validation error: Test Agent decision shape is invalid/);
  });

  test("repairs a premature unrecoverable decision into a safe observation wait", async () => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest({ ...request(), history: [], decisionIndex: 0, recovery: false }),
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "test-model",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        calls += 1;
        const output = calls === 1
          ? JSON.stringify({
            status: "UNRECOVERABLE",
            observation: "The visible frame is still loading.",
            rationale: "No safe control is clear yet.",
            actions: [],
          })
          : JSON.stringify({
            status: "CONTINUE",
            observation: "The visible frame is still loading.",
            rationale: "Wait briefly for the topmost layer to finish rendering.",
            actions: [{ type: "wait", duration_ms: 1_000 }],
          });
        return new Response(JSON.stringify({ output_text: output }), { status: 200 });
      },
    });
    assert.deepEqual(result.decision.actions[0], { type: "wait", duration_ms: 1_000 });
    assert.match(JSON.stringify(bodies[1]), /cannot declare UNRECOVERABLE before recovery mode/);
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

  for (const observation of [
    "No game-frame pixels are included in the accessible context.",
    "The current client frame is not exposed in the text view yet, so no control geometry can be safely identified.",
    "No game UI, overlay, button, or keyboard hint is visibly available in the current supplied frame.",
    "No current game pixels or visible UI controls are present in the supplied view.",
    "The provided frame description does not expose a readable topmost control or confirmed gameplay element yet.",
    "I am unable to verify control geometry because I cannot inspect the current image.",
  ]) test(`rejects text-only visual output: ${observation}`, async () => {
    let calls = 0;
    await assert.rejects(generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CLAUDE_CODE",
      baseUrl: "https://provider.example",
      apiKey: "secret",
      model: "text-only-model",
      fetchImpl: async () => {
        calls += 1;
        const unavailable = JSON.parse(decision()) as Record<string, unknown>;
        return new Response(JSON.stringify({ content: [{
          type: "tool_use",
          name: "submit_player_decision",
          input: { ...unavailable, observation },
        }] }), { status: 200 });
      },
    }), (error: unknown) => {
      const value = error as Error & { code?: string; statusCode?: number };
      return value.code === "PLAYER_POLICY_VISION_UNAVAILABLE" && value.statusCode === 503
        && !value.message.includes(observation);
    });
    assert.equal(calls, 1);
  });

  test("retries an HTML provider response without exposing its body", async () => {
    let calls = 0;
    let requestedUrl = "";
    let authorization = "";
    let providerBody: Record<string, unknown> = {};
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CLAUDE_CODE",
      baseUrl: "https://provider.example",
      apiKey: "secret",
      model: "test-model",
      fetchImpl: async (url, init) => {
        calls += 1;
        requestedUrl = String(url);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (calls === 1) return new Response("<!doctype html><title>edge error</title>", { status: 200, headers: { "content-type": "text/html" } });
        return new Response(JSON.stringify({
          content: [{ type: "tool_use", name: "submit_player_decision", input: JSON.parse(decision()) }],
        }), { status: 200 });
      },
    });
    assert.equal(calls, 2);
    assert.equal(requestedUrl, "https://provider.example/v1/messages");
    assert.equal(authorization, "Bearer secret");
    assert.deepEqual(providerBody.tool_choice, { type: "tool", name: "submit_player_decision" });
    assert.equal((providerBody.tools as readonly Record<string, unknown>[])[0]?.name, "submit_player_decision");
    const toolSchema = JSON.stringify(providerBody.tools);
    assert.match(toolSchema, /"enum":\["A","B","C"/);
    assert.match(toolSchema, /"DPAD_RIGHT"/);
    assert.match(toolSchema, /"LEFT_X","LEFT_Y","RIGHT_X","RIGHT_Y"/);
    assert.match(toolSchema, /horizontal pixel from the left edge/);
    assert.match(toolSchema, /vertical pixel from the top edge/);
    assert.equal(result.decision.actions[0]?.type, "click");
  });

  test("classifies persistent non-JSON provider responses as infrastructure errors", async () => {
    await assert.rejects(generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CLAUDE_CODE",
      baseUrl: "https://provider.example",
      apiKey: "secret",
      model: "test-model",
      fetchImpl: async () => new Response("<!doctype html><title>edge error</title>", { status: 200 }),
    }), (error: unknown) => {
      const value = error as Error & { code?: string; statusCode?: number };
      return value.code === "PLAYER_POLICY_PROVIDER" && value.statusCode === 503
        && !value.message.includes("doctype");
    });
  });

  test("retries a transient provider transport failure and never leaks it as Core 500", async () => {
    let calls = 0;
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CLAUDE_CODE",
      baseUrl: "https://provider.example",
      apiKey: "secret",
      model: "test-model",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ content: [{ type: "text", text: decision() }] }), { status: 200 });
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.decision.actions[0]?.type, "click");
  });
});
