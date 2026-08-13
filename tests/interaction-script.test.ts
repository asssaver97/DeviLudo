import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GAME_CLIENT_HEIGHT,
  GAME_CLIENT_WIDTH,
  MAX_INTERACTION_EVENTS,
  interactionHasUserAction,
  type InteractionScript,
  validateInteractionScript,
} from "../lib/product/interaction-script.js";

describe("InteractionScript v2 validation", () => {
  const valid = () => ({
    version: "2",
    events: [
      { type: "checkpoint", id: "game-start", role: "START", expectedOutput: "DEVILUDO_E2E_CHECKPOINT:game-start" },
      { type: "key_press", key: "KEY_SPACE", delay_ms: 100 },
      { type: "key_release", key: "KEY_SPACE" },
      { type: "mouse_move", x: 100, y: 200 },
      { type: "mouse_click", button: "LEFT" },
      { type: "wait", delay_ms: 500 },
      { type: "checkpoint", id: "first-action", role: "KEY_STATE", referenceImage: "screenshots/first-action.png", threshold: 0.01 },
      { type: "checkpoint", id: "game-complete", role: "COMPLETION", expectedOutput: "DEVILUDO_E2E_CHECKPOINT:game-complete" },
    ],
  });

  it("accepts real input and checkpoint events", () => assert.ok(validateInteractionScript(valid())));
  it("distinguishes actionable input from waits, movement, releases, and screenshots", () => {
    assert.equal(interactionHasUserAction(valid() as InteractionScript), true);
    assert.equal(interactionHasUserAction({
      version: "2",
      events: [
        { type: "wait", delay_ms: 10 },
        { type: "mouse_move", x: 1, y: 1 },
        { type: "key_release", key: "KEY_SPACE" },
        { type: "checkpoint", id: "still", role: "START" },
      ],
    }), false);
  });
  it("accepts canonical and legacy-compatible supported key names", () => {
    for (const key of ["KEY_P", "P", "KEY_SPACE", "SPACE", "KEY_0", "0", "KEY_LEFT", "LEFT"]) {
      assert.ok(validateInteractionScript({ version: "2", events: [{ type: "key_press", key }] }));
    }
  });
  it("rejects the legacy v1 protocol", () => assert.ok(!validateInteractionScript({ version: "1", events: [] })));
  it("rejects missing or excessive events", () => {
    assert.ok(!validateInteractionScript({ version: "2" }));
    assert.ok(!validateInteractionScript({ version: "2", events: [] }));
    assert.ok(!validateInteractionScript({ version: "2", events: Array.from({ length: MAX_INTERACTION_EVENTS + 1 }, () => ({ type: "wait", delay_ms: 1 })) }));
  });
  it("rejects invalid input events", () => {
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "invalid" }] }));
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "key_press" }] }));
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "key_press", key: "KEY_F13" }] }));
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "key_press", key: "PAUSE_MENU" }] }));
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "mouse_click", button: "INVALID" }] }));
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "wait" }] }));
  });
  it("enforces coordinates inside the fixed 1280x720 client area", () => {
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "mouse_move", x: GAME_CLIENT_WIDTH, y: 0 }] }));
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "mouse_move", x: 0, y: GAME_CLIENT_HEIGHT }] }));
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "mouse_move", x: -1, y: 0 }] }));
  });
  it("rejects duplicate checkpoints and unsafe baseline paths", () => {
    const duplicate = valid();
    duplicate.events.push({ type: "checkpoint", id: "game-start", role: "KEY_STATE", expectedOutput: "DEVILUDO_E2E_CHECKPOINT:game-start" });
    assert.ok(!validateInteractionScript(duplicate));
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "checkpoint", id: "bad", role: "START", referenceImage: "../secret.png" }] }));
    assert.ok(!validateInteractionScript({ version: "2", events: [{ type: "checkpoint", id: "state", role: "START", expectedOutput: "wrong" }] }));
  });
  it("rejects non-object values", () => {
    for (const value of [null, "string", 123, []]) assert.ok(!validateInteractionScript(value));
  });
});
