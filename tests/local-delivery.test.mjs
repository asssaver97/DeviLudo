import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLocalDeliveryAction,
  approveLocalSpec,
  createLocalDelivery,
  invalidateLocalDelivery,
} from "../lib/local-delivery/model.ts";

test("local delivery fixture exercises the complete gated chain without external calls", () => {
  let state = approveLocalSpec(createLocalDelivery("project-local"), "SPEC-004", "RUN-LOCAL-1");
  assert.equal(state.stage, "AGENT_QUEUED");
  assert.equal(state.lockedProfile.agent, "claude-code");

  state = applyLocalDeliveryAction(state, "provider-fail");
  assert.equal(state.stage, "WAITING_PROVIDER");
  state = applyLocalDeliveryAction(state, "provider-resume");
  assert.equal(state.stage, "AGENT_QUEUED");

  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "CANDIDATE_READY");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.targetResults.linux, "RUNNING");

  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "AWAITING_ACCEPTANCE");
  assert.deepEqual(state.targetResults, { linux: "PASSED", windows: "PASSED", macos: "PASSED" });
  assert.equal(state.evidenceValid, true);

  state = applyLocalDeliveryAction(state, "accept");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "MAIN_GATE_RUNNING");
  assert.equal(state.mainSha, "f21c0de");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "MFA_REQUIRED");
  state = applyLocalDeliveryAction(state, "confirm-mfa");
  state = applyLocalDeliveryAction(state, "advance");
  state = applyLocalDeliveryAction(state, "advance");
  assert.equal(state.stage, "EXTERNAL_APPROVAL_REQUIRED");
  state = applyLocalDeliveryAction(state, "external-approve");
  assert.equal(state.stage, "RELEASED");
  assert.match(state.events[0].message, /未调用真实 Steam/);
});

test("feedback invalidates all local evidence and requires a new immutable approval", () => {
  let state = approveLocalSpec(createLocalDelivery("project-feedback"), "SPEC-008", "RUN-LOCAL-2");
  state = { ...state, evidenceValid: true, targetResults: { linux: "PASSED", windows: "PASSED", macos: "PASSED" } };
  state = invalidateLocalDelivery(state, "SPEC-009");
  assert.equal(state.stage, "AWAITING_SPEC_APPROVAL");
  assert.equal(state.evidenceValid, false);
  assert.deepEqual(state.targetResults, { linux: "INVALIDATED", windows: "INVALIDATED", macos: "INVALIDATED" });
  assert.throws(() => applyLocalDeliveryAction(state, "advance"), /先批准/);
});
