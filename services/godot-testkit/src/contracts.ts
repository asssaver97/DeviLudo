import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson, sha256Canonical } from "../../runner-control/src/canonical";
import type { SignedRunnerJob } from "../../runner-control/src/contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){1,5}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SAFE_ACTION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_NODE_PATH = /^(?:\.|\.\/[A-Za-z0-9_./:@-]{1,509}|\/root\/[A-Za-z0-9_./:@-]{1,505})$/;

export interface GodotTestKitRunRequest {
  readonly schemaVersion: "deviludo.testkit-run-request.v2";
  readonly jobDigest: string;
  readonly testKitDigest: string;
  readonly godot: Readonly<{
    executable: string;
    binaryDigest: string;
    version: string;
  }>;
  readonly signedJob: SignedRunnerJob;
}

export type GodotTestOutcome = "CORE_LOOP" | "WIN" | "LOSE" | "PAUSE_SETTINGS" | "SAVE_LOAD";

export type GodotTestStep =
  | Readonly<{ kind: "WAIT_FRAMES"; frames: number }>
  | Readonly<{ kind: "ACTION"; action: string; pressed: boolean; framesAfter: number }>
  | Readonly<{ kind: "ASSERT_PROPERTY"; nodePath: string; property: string; equals: string | number | boolean | null }>
  | Readonly<{ kind: "ASSERT_GROUP_COUNT"; group: string; minimum: number; maximum: number }>
  | Readonly<{ kind: "SCREENSHOT"; name: string }>;

export interface GodotTestScenario {
  readonly id: string;
  readonly outcome: GodotTestOutcome;
  readonly steps: readonly GodotTestStep[];
}

export interface GodotTestPlan {
  readonly schemaVersion: "deviludo.godot-test-plan.v2";
  readonly engine: "godot-4";
  readonly targetMatrix: readonly ("windows" | "linux" | "macos")[];
  readonly requiredGodotVersion: string;
  readonly timeouts: Readonly<{
    importSeconds: number;
    bootSeconds: number;
    suiteSeconds: number;
    exportSeconds: number;
  }>;
  readonly performance: Readonly<{
    warmupFrames: number;
    sampleFrames: number;
    maximumAverageFrameMs: number;
    maximumP95FrameMs: number;
  }>;
  readonly scenarios: readonly GodotTestScenario[];
}

export interface GodotHarnessResult {
  readonly schemaVersion: "deviludo.godot-harness-result.v1";
  readonly status: "PASSED" | "FAILED";
  readonly checks: readonly Readonly<{
    id: string;
    outcome: GodotTestOutcome;
    status: "PASSED" | "FAILED";
    durationMs: number;
    code: string;
  }>[];
  readonly inputTimeline: readonly Readonly<{
    scenarioId: string;
    stepIndex: number;
    kind: GodotTestStep["kind"];
    frame: number;
  }>[];
  readonly screenshots: readonly Readonly<{
    name: string;
    file: string;
    sha256: string;
    width: number;
    height: number;
  }>[];
  readonly performance: Readonly<{
    averageFrameMs: number;
    p95FrameMs: number;
    sampledFrames: number;
  }>;
  readonly videoFile: string;
  readonly createdAt: string;
}

export interface FrozenGodotTestPlanBinding {
  readonly testPlanDigest: string;
  readonly targetMatrix: readonly ("windows" | "linux" | "macos")[];
  readonly requiredGodotVersion: string;
  readonly currentPlatform?: "windows" | "linux" | "macos";
}

