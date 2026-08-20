import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import {
  generateE2ePlayerDecision,
  parsePlayerPolicyDecision,
  parsePlayerPolicyRequest,
  playerPolicyIdempotencyInput,
  verifyE2ePlayerVision,
} from "@/services/core/src/e2e-player-policy";
import type { CodexPromptInput } from "@/services/core/src/codex-cli";

test("E2E node preserves the complete player-policy provider budget", async () => {
  const source = await readFile(new URL("../services/e2e-node/src/core-client.ts", import.meta.url), "utf8");
  assert.match(source, /path\.includes\("\/test-plan"\) \? 540_000[\s\S]*path\.includes\("\/player-policy"\) \? 480_000/);
});

test("Core reuses a successful visual capability check for the same settings revision", async () => {
  const source = await readFile(new URL("../services/core/src/api.ts", import.meta.url), "utf8");
  assert.match(source, /settings\.testPolicyReady && settings\.testPolicyCheckedRevision === settings\.revision/);
  assert.match(source, /event: "e2e_player_vision_failed"/);
});

function testPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((1 + width * 3) * height, 32);
  for (let y = 0; y < height; y += 1) pixels[y * (1 + width * 3)] = 0;
  const chunk = (kind: string, data: Buffer) => {
    const type = Buffer.from(kind, "ascii");
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length, 0);
    type.copy(output, 4);
    data.copy(output, 8);
    output.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 8 + data.length);
    return output;
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const screenshotBytes = testPng(1280, 720);
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
    screenIntegrity: "PASS",
    screenIntegrityReason: "The clean menu is isolated from gameplay and all controls are readable.",
    status: "CONTINUE",
    observation: "A playable menu is visible.",
    rationale: "Click the visible play control.",
    actions,
  });
}

function calibrationPanelColors(body: Record<string, unknown>): readonly [readonly number[], readonly number[]] {
  const messages = body.messages as readonly Record<string, unknown>[];
  const content = messages[0]?.content as readonly Record<string, unknown>[];
  const image = content.find(item => item.type === "image");
  const source = image?.source as Record<string, unknown> | undefined;
  assert.equal(source?.media_type, "image/png");
  const png = Buffer.from(String(source?.data ?? ""), "base64");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const checksum = png.readUInt32BE(offset + 8 + length);
    assert.equal(checksum, crc32(Buffer.concat([type, data])) >>> 0, `${type.toString("ascii")} CRC must be valid`);
    const kind = type.toString("ascii");
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual([...data.subarray(8, 13)], [8, 2, 0, 0, 0]);
    } else if (kind === "IDAT") compressed.push(data);
    offset += 12 + length;
  }
  assert.equal(width, 64);
  assert.equal(height, 64);
  const rowBytes = 1 + width * 3;
  const pixels = inflateSync(Buffer.concat(compressed));
  assert.equal(pixels.length, rowBytes * height);
  for (let y = 0; y < height; y += 1) assert.equal(pixels[y * rowBytes], 0, "calibration rows must use the no-filter format");
  const colorAt = (x: number, y: number) => [...pixels.subarray(y * rowBytes + 1 + x * 3, y * rowBytes + 1 + x * 3 + 3)];
  return [colorAt(0, 32), colorAt(63, 32)];
}

