import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateProbeAssertions,
  probeStateDigest,
  resolveProbeControl,
  validateProbeSnapshot,
  waitForProbeSnapshot,
} from "../scripts/e2e-ui-probe.mjs";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "deviludo.e2e-ui-probe.v1", sessionNonce: "0123456789abcdef0123456789abcdef", pid: 1234,
    sequence: 7, sceneId: "main", state: { paused: false, phase: "playing" }, progress: { turn: 2 },
    controls: [
      { id: "roll-dice", visible: true, enabled: true, text: "掷骰", value: 0, rect: { x: 100, y: 200, width: 120, height: 50 } },
    ],
    ...overrides,
  };
}

describe("deviludo.e2e-ui-probe.v1", () => {
  test("accepts a nonce/PID-scoped semantic UI and state snapshot", () => {
    assert.equal(validateProbeSnapshot(snapshot(), { sessionNonce: "0123456789abcdef0123456789abcdef", pid: 1234 }), true);
    assert.deepEqual(resolveProbeControl(snapshot() as never, "roll-dice").control.rect, { x: 100, y: 200, width: 120, height: 50 });
  });

  test("rejects stale processes, non-monotonic sequences and duplicate or out-of-client controls", () => {
    assert.equal(validateProbeSnapshot(snapshot(), { sessionNonce: "ffffffffffffffffffffffffffffffff", pid: 1234 }), false);
    assert.equal(validateProbeSnapshot(snapshot(), { sessionNonce: "0123456789abcdef0123456789abcdef", pid: 1234, afterSequence: 7 }), false);
    const duplicate = snapshot({ controls: [snapshot().controls[0], snapshot().controls[0]] });
    assert.equal(validateProbeSnapshot(duplicate), false);
    assert.equal(validateProbeSnapshot(snapshot({ controls: [{ ...snapshot().controls[0], rect: { x: 1270, y: 0, width: 20, height: 10 } }] })), false);
  });

  test("evaluates pre/post state, progress, control and scene assertions", () => {
    const before = snapshot({ sequence: 7, progress: { turn: 1 } });
    const after = snapshot({ sequence: 8, state: { paused: true }, progress: { turn: 2 } });
    assert.deepEqual(evaluateProbeAssertions([
      { source: "PROGRESS", key: "turn", operator: "CHANGED" },
      { source: "STATE", key: "paused", operator: "EQUALS", value: true },
      { source: "CONTROL", targetId: "roll-dice", property: "enabled", operator: "EQUALS", value: true },
      { source: "SCENE", operator: "EQUALS", value: "main" },
    ], before as never, after as never).map(result => result.passed), [true, true, true, true]);
    assert.notEqual(probeStateDigest(before as never), probeStateDigest(after as never));
  });

  test("requires enabled input targets but permits disabled post-action visual regions", () => {
    const disabled = snapshot({ controls: [{ ...snapshot().controls[0], enabled: false }] });
    assert.throws(() => resolveProbeControl(disabled as never, "roll-dice"), /visible and enabled/);
    assert.equal(resolveProbeControl(disabled as never, "roll-dice", { requireEnabled: false }).control.enabled, false);
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
});
