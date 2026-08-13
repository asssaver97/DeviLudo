import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const E2E_UI_PROBE_SCHEMA = "deviludo.e2e-ui-probe";
export const E2E_CLIENT_WIDTH = 1280;
export const E2E_CLIENT_HEIGHT = 720;

export async function readProbeSnapshot(path, expected) {
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { return null; }
  return validateProbeSnapshot(value, expected) ? Object.freeze(value) : null;
}

export function validateProbeSnapshot(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== E2E_UI_PROBE_SCHEMA
    || Object.hasOwn(value, "schemaVersion") || Object.hasOwn(value, "version")
    || typeof value.sessionNonce !== "string" || !/^[0-9a-f]{32,128}$/i.test(value.sessionNonce)
    || !Number.isSafeInteger(value.pid) || value.pid <= 1
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || typeof value.sceneId !== "string" || !stableId(value.sceneId)
    || !plainRecord(value.state) || !plainRecord(value.progress)
    || !Array.isArray(value.controls) || value.controls.length > 2_000) return false;
  if (expected.sessionNonce && value.sessionNonce !== expected.sessionNonce) return false;
  if (expected.pid && value.pid !== expected.pid) return false;
  if (expected.afterSequence !== undefined && value.sequence <= expected.afterSequence) return false;
  if (!flatProbeValues(value.state) || !flatProbeValues(value.progress)) return false;
  const ids = new Set();
  for (const control of value.controls) {
    if (!control || typeof control !== "object" || Array.isArray(control)
      || !stableId(control.id) || ids.has(control.id)
      || typeof control.visible !== "boolean" || typeof control.enabled !== "boolean"
      || !validRect(control.rect)
      || (control.text !== undefined && (typeof control.text !== "string" || control.text.length > 2_000))
      || (control.value !== undefined && !primitive(control.value))) return false;
    ids.add(control.id);
  }
  return true;
}

export async function waitForProbeSnapshot(path, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readProbeSnapshot(path, expected);
    if (snapshot) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("E2E UI probe did not publish a fresh valid snapshot");
}

export function resolveProbeControl(snapshot, targetId, options = {}) {
  const matches = snapshot.controls.filter(control => control.id === targetId);
  if (matches.length !== 1) throw new Error(`E2E control ${targetId} is missing or duplicated`);
  const control = matches[0];
  if (!control.visible || (options.requireEnabled !== false && !control.enabled)) {
    throw new Error(`E2E control ${targetId} is not visible${options.requireEnabled === false ? "" : " and enabled"}`);
  }
  const { x, y, width, height } = control.rect;
  const center = { x: Math.floor(x + width / 2), y: Math.floor(y + height / 2) };
  if (center.x < 0 || center.x >= E2E_CLIENT_WIDTH || center.y < 0 || center.y >= E2E_CLIENT_HEIGHT) {
    throw new Error(`E2E control ${targetId} is outside the 1280x720 client area`);
  }
  return Object.freeze({ control, center });
}

export function evaluateProbeAssertions(assertions, before, after) {
  if (!Array.isArray(assertions) || !assertions.length) throw new Error("Probe assertions are required");
  return assertions.map(assertion => {
    const previous = assertionValue(assertion, before);
    const actual = assertionValue(assertion, after);
    const passed = compareAssertion(assertion, previous, actual);
    return Object.freeze({ assertion, previous: previous ?? null, actual: actual ?? null, passed });
  });
}

export function probeStateDigest(snapshot) {
  const controls = [...snapshot.controls]
    .map(control => ({ id: control.id, visible: control.visible, enabled: control.enabled, text: control.text ?? null, value: control.value ?? null }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const content = stableJson({ sceneId: snapshot.sceneId, state: snapshot.state, progress: snapshot.progress, controls });
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function assertionValue(assertion, snapshot) {
  if (!snapshot) return undefined;
  if (assertion.source === "SCENE") return snapshot.sceneId;
  if (assertion.source === "STATE") return pathValue(snapshot.state, assertion.key);
  if (assertion.source === "PROGRESS") return pathValue(snapshot.progress, assertion.key);
  if (assertion.source === "CONTROL") {
    const control = snapshot.controls.find(item => item.id === assertion.targetId);
    return control?.[assertion.property];
  }
  return undefined;
}

function compareAssertion(assertion, previous, actual) {
  switch (assertion.operator) {
    case "EXISTS": return actual !== undefined && actual !== null;
    case "CHANGED": return actual !== undefined && stableJson(actual) !== stableJson(previous);
    case "EQUALS": return actual === assertion.value;
    case "NOT_EQUALS": return actual !== assertion.value;
    case "GREATER_THAN": return typeof actual === "number" && actual > assertion.value;
    case "GREATER_THAN_OR_EQUALS": return typeof actual === "number" && actual >= assertion.value;
    case "LESS_THAN": return typeof actual === "number" && actual < assertion.value;
    case "LESS_THAN_OR_EQUALS": return typeof actual === "number" && actual <= assertion.value;
    case "CONTAINS": return (typeof actual === "string" && actual.includes(String(assertion.value)))
      || (Array.isArray(actual) && actual.includes(assertion.value));
    default: return false;
  }
}

function pathValue(value, path) {
  let current = value;
  for (const part of String(path ?? "").split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function validRect(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && [value.x, value.y, value.width, value.height].every(Number.isFinite)
    && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0
    && value.x + value.width <= E2E_CLIENT_WIDTH && value.y + value.height <= E2E_CLIENT_HEIGHT;
}

function flatProbeValues(value) {
  return Object.entries(value).length <= 1_000
    && Object.entries(value).every(([key, item]) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(key) && primitive(item));
}

function primitive(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function stableId(value) { return /^[a-z0-9][a-z0-9-]{0,119}$/.test(value); }
function plainRecord(value) { return value && typeof value === "object" && !Array.isArray(value); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
