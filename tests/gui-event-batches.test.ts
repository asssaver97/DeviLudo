import assert from "node:assert/strict";
import test from "node:test";
import { checkpointOutputSeen, interactionEventBatches, interactionEventDeadlineOffsets } from "../scripts/executors/gui-event-batches.mjs";

test("real-window inputs stay in one process between screenshot checkpoints", () => {
  const start = { type: "checkpoint", id: "start", role: "START", delay_ms: 100 };
  const keyState = { type: "checkpoint", id: "key", role: "KEY_STATE", delay_ms: 20 };
  const completion = { type: "checkpoint", id: "done", role: "COMPLETION", delay_ms: 50 };
  const firstInputs = [
    { type: "wait", delay_ms: 300 },
    { type: "key_press", key: "KEY_SPACE", delay_ms: 10 },
    { type: "key_release", key: "KEY_SPACE", delay_ms: 16 },
  ];
  const finalInputs = [{ type: "mouse_click", button: "LEFT", delay_ms: 40 }];

  assert.deepEqual(
    interactionEventBatches([start, ...firstInputs, keyState, ...finalInputs, completion]),
    [
      { kind: "checkpoint", event: start },
      { kind: "sequence", events: firstInputs },
      { kind: "checkpoint", event: keyState },
      { kind: "sequence", events: finalInputs },
      { kind: "checkpoint", event: completion },
    ],
  );
});

test("a journey with no checkpoint still executes as one timed input batch", () => {
  const events = [
    { type: "key_press", key: "A", delay_ms: 100 },
    { type: "key_release", key: "A", delay_ms: 16 },
  ];
  assert.deepEqual(interactionEventBatches(events), [{ kind: "sequence", events }]);
});

test("driver sequence deadlines are cumulative offsets from one origin", () => {
  assert.deepEqual(interactionEventDeadlineOffsets([
    { type: "wait", delay_ms: 300 },
    { type: "key_press", key: "A", delay_ms: 467 },
    { type: "key_release", key: "A", delay_ms: 16 },
  ]), [300, 767, 783]);
  assert.throws(() => interactionEventDeadlineOffsets([{ type: "wait", delay_ms: -1 }]), /delay is invalid/);
});

test("checkpoint assertions require an exact complete output line", () => {
  const marker = "DEVILUDO_E2E_CHECKPOINT:round-complete";
  assert.equal(checkpointOutputSeen([Buffer.from("boot\nDEVILUDO_E2E_"), Buffer.from("CHECKPOINT:round-complete\n")], marker), true);
  assert.equal(checkpointOutputSeen([Buffer.from(`${marker}-wrong\n`)], marker), false);
});
