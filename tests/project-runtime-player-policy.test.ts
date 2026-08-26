import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parsePlayerPolicyDecision,
  parsePlayerPolicyRequest,
  playerPolicyIdempotencyInput,
} from "@/services/core/src/e2e-player-policy";

test("native runner input is bounded before the Test Runtime sees it", () => {
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  Buffer.from("IHDR", "ascii").copy(png, 12);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(720, 20);
  const screenshotBase64 = png.toString("base64");
  const screenshotSha256 = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  const request = parsePlayerPolicyRequest({
    rolloutIndex: 0,
    decisionIndex: 0,
    screenshotBase64,
    screenshotSha256,
    goal: "Start a real playable session",
    allowedActions: ["KEYBOARD", "POINTER"],
    history: [],
    recovery: false,
  });
  assert.deepEqual(playerPolicyIdempotencyInput(request), {
    goal: "Start a real playable session",
    allowedActions: ["KEYBOARD", "POINTER"],
  });
  assert.throws(() => parsePlayerPolicyRequest({ ...request, screenshotSha256: `sha256:${"0".repeat(64)}` }), /invalid/);
});

test("Test Runtime decisions cannot escape the native input allowlist", () => {
  const decision = parsePlayerPolicyDecision(JSON.stringify({
    screenIntegrity: "PASS",
    screenIntegrityReason: "The game frame is intact.",
    status: "CONTINUE",
    observation: "The start button is visible.",
    rationale: "Activate the focused start action.",
    actions: [{ type: "key_tap", key: "ENTER" }],
  }), ["KEYBOARD"]);
  assert.equal(decision.actions[0]?.type, "key_tap");
  assert.throws(() => parsePlayerPolicyDecision(JSON.stringify({
    screenIntegrity: "PASS",
    screenIntegrityReason: "The game frame is intact.",
    status: "CONTINUE",
    observation: "Try an unsafe click.",
    rationale: "Outside the frame.",
    actions: [{ type: "click", x: 2000, y: 10 }],
  }), ["POINTER"]), /outside the game frame/);
});