export function parseGodotTestKitRunRequest(value: unknown): GodotTestKitRunRequest {
  const body = object(value, "request");
  exactKeys(body, ["schemaVersion", "jobDigest", "testKitDigest", "godot", "signedJob"], "request");
  const godot = object(body.godot, "Godot lock");
  exactKeys(godot, ["executable", "binaryDigest", "version"], "Godot lock");
  const signedJob = object(body.signedJob, "signed job") as unknown as SignedRunnerJob;
  const payload = object(signedJob.payload, "signed job payload") as unknown as SignedRunnerJob["payload"];
  const signature = object(signedJob.signature, "signed job signature") as unknown as SignedRunnerJob["signature"];
  if (body.schemaVersion !== "deviludo.testkit-run-request.v2"
    || typeof body.jobDigest !== "string" || !SHA256.test(body.jobDigest)
    || typeof body.testKitDigest !== "string" || !SHA256.test(body.testKitDigest)
    || typeof godot.executable !== "string" || !absolutePath(godot.executable)
    || typeof godot.binaryDigest !== "string" || !SHA256.test(godot.binaryDigest)
    || typeof godot.version !== "string" || !EXACT_VERSION.test(godot.version)
    || payload.schemaVersion !== "deviludo.runner-job.v2"
    || signature.algorithm !== "Ed25519" || typeof signature.keyId !== "string" || !signature.keyId
    || typeof signature.value !== "string" || !signature.value
    || body.jobDigest !== sha256Canonical(payload)
    || body.testKitDigest !== payload.godotTestKitDigest
    || godot.version !== payload.requiredGodotVersion) invalid("request binding");
  return deepFreeze({
    schemaVersion: "deviludo.testkit-run-request.v2",
    jobDigest: body.jobDigest,
    testKitDigest: body.testKitDigest,
    godot: { executable: godot.executable, binaryDigest: godot.binaryDigest, version: godot.version },
    signedJob: { payload, signature },
  });
}

export function parseGodotTestPlan(bytes: Buffer, request: GodotTestKitRunRequest): GodotTestPlan {
  return parseFrozenGodotTestPlan(bytes, {
    testPlanDigest: request.signedJob.payload.testPlanDigest,
    targetMatrix: request.signedJob.payload.targetMatrix,
    requiredGodotVersion: request.signedJob.payload.requiredGodotVersion,
    currentPlatform: request.signedJob.payload.platform,
  });
}

