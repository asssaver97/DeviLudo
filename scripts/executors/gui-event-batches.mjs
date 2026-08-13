/**
 * Groups every uninterrupted stretch of waits and input events into one GUI
 * driver invocation. A checkpoint stays separate because the guest runner must
 * capture and validate its PNG before continuing.
 *
 * Keeping a whole input stretch in one process is correctness-critical: process
 * startup time between individual key events would otherwise advance the game
 * clock and corrupt the manifest's deterministic timing.
 */
export function interactionEventBatches(events) {
  if (!Array.isArray(events)) throw new TypeError("interaction events must be an array");
  const batches = [];
  let sequence = [];
  const flush = () => {
    if (sequence.length === 0) return;
    batches.push({ kind: "sequence", events: sequence });
    sequence = [];
  };
  for (const event of events) {
    if (event?.type !== "checkpoint") {
      sequence.push(event);
      continue;
    }
    flush();
    batches.push({ kind: "checkpoint", event });
  }
  flush();
  return batches;
}

/** Returns each event's absolute due offset from one sequence origin. */
export function interactionEventDeadlineOffsets(events) {
  if (!Array.isArray(events)) throw new TypeError("interaction events must be an array");
  let dueOffsetMs = 0;
  return events.map(event => {
    const delayMs = event?.delay_ms ?? 0;
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 300_000) {
      throw new TypeError("interaction event delay is invalid");
    }
    dueOffsetMs += delayMs;
    return dueOffsetMs;
  });
}

export function checkpointOutputSeen(chunks, expectedOutput) {
  if (!Array.isArray(chunks) || typeof expectedOutput !== "string" || !expectedOutput) return false;
  return chunks.map(chunk => chunk.toString()).join("").split(/\r?\n/).some(line => line.trim() === expectedOutput);
}