describe("E2E Test Agent policy", () => {
  test("proves visual input with two synthetic color challenges", async () => {
    const bodies: Record<string, unknown>[] = [];
    const answers = [
      { dominant: "RED" },
      { dominant: "YELLOW" },
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
    assert.doesNotMatch(first, /expected|square is/i);
    assert.deepEqual(calibrationPanelColors(bodies[0]!), [[255, 0, 0], [255, 0, 0]]);
    assert.deepEqual(calibrationPanelColors(bodies[1]!), [[255, 255, 0], [255, 255, 0]]);
  });

  test("rejects a text-only route during visual preflight", async () => {
    let calls = 0;
    const inputs: CodexPromptInput[] = [];
    await assert.rejects(verifyE2ePlayerVision({
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "text-only-model",
      codexRunner: async input => {
        inputs.push(input);
        calls += 1;
        return JSON.stringify({ dominant: "UNAVAILABLE" });
      },
    }), (error: unknown) => (error as { code?: string }).code === "PLAYER_POLICY_VISION_UNAVAILABLE");
    assert.equal(calls, 1);
    assert.equal(inputs[0]?.reasoningEffort, "low");
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
    const denseFrame = Buffer.concat([screenshotBytes, Buffer.alloc(1_500_000, 1)]);
    assert.equal(parsePlayerPolicyRequest({
      ...request(),
      screenshotBase64: denseFrame.toString("base64"),
      screenshotSha256: `sha256:${createHash("sha256").update(denseFrame).digest("hex")}`,
    }).screenshotSha256, `sha256:${createHash("sha256").update(denseFrame).digest("hex")}`);
    const oversizedFrame = Buffer.concat([screenshotBytes, Buffer.alloc(4 * 1024 * 1024, 1)]);
    assert.throws(() => parsePlayerPolicyRequest({
      ...request(),
      screenshotBase64: oversizedFrame.toString("base64"),
      screenshotSha256: `sha256:${createHash("sha256").update(oversizedFrame).digest("hex")}`,
    }), /invalid/i);
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

  test("keeps history and decisions in full-client coordinates", () => {
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

  test("accepts a visual product defect only when it refuses to click through it", () => {
    const defect = parsePlayerPolicyDecision(JSON.stringify({
      screenIntegrity: "PRODUCT_DEFECT",
      screenIntegrityReason: "A start dialog is drawn over an active board, HUD, and gameplay toolbar.",
      status: "UNRECOVERABLE",
      observation: "The centered start dialog visibly overlaps an already populated board and active controls.",
      rationale: "The contradictory startup lifecycle must be repaired instead of dismissed.",
      actions: [],
    }), ["POINTER"]);
    assert.equal(defect.screenIntegrity, "PRODUCT_DEFECT");
    assert.equal(defect.actions.length, 0);
    assert.throws(() => parsePlayerPolicyDecision(JSON.stringify({ ...defect, actions: [{ type: "click", x: 640, y: 360 }] }), ["POINTER"]), /shape/i);
  });

  test("repairs malformed provider JSON once without exposing Probe or logs", async () => {
    const calls: CodexPromptInput[] = [];
    const responses = [
      "not-json",
      decision(),
    ];
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "test-model",
      codexRunner: async input => {
        calls.push(input);
        return responses.shift() ?? "";
      },
    });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.reasoningEffort === "low"));
    assert.equal(result.decision.actions[0]?.type, "click");
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
    const providerInput = JSON.stringify(calls);
    assert.doesNotMatch(providerInput, /uiProbe|godotLogs|stderr|stdout/i);
    const providerPng = Buffer.from(calls[0]?.imageBase64 ?? "", "base64");
    assert.equal(providerPng.readUInt32BE(16), 1280);
    assert.equal(providerPng.readUInt32BE(20), 720);
    assert.match(providerInput, /attached 1280x720 image is the exact current game client frame/);
    assert.match(providerInput, /at least one concrete visual fact/);
    assert.match(providerInput, /Do not repeatedly wait on a rendered, unchanged interface/);
    assert.match(providerInput, /attached frame, returned pointer actions, and action history all use integer coordinates in the same full 1280x720 client/);
    assert.doesNotMatch(providerInput, /screenshot, action history, and returned inputs all share this one coordinate space/);
    assert.match(providerInput, /top-left origin of the unmodified frame/);
    assert.doesNotMatch(providerInput, /guide lines|drawgrid/i);
    assert.doesNotMatch(providerInput, /multiply observed x\/y coordinates by 2/);
    assert.match(providerInput, /approximate left, top, right, and bottom pixel bounds/);
    assert.match(providerInput, /topmost interactive layer/);
    assert.match(providerInput, /starts with clean user data/);
    assert.match(providerInput, /fresh playable session/);
    assert.match(providerInput, /title\/menu over passive artwork is valid/);
    assert.match(providerInput, /tutorial, help, pause, confirmation, or settings modal over a dimmed active game is also a legitimate topmost interaction layer/);
    assert.match(providerInput, /active board, HUD, tutorial, gameplay controls/);
    assert.match(providerInput, /Never click through, dismiss, or work around a PRODUCT_DEFECT/);
    assert.match(providerInput, /Never send a keyboard key through a blocking overlay/);
    assert.match(providerInput, /Do not guess SPACE, ENTER, movement keys/);
    assert.deepEqual(result.decision.actions[0], { type: "click", x: 640, y: 360 });
  });

  test("tells the provider why a structured decision needs repair", async () => {
    const prompts: CodexPromptInput[] = [];
    const invalidDecision = JSON.stringify({
      status: "CONTINUE", observation: "The launch menu is visible.",
      rationale: "I should continue.", actions: [],
    });
    let attempts = 0;
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "test-model",
      codexRunner: async input => {
        prompts.push(input);
        attempts += 1;
        return attempts === 1 ? invalidDecision : decision();
      },
    });
    assert.equal(result.decision.actions[0]?.type, "click");
    assert.match(prompts[1]?.prompt ?? "", /Validation error: Test Agent decision shape is invalid/);
  });

  test("accepts a grounded repeated click so the bounded guest loop detector can recover", async () => {
    let calls = 0;
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest({
        ...request(),
        history: [{
          decisionIndex: 6,
          observation: "A lower-middle rectangular control was visible.",
          actions: [{ type: "click", x: 640, y: 395 }],
          result: "no verified progress",
        }],
      }),
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "test-model",
      codexRunner: async () => {
        calls += 1;
        return decision([{ type: "double_click", x: 650, y: 400 }]);
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.decision.actions[0], { type: "double_click", x: 650, y: 400 });
  });

  test("repairs consecutive no-progress waits instead of accepting an infinite loading loop", async () => {
    let calls = 0;
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest({
        ...request(),
        history: [{
          decisionIndex: 6,
          observation: "A dark rendered panel was visible.",
          actions: [{ type: "wait", duration_ms: 500 }],
          result: "no verified progress",
        }],
      }),
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "test-model",
      codexRunner: async () => {
        calls += 1;
        const actions = calls === 1
          ? [{ type: "wait", duration_ms: 100 }]
          : [{ type: "click", x: 300, y: 220 }];
        return decision(actions);
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(result.decision.actions[0], { type: "click", x: 300, y: 220 });
  });

  test("repairs a premature unrecoverable decision into a safe observation wait", async () => {
    const prompts: CodexPromptInput[] = [];
    let calls = 0;
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest({ ...request(), history: [], decisionIndex: 0, recovery: false }),
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "test-model",
      codexRunner: async input => {
        prompts.push(input);
        calls += 1;
        const output = calls === 1
          ? JSON.stringify({
            screenIntegrity: "PASS",
            screenIntegrityReason: "The loading frame is coherent and does not show contradictory lifecycle layers.",
            status: "UNRECOVERABLE",
            observation: "The visible frame is still loading.",
            rationale: "No safe control is clear yet.",
            actions: [],
          })
          : JSON.stringify({
            screenIntegrity: "PASS",
            screenIntegrityReason: "The loading frame is coherent and does not show contradictory lifecycle layers.",
            status: "CONTINUE",
            observation: "The visible frame is still loading.",
            rationale: "Wait briefly for the topmost layer to finish rendering.",
            actions: [{ type: "wait", duration_ms: 1_000 }],
          });
        return output;
      },
    });
    assert.deepEqual(result.decision.actions[0], { type: "wait", duration_ms: 1_000 });
    assert.match(prompts[1]?.prompt ?? "", /cannot declare UNRECOVERABLE before recovery mode/);
  });

  test("classifies provider failures as infrastructure errors", async () => {
    await assert.rejects(generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CODEX_CLI",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      model: "test-model",
      codexRunner: async () => { throw new Error("rate limited"); },
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
    "No concrete game controls or topmost interactive layer are discernible in the provided current frame context.",
    "No concrete clickable control, dialog button, or visible keyboard hint can be safely identified in the current frame context.",
    "The current provided frame contains no discernible UI pixels or readable control labels.",
    "No safely identifiable visible button, dialog control, or keyboard hint is available in the current frame context.",
    "The current client frame is present, but no readable control label or blocking dialog is exposed in the available visual description.",
    "No target bounds are currently available for a grounded pointer action.",
    "The supplied prompt does not include a readable pixel frame in the text available to me.",
    "当前消息中未呈现可读取的1280×720游戏像素或附图，因此无法核验顶层交互层。",
    "当前输入明确给出客户端画布为1280×720；但此刻可见内容不足以安全确认任何按钮。",
    "当前帧未在消息中呈现可读取的截图像素，无法确认按钮、对话框或键盘提示。",
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
    assert.equal(calls, 4);
  });

  test("retries one lost image attachment only after independent vision calibration", async () => {
    let calls = 0;
    const bodies: Record<string, unknown>[] = [];
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CLAUDE_CODE",
      baseUrl: "https://provider.example",
      apiKey: "secret",
      model: "test-model",
      fetchImpl: async (_url, init) => {
        calls += 1;
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const parsed = JSON.parse(decision()) as Record<string, unknown>;
        return new Response(JSON.stringify({ content: [{
          type: "tool_use",
          name: "submit_player_decision",
          input: calls === 1
            ? { ...parsed, observation: "I cannot inspect the current image." }
            : parsed,
        }] }), { status: 200 });
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.decision.actions[0]?.type, "click");
    assert.doesNotMatch(JSON.stringify(bodies[1]), /previous response was invalid|visual inspection was unavailable/i);
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

  test("keeps transport and clean image retry budgets independent", async () => {
    let calls = 0;
    const result = await generateE2ePlayerDecision({
      request: parsePlayerPolicyRequest(request()),
      runtime: "CLAUDE_CODE",
      baseUrl: "https://provider.example",
      apiKey: "secret",
      model: "test-model",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response("temporarily unavailable", { status: 503 });
        const parsed = JSON.parse(decision()) as Record<string, unknown>;
        return new Response(JSON.stringify({ content: [{
          type: "tool_use",
          name: "submit_player_decision",
          input: calls < 5 ? { ...parsed, observation: "I cannot inspect the current image." } : parsed,
        }] }), { status: 200 });
      },
    });
    assert.equal(calls, 5);
    assert.equal(result.decision.actions[0]?.type, "click");
  });
});