export function parseFrozenGodotTestPlan(bytes: Buffer, binding: FrozenGodotTestPlanBinding): GodotTestPlan {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 2 || bytes.byteLength > 4 * 1024 * 1024) invalid("test plan size");
  const observedDigest = createHash("sha256").update(bytes).digest("hex");
  if (!SHA256.test(binding.testPlanDigest) || observedDigest !== binding.testPlanDigest) invalid("test plan digest");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { invalid("test plan JSON"); }
  const body = object(parsed, "test plan");
  if (Buffer.from(canonicalJson(body), "utf8").compare(bytes) !== 0) invalid("test plan canonical encoding");
  exactKeys(body, ["schemaVersion", "engine", "targetMatrix", "requiredGodotVersion", "timeouts", "performance", "scenarios"], "test plan");
  const timeouts = object(body.timeouts, "test plan timeouts");
  exactKeys(timeouts, ["importSeconds", "bootSeconds", "suiteSeconds", "exportSeconds"], "test plan timeouts");
  const performance = object(body.performance, "test plan performance");
  exactKeys(performance, ["warmupFrames", "sampleFrames", "maximumAverageFrameMs", "maximumP95FrameMs"], "test plan performance");
  if (body.schemaVersion !== "deviludo.godot-test-plan.v2" || body.engine !== "godot-4"
    || body.requiredGodotVersion !== binding.requiredGodotVersion
    || !EXACT_VERSION.test(String(body.requiredGodotVersion))) invalid("test plan binding");
  const targetMatrix = parseTargetMatrix(body.targetMatrix);
  if (JSON.stringify(targetMatrix) !== JSON.stringify(binding.targetMatrix)
    || (binding.currentPlatform !== undefined && !targetMatrix.includes(binding.currentPlatform))) invalid("test plan matrix binding");
  const parsedTimeouts = {
    importSeconds: integer(timeouts.importSeconds, 5, 600, "import timeout"),
    bootSeconds: integer(timeouts.bootSeconds, 5, 600, "boot timeout"),
    suiteSeconds: integer(timeouts.suiteSeconds, 10, 3_600, "suite timeout"),
    exportSeconds: integer(timeouts.exportSeconds, 30, 3_600, "export timeout"),
  };
  const maximumExecutionSeconds = parsedTimeouts.importSeconds
    + (parsedTimeouts.bootSeconds * 2)
    + parsedTimeouts.suiteSeconds
    + parsedTimeouts.exportSeconds;
  if (maximumExecutionSeconds > 3_000) invalid("total execution timeout");
  const parsedPerformance = {
    warmupFrames: integer(performance.warmupFrames, 1, 10_000, "warmup frames"),
    sampleFrames: integer(performance.sampleFrames, 30, 100_000, "sample frames"),
    maximumAverageFrameMs: finite(performance.maximumAverageFrameMs, 1, 100, "average frame budget"),
    maximumP95FrameMs: finite(performance.maximumP95FrameMs, 1, 250, "p95 frame budget"),
  };
  if (parsedPerformance.maximumP95FrameMs < parsedPerformance.maximumAverageFrameMs) invalid("performance budgets");
  if (!Array.isArray(body.scenarios) || body.scenarios.length < 5 || body.scenarios.length > 64) invalid("test plan scenarios");
  const scenarios = body.scenarios.map((scenario, index) => parseScenario(scenario, index));
  let previous = "";
  const outcomes = new Set<GodotTestOutcome>();
  const screenshotNames: string[] = [];
  for (const scenario of scenarios) {
    if (scenario.id <= previous) invalid("scenario ordering");
    previous = scenario.id;
    outcomes.add(scenario.outcome);
    screenshotNames.push(...scenario.steps.filter((step): step is Extract<GodotTestStep, { kind: "SCREENSHOT" }> => step.kind === "SCREENSHOT").map((step) => step.name));
  }
  for (const outcome of ["CORE_LOOP", "WIN", "LOSE", "PAUSE_SETTINGS", "SAVE_LOAD"] as const) {
    if (!outcomes.has(outcome)) invalid("required scenario outcomes");
  }
  if (screenshotNames.length < 2 || new Set(screenshotNames).size !== screenshotNames.length) invalid("screenshot checkpoints");
  return deepFreeze({
    schemaVersion: "deviludo.godot-test-plan.v2",
    engine: "godot-4",
    targetMatrix,
    requiredGodotVersion: binding.requiredGodotVersion,
    timeouts: parsedTimeouts,
    performance: parsedPerformance,
    scenarios,
  });
}

function parseTargetMatrix(value: unknown): readonly ("windows" | "linux" | "macos")[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3
    || value.some((item) => item !== "windows" && item !== "linux" && item !== "macos")
    || new Set(value).size !== value.length) invalid("test plan target matrix");
  const parsed = [...value].sort() as ("windows" | "linux" | "macos")[];
  if (JSON.stringify(parsed) !== JSON.stringify(value)) invalid("test plan target matrix ordering");
  return Object.freeze(parsed);
}

