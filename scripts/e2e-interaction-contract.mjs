const ACTION_TYPES = new Set([
  "key_tap", "key_hold", "click", "double_click", "drag", "scroll", "text_input",
  "gamepad_button_tap", "gamepad_button_hold", "gamepad_axis", "gamepad_trigger", "gamepad_release_all",
]);
const ACTION_INTENTS = new Set(["START_SESSION", "NAVIGATION", "PRIMARY_ACTION", "FEATURE_ACTION", "COMPLETE_LOOP"]);
const CHECKPOINT_ROLES = new Set(["START", "READY", "ACTION", "PROGRESS", "COMPLETION"]);
const GAMEPAD_BUTTONS = new Set([
  "A", "B", "X", "Y", "BACK", "GUIDE", "START", "LEFT_STICK", "RIGHT_STICK",
  "LEFT_SHOULDER", "RIGHT_SHOULDER", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT",
]);
const GAMEPAD_AXES = new Set(["LEFT_X", "LEFT_Y", "RIGHT_X", "RIGHT_Y"]);

export function validateGuestInteractionScript(value, journeyRequirements, playerRequirements) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray(journeyRequirements) || !(playerRequirements instanceof Set)
    || Object.hasOwn(value, "version") || Object.hasOwn(value, "schemaVersion")
    || !Array.isArray(value.events) || value.events.length < 1 || value.events.length > 200) return false;
  const allowedRequirements = new Set(journeyRequirements);
  const steps = new Set();
  const checkpoints = new Set();
  return value.events.every(event => {
    if (!event || typeof event !== "object" || Array.isArray(event)
      || !validDelay(event.delay_ms, event.type === "wait")) return false;
    if (event.type === "wait") return true;
    if (event.type === "checkpoint") {
      if (!isStableId(event.id) || checkpoints.has(event.id) || !CHECKPOINT_ROLES.has(event.role)
        || !Array.isArray(event.assertions) || event.assertions.length < 1 || event.assertions.length > 32
        || !event.assertions.every(validateProbeAssertion)
        || !["DYNAMIC", "STABLE_REPLAY"].includes(event.visualMode)
        || (event.changeTargetId !== undefined && !isStableId(event.changeTargetId))
        || (event.visualMode === "DYNAMIC" && ["ACTION", "PROGRESS", "COMPLETION"].includes(event.role)
          && !isStableId(event.changeTargetId))
        || (event.referenceImage !== undefined && !isSafeProjectPngPath(event.referenceImage))
        || (event.expectedOutput !== undefined && event.expectedOutput !== checkpointOutputMarker(event.id))
        || (event.threshold !== undefined && (typeof event.threshold !== "number" || !Number.isFinite(event.threshold)
          || event.threshold < 0 || event.threshold > 1))) return false;
      checkpoints.add(event.id);
      return true;
    }
    if (!isInteractionAction(event) || !isStableId(event.stepId) || steps.has(event.stepId)
      || !ACTION_INTENTS.has(event.intent)
      || !Array.isArray(event.coversRequirementIds) || event.coversRequirementIds.length > 500
      || new Set(event.coversRequirementIds).size !== event.coversRequirementIds.length
      || event.coversRequirementIds.some(id => !allowedRequirements.has(id) || !playerRequirements.has(id))
      || !Array.isArray(event.postconditions) || event.postconditions.length < 1 || event.postconditions.length > 32
      || !event.postconditions.every(validateProbeAssertion)) return false;
    steps.add(event.stepId);

    if (event.type === "key_tap") return isSupportedKeyboardKey(event.key);
    if (event.type === "key_hold") return isSupportedKeyboardKey(event.key) && validDuration(event.duration_ms);
    if (event.type === "click" || event.type === "double_click") {
      return isStableId(event.targetId) && (event.button === undefined || ["LEFT", "RIGHT", "MIDDLE"].includes(event.button));
    }
    if (event.type === "drag") {
      return isStableId(event.fromTargetId) && isStableId(event.toTargetId) && validDuration(event.duration_ms)
        && (event.button === undefined || event.button === "LEFT");
    }
    if (event.type === "scroll") {
      return isStableId(event.targetId) && Number.isInteger(event.deltaY) && event.deltaY !== 0 && Math.abs(event.deltaY) <= 10_000;
    }
    if (event.type === "text_input") {
      return isStableId(event.targetId) && typeof event.text === "string" && event.text.length >= 1 && event.text.length <= 1_000;
    }
    if (event.type === "gamepad_button_tap" || event.type === "gamepad_button_hold") {
      return GAMEPAD_BUTTONS.has(event.button) && (event.type !== "gamepad_button_hold" || validDuration(event.duration_ms));
    }
    if (event.type === "gamepad_axis") {
      return GAMEPAD_AXES.has(event.axis) && validNumberRange(event.value, -1, 1)
        && (event.duration_ms === undefined || validDuration(event.duration_ms));
    }
    if (event.type === "gamepad_trigger") {
      return ["LEFT", "RIGHT"].includes(event.trigger) && validNumberRange(event.value, 0, 1)
        && (event.duration_ms === undefined || validDuration(event.duration_ms));
    }
    return event.type === "gamepad_release_all";
  });
}

export function validateProbeAssertion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !["STATE", "PROGRESS", "CONTROL", "SCENE"].includes(value.source)
    || !["EQUALS", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS", "LESS_THAN", "LESS_THAN_OR_EQUALS", "CONTAINS", "EXISTS", "CHANGED"].includes(value.operator)) return false;
  if (value.source === "STATE" || value.source === "PROGRESS") {
    if (typeof value.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value.key)
      || value.targetId !== undefined || value.property !== undefined) return false;
  } else if (value.source === "CONTROL") {
    if (!isStableId(value.targetId) || !["visible", "enabled", "text", "value"].includes(value.property)
      || value.key !== undefined) return false;
  } else if (value.key !== undefined || value.targetId !== undefined || value.property !== undefined) return false;
  const requiresValue = !["EXISTS", "CHANGED"].includes(value.operator);
  return requiresValue === Object.hasOwn(value, "value")
    && (value.value === undefined || ["string", "number", "boolean"].includes(typeof value.value));
}

export function validLaunchProfile(value) {
  return value?.type === "FRESH" || (value?.type === "SCENARIO" && isStableId(value.scenarioId));
}

export function isInteractionAction(event) {
  return ACTION_TYPES.has(event?.type);
}

export function checkpointOutputMarker(id) {
  return `DEVILUDO_E2E_CHECKPOINT:${id}`;
}

export function isStableId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}

export function isSafeProjectPngPath(value) {
  return typeof value === "string" && value.length >= 5 && value.length <= 240
    && value.toLowerCase().endsWith(".png") && !value.startsWith("/") && !value.startsWith("res://")
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value)
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*\.png$/i.test(value);
}

function isSupportedKeyboardKey(value) {
  return typeof value === "string" && /^(?:KEY_)?(?:[A-Z0-9]|SPACE|ENTER|TAB|ESCAPE|LEFT|RIGHT|UP|DOWN|MINUS|EQUAL)$/.test(value);
}

function validDuration(value) {
  return Number.isInteger(value) && value >= 1 && value <= 300_000;
}

function validDelay(value, required) {
  return value === undefined ? !required : Number.isInteger(value) && value >= 0 && value <= 300_000;
}

function validNumberRange(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
