import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_INTERACTION_EVENTS,
  interactionHasUserAction,
  validateInteractionScript,
} from "../lib/product/interaction-script.js";

const changedTurn = Object.freeze({ source: "PROGRESS", key: "turn", operator: "CHANGED" });

function valid() {
  return {
    events: [
      { type: "checkpoint", id: "game-start", role: "START", assertions: [{ source: "SCENE", operator: "EQUALS", value: "main" }], visualMode: "STABLE_REPLAY" },
      { type: "click", stepId: "activate-primary-control", intent: "PRIMARY_ACTION", targetId: "primary-control", coversRequirementIds: ["req-core-loop"], postconditions: [changedTurn], delay_ms: 100 },
      { type: "key_hold", stepId: "end-turn", intent: "COMPLETE_LOOP", key: "KEY_ENTER", duration_ms: 50, coversRequirementIds: ["req-core-loop"], postconditions: [changedTurn] },
      { type: "text_input", stepId: "name-save", intent: "FEATURE_ACTION", targetId: "save-name", text: "新档", coversRequirementIds: [], postconditions: [{ source: "CONTROL", targetId: "save-name", property: "text", operator: "EQUALS", value: "新档" }] },
      { type: "wait", delay_ms: 10 },
      { type: "checkpoint", id: "game-complete", role: "COMPLETION", assertions: [{ source: "STATE", key: "complete", operator: "EQUALS", value: true }], visualMode: "DYNAMIC", changeTargetId: "game-viewport" },
    ],
  };
}

describe("current InteractionScript validation", () => {
  it("accepts semantic targets, real keyboard/mouse input, text and probe assertions", () => {
    assert.equal(validateInteractionScript(valid()), true);
    assert.equal(interactionHasUserAction(valid() as never), true);
  });

  it("rejects versioned coordinate and raw-key event scripts", () => {
    assert.equal(validateInteractionScript({ version: "2", events: [
      { type: "key_press", key: "KEY_H" }, { type: "key_release", key: "KEY_H" },
    ] }), false);
    assert.equal(validateInteractionScript({ ...valid(), schemaVersion: "deviludo.interaction-script" }), false);
    assert.equal(validateInteractionScript({ events: [{ type: "mouse_move", x: 640, y: 360 }] }), false);
  });

  it("requires operation-after assertions and unique real-input step IDs", () => {
    const script = valid();
    const action = script.events[1] as Record<string, unknown>;
    assert.equal(validateInteractionScript({ ...script, events: [{ ...action, postconditions: [] }] }), false);
    assert.equal(validateInteractionScript({ ...script, events: [action, action] }), false);
  });

  it("validates semantic control IDs, supported inputs and bounded values", () => {
    const base = { stepId: "bad", intent: "FEATURE_ACTION", coversRequirementIds: [], postconditions: [changedTurn] };
    assert.equal(validateInteractionScript({ events: [{ ...base, type: "click", targetId: "../button" }] }), false);
    assert.equal(validateInteractionScript({ events: [{ ...base, type: "key_tap", key: "KEY_F13" }] }), false);
    assert.equal(validateInteractionScript({ events: [{ ...base, type: "scroll", targetId: "list", deltaY: 0 }] }), false);
    assert.equal(validateInteractionScript({ events: [{ ...base, type: "drag", fromTargetId: "card", toTargetId: "slot", duration_ms: 0 }] }), false);
  });

  it("requires asserted, uniquely named checkpoints and safe baselines", () => {
    assert.equal(validateInteractionScript({ events: [{ type: "checkpoint", id: "start", role: "START", assertions: [], visualMode: "DYNAMIC" }] }), false);
    assert.equal(validateInteractionScript({ events: [
      { type: "checkpoint", id: "start", role: "START", assertions: [{ source: "SCENE", operator: "EXISTS" }], visualMode: "DYNAMIC" },
      { type: "checkpoint", id: "start", role: "READY", assertions: [{ source: "SCENE", operator: "EXISTS" }], visualMode: "DYNAMIC" },
    ] }), false);
    assert.equal(validateInteractionScript({ events: [{ type: "checkpoint", id: "start", role: "START", assertions: [{ source: "SCENE", operator: "EXISTS" }], visualMode: "STABLE_REPLAY", referenceImage: "../secret.png" }] }), false);
    assert.equal(validateInteractionScript({ events: [{ type: "checkpoint", id: "progress", role: "PROGRESS", assertions: [{ source: "SCENE", operator: "EXISTS" }], visualMode: "DYNAMIC" }] }), false);
  });

  it("enforces event and wait limits", () => {
    assert.equal(validateInteractionScript({ events: [] }), false);
    assert.equal(validateInteractionScript({ events: Array.from({ length: 256 }, () => ({ type: "wait", delay_ms: 1 })) }), true);
    assert.equal(validateInteractionScript({ events: Array.from({ length: MAX_INTERACTION_EVENTS + 1 }, () => ({ type: "wait", delay_ms: 1 })) }), false);
    assert.equal(validateInteractionScript({ events: [{ type: "wait", delay_ms: 300_001 }] }), false);
  });
});
