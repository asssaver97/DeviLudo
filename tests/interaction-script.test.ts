import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateInteractionScript } from "../lib/product/interaction-script.js";

describe("InteractionScript validation", () => {
  it("accepts valid interaction script", () => {
    const script = {
      version: "1",
      events: [
        { type: "key_press", key: "KEY_SPACE", delay_ms: 100 },
        { type: "wait", delay_ms: 500 },
        { type: "mouse_move", x: 100, y: 200 },
        { type: "mouse_click", button: "LEFT" },
        { type: "key_release", key: "KEY_SPACE" },
      ],
    };
    assert.ok(validateInteractionScript(script));
  });

  it("rejects wrong version", () => {
    const script = { version: "2", events: [] };
    assert.ok(!validateInteractionScript(script));
  });

  it("rejects missing events", () => {
    const script = { version: "1" };
    assert.ok(!validateInteractionScript(script));
  });

  it("rejects invalid event type", () => {
    const script = {
      version: "1",
      events: [{ type: "invalid", key: "KEY_A" }],
    };
    assert.ok(!validateInteractionScript(script));
  });

  it("rejects key_press without key", () => {
    const script = {
      version: "1",
      events: [{ type: "key_press", delay_ms: 100 }],
    };
    assert.ok(!validateInteractionScript(script));
  });

  it("rejects mouse_move without coordinates", () => {
    const script = {
      version: "1",
      events: [{ type: "mouse_move", x: 100 }],
    };
    assert.ok(!validateInteractionScript(script));
  });

  it("rejects mouse_click with invalid button", () => {
    const script = {
      version: "1",
      events: [{ type: "mouse_click", button: "INVALID" }],
    };
    assert.ok(!validateInteractionScript(script));
  });

  it("rejects wait without delay_ms", () => {
    const script = {
      version: "1",
      events: [{ type: "wait" }],
    };
    assert.ok(!validateInteractionScript(script));
  });

  it("accepts events without optional delay_ms", () => {
    const script = {
      version: "1",
      events: [
        { type: "key_press", key: "KEY_A" },
        { type: "mouse_move", x: 50, y: 50 },
      ],
    };
    assert.ok(validateInteractionScript(script));
  });

  it("rejects non-object", () => {
    assert.ok(!validateInteractionScript(null));
    assert.ok(!validateInteractionScript("string"));
    assert.ok(!validateInteractionScript(123));
    assert.ok(!validateInteractionScript([]));
  });
});
