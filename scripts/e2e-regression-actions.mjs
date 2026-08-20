const REPLAY_ACTION_FIELDS = Object.freeze({
  key_tap: Object.freeze(["key"]),
  key_hold: Object.freeze(["key", "duration_ms"]),
  click: Object.freeze(["targetId", "button"]),
  double_click: Object.freeze(["targetId", "button"]),
  drag: Object.freeze(["fromTargetId", "toTargetId", "duration_ms", "button"]),
  scroll: Object.freeze(["targetId", "deltaY"]),
  text_input: Object.freeze(["targetId", "text"]),
  gamepad_button_tap: Object.freeze(["button"]),
  gamepad_button_hold: Object.freeze(["button", "duration_ms"]),
  gamepad_axis: Object.freeze(["axis", "value", "duration_ms"]),
  gamepad_trigger: Object.freeze(["trigger", "value", "duration_ms"]),
  gamepad_release_all: Object.freeze([]),
});

/**
 * The generated core journey has already completed once and passed its stable
 * replay before regression solidification starts. Preserve that verified,
 * semantic input sequence as a deterministic candidate. Adaptive trajectories
 * remain useful candidates, but their periodic Probe observations can lag an
 * OS input and attribute progress to the following exploratory click.
 */
export function plannedCoreRegressionCandidates(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.features)) return Object.freeze([]);
  const candidates = [];
  for (const feature of manifest.features) {
    if (feature?.coreJourney !== true || feature.verificationMethod !== "interactive"
      || feature.launchProfile?.type !== "FRESH" || !Array.isArray(feature.interactionScript?.events)) continue;
    const actions = [];
    let invalid = false;
    for (const event of feature.interactionScript.events) {
      if (event?.type === "checkpoint" || event?.type === "wait") continue;
      const fields = REPLAY_ACTION_FIELDS[event?.type];
      if (!fields || !Array.isArray(event.postconditions) || event.postconditions.length === 0) {
        invalid = true;
        break;
      }
      const action = { type: event.type };
      for (const field of fields) {
        if (event[field] !== undefined) action[field] = event[field];
      }
      action.postconditions = event.postconditions.map(assertion => Object.freeze({ ...assertion }));
      actions.push(Object.freeze(action));
    }
    if (!invalid && actions.length > 0) {
      candidates.push(Object.freeze({
        source: "PLANNED_CORE_JOURNEY",
        estimatedDurationMs: feature.timeoutMs,
        actions: Object.freeze(actions),
      }));
    }
  }
  return Object.freeze(candidates);
}