export function parseGodotHarnessResult(value: unknown, plan: GodotTestPlan): GodotHarnessResult {
  const body = object(value, "harness result");
  exactKeys(body, ["schemaVersion", "status", "checks", "inputTimeline", "screenshots", "performance", "videoFile", "createdAt"], "harness result");
  if (body.schemaVersion !== "deviludo.godot-harness-result.v1" || (body.status !== "PASSED" && body.status !== "FAILED")
    || typeof body.videoFile !== "string" || !safeRelativeFile(body.videoFile)
    || typeof body.createdAt !== "string" || !Number.isFinite(Date.parse(body.createdAt))) invalid("harness result binding");
  if (!Array.isArray(body.checks) || body.checks.length !== plan.scenarios.length) invalid("harness checks");
  const checks = body.checks.map((item, index) => {
    const check = object(item, "harness check");
    exactKeys(check, ["id", "outcome", "status", "durationMs", "code"], "harness check");
    const expected = plan.scenarios[index]!;
    if (check.id !== expected.id || check.outcome !== expected.outcome
      || (check.status !== "PASSED" && check.status !== "FAILED")
      || typeof check.code !== "string" || !/^[A-Z0-9_]{2,64}$/.test(check.code)) invalid("harness check binding");
    return {
      id: expected.id,
      outcome: expected.outcome,
      status: check.status as "PASSED" | "FAILED",
      durationMs: finite(check.durationMs, 0, 3_600_000, "check duration"),
      code: check.code,
    };
  });
  if ((body.status === "PASSED") !== checks.every((check) => check.status === "PASSED")) invalid("harness status");
  if (!Array.isArray(body.inputTimeline) || body.inputTimeline.length < 1 || body.inputTimeline.length > 100_000) invalid("input timeline");
  const inputTimeline = body.inputTimeline.map((item) => {
    const event = object(item, "input event");
    exactKeys(event, ["scenarioId", "stepIndex", "kind", "frame"], "input event");
    if (typeof event.scenarioId !== "string" || !plan.scenarios.some((scenario) => scenario.id === event.scenarioId)
      || !["WAIT_FRAMES", "ACTION", "ASSERT_PROPERTY", "ASSERT_GROUP_COUNT", "SCREENSHOT"].includes(String(event.kind))) invalid("input event binding");
    return { scenarioId: event.scenarioId, stepIndex: integer(event.stepIndex, 0, 999, "input step"), kind: event.kind as GodotTestStep["kind"], frame: integer(event.frame, 0, 10_000_000, "input frame") };
  });
  if (body.status === "PASSED") {
    const expectedTimeline = plan.scenarios.flatMap((scenario) => scenario.steps.map((step, stepIndex) => ({
      scenarioId: scenario.id, stepIndex, kind: step.kind,
    })));
    if (inputTimeline.length !== expectedTimeline.length || inputTimeline.some((event, index) => {
      const expected = expectedTimeline[index]!;
      return event.scenarioId !== expected.scenarioId || event.stepIndex !== expected.stepIndex || event.kind !== expected.kind;
    })) invalid("complete input timeline");
  }
  if (!Array.isArray(body.screenshots) || body.screenshots.length < 1 || body.screenshots.length > 1_024) invalid("screenshots");
  const names = new Set<string>();
  const screenshots = body.screenshots.map((item) => {
    const screenshot = object(item, "screenshot");
    exactKeys(screenshot, ["name", "file", "sha256", "width", "height"], "screenshot");
    if (typeof screenshot.name !== "string" || !SAFE_ID.test(screenshot.name) || names.has(screenshot.name)
      || typeof screenshot.file !== "string" || !safeRelativeFile(screenshot.file)
      || typeof screenshot.sha256 !== "string" || !SHA256.test(screenshot.sha256)) invalid("screenshot binding");
    names.add(screenshot.name);
    return { name: screenshot.name, file: screenshot.file, sha256: screenshot.sha256, width: integer(screenshot.width, 1, 16_384, "screenshot width"), height: integer(screenshot.height, 1, 16_384, "screenshot height") };
  });
  const expectedScreenshotNames = plan.scenarios.flatMap((scenario) => scenario.steps
    .filter((step): step is Extract<GodotTestStep, { kind: "SCREENSHOT" }> => step.kind === "SCREENSHOT")
    .map((step) => step.name));
  if (screenshots.some((screenshot) => !expectedScreenshotNames.includes(screenshot.name))
    || (body.status === "PASSED" && JSON.stringify(screenshots.map((screenshot) => screenshot.name)) !== JSON.stringify(expectedScreenshotNames))) {
    invalid("screenshot checkpoints");
  }
  const performance = object(body.performance, "harness performance");
  exactKeys(performance, ["averageFrameMs", "p95FrameMs", "sampledFrames"], "harness performance");
  const parsedPerformance = {
    averageFrameMs: finite(performance.averageFrameMs, 0, 10_000, "average frame time"),
    p95FrameMs: finite(performance.p95FrameMs, 0, 10_000, "p95 frame time"),
    sampledFrames: integer(performance.sampledFrames, 1, 100_000, "sampled frames"),
  };
  if (body.status === "PASSED" && (parsedPerformance.sampledFrames !== plan.performance.sampleFrames
    || parsedPerformance.averageFrameMs > plan.performance.maximumAverageFrameMs
    || parsedPerformance.p95FrameMs > plan.performance.maximumP95FrameMs)) invalid("performance verdict");
  return deepFreeze({
    schemaVersion: "deviludo.godot-harness-result.v1",
    status: body.status,
    checks,
    inputTimeline,
    screenshots,
    performance: parsedPerformance,
    videoFile: body.videoFile,
    createdAt: body.createdAt,
  });
}

