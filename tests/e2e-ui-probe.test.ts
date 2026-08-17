import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateProbeAssertions,
  probeSnapshotValidationError,
  probeStateDigest,
  resolveProbeControl,
  resolveProbeControlAtPoint,
  validateProbeSnapshot,
  waitForProbePostconditions,
  waitForProbeSnapshot,
} from "../scripts/e2e-ui-probe.mjs";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema: "deviludo.e2e-ui-probe", sessionNonce: "0123456789abcdef0123456789abcdef", pid: 1234,
    sequence: 7, sceneId: "main", state: {
      screen_mode: "PLAYING", session_active: true, gameplay_input_enabled: true,
      blocking_layer_count: 0, paused: false, phase: "playing",
    }, progress: { turn: 2 },
    controls: [
      { id: "primary-control", scope: "GAMEPLAY", visible: true, enabled: true, text: "Activate", value: 0, rect: { x: 100, y: 200, width: 120, height: 50 } },
    ],
    ...overrides,
  };
}

describe("deviludo.e2e-ui-probe", () => {
  test("accepts a nonce/PID-scoped semantic UI and state snapshot", () => {
    assert.equal(validateProbeSnapshot(snapshot(), { sessionNonce: "0123456789abcdef0123456789abcdef", pid: 1234 }), true);
    assert.deepEqual(resolveProbeControl(snapshot() as never, "primary-control").control.rect, { x: 100, y: 200, width: 120, height: 50 });
  });

  test("rejects contradictory lifecycle states and gameplay controls exposed through a menu", () => {
    assert.equal(validateProbeSnapshot(snapshot({ state: {
      screen_mode: "MENU", session_active: true, gameplay_input_enabled: true, blocking_layer_count: 0,
    } })), false);
    assert.equal(validateProbeSnapshot(snapshot({
      state: { screen_mode: "MENU", session_active: false, gameplay_input_enabled: false, blocking_layer_count: 0 },
    })), false);
    assert.equal(validateProbeSnapshot(snapshot({
      state: { screen_mode: "MENU", session_active: false, gameplay_input_enabled: false, blocking_layer_count: 0 },
      controls: [{ ...snapshot().controls[0], scope: "NAVIGATION" }],
    })), true);
  });

  test("rejects stale processes, non-monotonic sequences and duplicate or out-of-client controls", () => {
    assert.equal(validateProbeSnapshot({ ...snapshot(), schemaVersion: "deviludo.e2e-ui-probe" }), false);
    assert.equal(validateProbeSnapshot(snapshot(), { sessionNonce: "ffffffffffffffffffffffffffffffff", pid: 1234 }), false);
    assert.equal(validateProbeSnapshot(snapshot(), { sessionNonce: "0123456789abcdef0123456789abcdef", pid: 1234, afterSequence: 7 }), false);
    const duplicate = snapshot({ controls: [snapshot().controls[0], snapshot().controls[0]] });
    assert.equal(validateProbeSnapshot(duplicate), false);
    assert.equal(validateProbeSnapshot(snapshot({ controls: [{ ...snapshot().controls[0], rect: { x: 1270, y: 0, width: 20, height: 10 } }] })), false);
    assert.equal(
      probeSnapshotValidationError(snapshot({ controls: [{ ...snapshot().controls[0], id: "player-label", rect: { x: 9, y: 5, width: 231, height: 0 } }] })),
      "control player-label rectangle {\"x\":9,\"y\":5,\"width\":231,\"height\":0} must be positive and remain inside 1280x720",
    );
  });

  test("reports the last structural reason when a published snapshot never becomes valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "deviludo-probe-error-test-"));
    const path = join(root, "probe.json");
    try {
      await writeFile(path, JSON.stringify(snapshot({ controls: [{ ...snapshot().controls[0], id: "player-label", rect: { x: 9, y: 5, width: 231, height: 0 } }] })));
      await assert.rejects(
        waitForProbeSnapshot(path, { sessionNonce: "0123456789abcdef0123456789abcdef", pid: 1234 }, 80),
        /control player-label rectangle \{\"x\":9,\"y\":5,\"width\":231,\"height\":0\} must be positive and remain inside 1280x720/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("evaluates pre/post state, progress, control and scene assertions", () => {
    const before = snapshot({ sequence: 7, progress: { turn: 1 } });
    const after = snapshot({ sequence: 8, state: {
      screen_mode: "PAUSED", session_active: true, gameplay_input_enabled: false,
      blocking_layer_count: 0, paused: true,
    }, progress: { turn: 2 } });
    assert.deepEqual(evaluateProbeAssertions([
      { source: "PROGRESS", key: "turn", operator: "CHANGED" },
      { source: "STATE", key: "paused", operator: "EQUALS", value: true },
      { source: "CONTROL", targetId: "primary-control", property: "enabled", operator: "EQUALS", value: true },
      { source: "SCENE", operator: "EQUALS", value: "main" },
    ], before as never, after as never).map(result => result.passed), [true, true, true, true]);
    assert.notEqual(probeStateDigest(before as never), probeStateDigest(after as never));
  });

  test("requires enabled input targets but permits disabled post-action visual regions", () => {
    const disabled = snapshot({ controls: [{ ...snapshot().controls[0], enabled: false }] });
    assert.throws(() => resolveProbeControl(disabled as never, "primary-control"), /visible and enabled/);
    assert.equal(resolveProbeControl(disabled as never, "primary-control", { requireEnabled: false }).control.enabled, false);
  });

  test("maps nested visual hits to the unique smallest semantic control", () => {
    const nested = snapshot({ controls: [
      { id: "dialog", scope: "OVERLAY", visible: true, enabled: true, rect: { x: 40, y: 80, width: 600, height: 400 } },
      { id: "confirm-button", scope: "OVERLAY", visible: true, enabled: true, rect: { x: 300, y: 360, width: 160, height: 48 } },
    ] });
    assert.equal(resolveProbeControlAtPoint(nested as never, 380, 384)?.id, "confirm-button");
  });

  test("rejects equal-size semantic hit ambiguity instead of persisting fixed coordinates", () => {
    const ambiguous = snapshot({ controls: [
      { id: "choice-a", scope: "NAVIGATION", visible: true, enabled: true, rect: { x: 100, y: 100, width: 120, height: 50 } },
      { id: "choice-b", scope: "NAVIGATION", visible: true, enabled: true, rect: { x: 100, y: 100, width: 120, height: 50 } },
    ] });
    assert.equal(resolveProbeControlAtPoint(ambiguous as never, 160, 125), null);
  });

  test("waits for an atomically replaced newer snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "deviludo-probe-test-"));
    const path = join(root, "probe.json");
    try {
      await mkdir(root, { recursive: true });
      const waiting = waitForProbeSnapshot(path, { sessionNonce: "0123456789abcdef0123456789abcdef", pid: 1234, afterSequence: 7 }, 2_000);
      setTimeout(() => {
        const temporary = `${path}.tmp`;
        void writeFile(temporary, JSON.stringify(snapshot({ sequence: 8 }))).then(() => rename(temporary, path));
      }, 50);
      assert.equal((await waiting).sequence, 8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("waits past unchanged heartbeats until post-action state satisfies the Oracle", async () => {
    const root = await mkdtemp(join(tmpdir(), "deviludo-probe-postcondition-test-"));
    const path = join(root, "probe.json");
    const before = snapshot({ sequence: 7, progress: { turn: 2, move_budget: 0 } });
    try {
      await writeFile(path, JSON.stringify(snapshot({ sequence: 8, progress: { turn: 2, move_budget: 0 } })));
      const waiting = waitForProbePostconditions(path, {
        sessionNonce: "0123456789abcdef0123456789abcdef", pid: 1234, afterSequence: 7,
      }, before as never, [{ source: "PROGRESS", key: "move_budget", operator: "GREATER_THAN", value: 0 }], 2_000);
      setTimeout(() => {
        const temporary = `${path}.tmp`;
        void writeFile(temporary, JSON.stringify(snapshot({ sequence: 9, progress: { turn: 2, move_budget: 6 } }))).then(() => rename(temporary, path));
      }, 100);
      const result = await waiting;
      assert.equal(result.snapshot.sequence, 9);
      assert.equal(result.stateChanged, true);
      assert.equal(result.passed, true);
      assert.equal(result.assertions[0]?.actual, 6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a newer contract-invalid snapshot instead of masking it with an older valid observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "deviludo-probe-postcondition-invalid-test-"));
    const path = join(root, "probe.json");
    const before = snapshot({ sequence: 7, progress: { turn: 2 } });
    try {
      await writeFile(path, JSON.stringify(snapshot({ sequence: 8, progress: { turn: 2 } })));
      const waiting = waitForProbePostconditions(path, {
        sessionNonce: "0123456789abcdef0123456789abcdef", pid: 1234, afterSequence: 7,
      }, before as never, [{ source: "CONTROL", targetId: "dialog", property: "visible", operator: "EQUALS", value: true }], 250);
      setTimeout(() => {
        const temporary = `${path}.tmp`;
        const invalid = snapshot({
          sequence: 9,
          controls: [{ id: "dialog", scope: "OVERLAY", visible: true, enabled: true, text: "", value: "", rect: { x: 1100, y: 100, width: 300, height: 200 } }],
        });
        void writeFile(temporary, JSON.stringify(invalid)).then(() => rename(temporary, path));
      }, 50);
      await assert.rejects(
        waiting,
        /invalid newer snapshot sequence 9: control dialog rectangle \{\"x\":1100,\"y\":100,\"width\":300,\"height\":200\} must be positive and remain inside 1280x720/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