function parseScenario(value: unknown, index: number): GodotTestScenario {
  const body = object(value, `scenario ${index}`);
  exactKeys(body, ["id", "outcome", "steps"], `scenario ${index}`);
  if (typeof body.id !== "string" || !SAFE_ID.test(body.id)
    || !["CORE_LOOP", "WIN", "LOSE", "PAUSE_SETTINGS", "SAVE_LOAD"].includes(String(body.outcome))
    || !Array.isArray(body.steps) || body.steps.length < 1 || body.steps.length > 1_000) invalid(`scenario ${index}`);
  return {
    id: body.id,
    outcome: body.outcome as GodotTestOutcome,
    steps: body.steps.map((step, stepIndex) => parseStep(step, index, stepIndex)),
  };
}

function parseStep(value: unknown, scenario: number, index: number): GodotTestStep {
  const body = object(value, `scenario ${scenario} step ${index}`);
  if (body.kind === "WAIT_FRAMES") {
    exactKeys(body, ["kind", "frames"], "wait step");
    return { kind: "WAIT_FRAMES", frames: integer(body.frames, 1, 3_600, "wait frames") };
  }
  if (body.kind === "ACTION") {
    exactKeys(body, ["kind", "action", "pressed", "framesAfter"], "action step");
    if (typeof body.action !== "string" || !SAFE_ACTION.test(body.action) || typeof body.pressed !== "boolean") invalid("action step");
    return { kind: "ACTION", action: body.action, pressed: body.pressed, framesAfter: integer(body.framesAfter, 0, 600, "action frames") };
  }
  if (body.kind === "ASSERT_PROPERTY") {
    exactKeys(body, ["kind", "nodePath", "property", "equals"], "property assertion");
    if (typeof body.nodePath !== "string" || !SAFE_NODE_PATH.test(body.nodePath)
      || typeof body.property !== "string" || !SAFE_ACTION.test(body.property)
      || !scalar(body.equals)) invalid("property assertion");
    return { kind: "ASSERT_PROPERTY", nodePath: body.nodePath, property: body.property, equals: body.equals };
  }
  if (body.kind === "ASSERT_GROUP_COUNT") {
    exactKeys(body, ["kind", "group", "minimum", "maximum"], "group assertion");
    if (typeof body.group !== "string" || !SAFE_ACTION.test(body.group)) invalid("group assertion");
    const minimum = integer(body.minimum, 0, 100_000, "group minimum");
    const maximum = integer(body.maximum, minimum, 100_000, "group maximum");
    return { kind: "ASSERT_GROUP_COUNT", group: body.group, minimum, maximum };
  }
  if (body.kind === "SCREENSHOT") {
    exactKeys(body, ["kind", "name"], "screenshot step");
    if (typeof body.name !== "string" || !SAFE_ID.test(body.name)) invalid("screenshot step");
    return { kind: "SCREENSHOT", name: body.name };
  }
  invalid("test step kind");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid(`${label} fields`);
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(label);
  return value as number;
}

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) invalid(label);
  return value;
}

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function absolutePath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && value.length <= 4_096 && !/\0/.test(value);
}

function safeRelativeFile(value: string): boolean {
  return value.length >= 3 && value.length <= 512 && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => !!part && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(label: string): never {
  throw new Error(`Godot TestKit ${label} is invalid`);
}
