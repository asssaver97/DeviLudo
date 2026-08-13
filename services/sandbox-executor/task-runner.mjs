#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, copyFile, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

let progressWrites = Promise.resolve();
let agentOutputBuffer = "";
let sawPartialAgentOutput = false;

await mkdir("/workspace/inputs", { recursive: true });
await mkdir("/workspace/project", { recursive: true });
await mkdir("/workspace/outputs", { recursive: true });

for (let attempt = 0; attempt < 600; attempt += 1) {
  try {
    await readFile("/run/deviludo/ready");
    break;
  } catch {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (attempt === 599) throw new Error("Executor did not provide the task plan");
}

const plan = JSON.parse(await readFile("/run/deviludo/plan.json", "utf8"));

let taskError;
try {
  if (plan.job.jobKind === "AGENT_GENERATION") await runAgent(plan);
  else if (plan.job.jobKind === "PROJECT_DOCUMENT_MAINTENANCE") await runProjectDocumentMaintenance(plan);
  else if (plan.job.jobKind === "ARTIFACT_BUILD") await runGodotBuild(plan);
  else if (plan.job.jobKind === "STEAM_PUBLISH") await runSteamPublish(plan);
  else throw new Error(`Unsupported Core task kind: ${plan.job.jobKind}`);
} catch (error) {
  taskError = error instanceof Error ? error : new Error("Task execution failed");
}
await progressWrites;
await writeFile("/run/deviludo/task-result.json", JSON.stringify({
  ok: !taskError,
  error: taskError ? sanitizeError(taskError.message) : null,
}), { mode: 0o600 });
for (let attempt = 0; attempt < 600; attempt += 1) {
  try {
    await readFile("/run/deviludo/collected");
    break;
  } catch {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (attempt === 599) throw new Error("Executor did not collect task outputs");
}
if (taskError) throw taskError;

async function runAgent(plan) {
  emitProgress("PHASE", "正在读取已批准的项目需求与现有源码");
  const configuration = plan.agentConfiguration;
  if (!configuration) throw new Error("Agent configuration is required");
  let specification;
  try {
    specification = JSON.parse(await readFile("/workspace/inputs/specification.json", "utf8"));
  } catch {
    throw new Error("Approved project specification input is missing or invalid");
  }
  if (!specification || typeof specification !== "object" || Array.isArray(specification)) {
    throw new Error("Approved project specification input is invalid");
  }
  const importedSource = typeof plan.job.payload.sourceRelativePath === "string";
  if (importedSource) {
    await command("tar", ["-xzf", "/workspace/inputs/source.tar.gz", "-C", "/workspace/project"], safeEnvironment());
    emitProgress("PHASE", "现有项目源码已展开，Agent 正在分析工程结构");
  }
  const restoredCheckpoint = await exists("/workspace/inputs/checkpoint.tar.gz");
  const checkpointMetadata = restoredCheckpoint
    ? await readCheckpointMetadata()
    : null;
  if (restoredCheckpoint) {
    await command("tar", ["-xzf", "/workspace/inputs/checkpoint.tar.gz", "-C", "/workspace/project"], safeEnvironment());
    emitProgress("PHASE", "上次尝试的源码检查点已恢复，Agent 将从现有成果继续");
  }
  const requirementCatalog = specificationRequirementCatalog(specification);
  if (requirementCatalog.length < 1) {
    throw new Error("Approved specification does not contain testable coreLoop or acceptanceCriteria requirements");
  }
  const existingManifestValid = await existingAgentManifestIsValid(requirementCatalog);
  const e2eReportObject = plan.job.inputObjects.find(input => input.kind === "E2E_REPORT");
  let e2eRepairContext = null;
  if (e2eReportObject) {
    if (e2eReportObject.sizeBytes > 1024 * 1024 * 1024) throw new Error("E2E failure evidence exceeds the Agent repair input limit");
    const filename = e2eReportObject.key.split("/").pop();
    if (!filename) throw new Error("E2E failure report input is invalid");
    if (!filename.endsWith(".zip")) throw new Error("E2E repair input must be the current evidence ZIP");
    e2eRepairContext = await extractE2eRepairEvidence(`/workspace/inputs/${filename}`);
    emitProgress("PHASE", `Agent 正在修复 ${plan.job.payload.failedPlatform ?? "目标平台"} E2E 发现的游戏问题`);
  }
  const checkpointEmitterInstruction = "A DEVILUDO_E2E_CHECKPOINT:<checkpoint-id> runtime marker is optional synchronization metadata only and can never satisfy an assertion by itself. If used, emit it only after the real semantic state exists and append it to DEVILUDO_E2E_CHECKPOINT_FILE when that environment variable is non-empty.";
  const probeInstruction = "Implement the read-only deviludo.e2e-ui-probe contract in the actual game. Atomically replace DEVILUDO_E2E_UI_PROBE_FILE after each visible/state/progress change. Every snapshot uses schema deviludo.e2e-ui-probe and must contain the current DEVILUDO_E2E_SESSION_NONCE, OS process id, a strictly increasing sequence, sceneId, flat state and progress objects, and unique stable controls with id, visible, enabled, text/value, and 1280x720 client-relative rect. The probe may describe state but must never invoke actions, complete gameplay, or fake results.";
  const manifestInstructions = existingManifestValid ? [
    "Core has already validated the existing agent.json as a complete deviludo.test-manifest and asset manifest. Preserve its coverage and assertions unless the current change genuinely requires an update.",
    checkpointEmitterInstruction,
    probeInstruction,
    ...(e2eRepairContext ? [
      "This repair does not need manifest work unless the failure report explicitly identifies a manifest error. Do not inspect manifest generators or broad requirement coverage.",
    ] : [
      "After implementing and testing this revision, make only the minimal existing agent.json edits needed to map genuinely new check names.",
    ]),
  ] : [
    "IMPORTANT: The generated agent.json must include a complete testManifest AND an assetManifest.",
    "",
    "testManifest structure:",
    "- schema: \"deviludo.test-manifest\". Do not emit schemaVersion or any version field.",
    "- inputProfiles: one or both of KEYBOARD_MOUSE and GAMEPAD; primaryInputProfile must be one declared profile. Every declared profile must appear in deterministic real-input coverage.",
    "- adaptivePlayer: goal, requirementIds including every CORE_LOOP requirement, allowedActions (KEYBOARD, POINTER and/or GAMEPAD), non-empty successAssertions and failureAssertions, rolloutTimeoutMs 60000-300000, maxDecisions 8-40, seedStrategy STABLE_PROJECT_PLATFORM. successAssertions must include a PROGRESS CHANGED/NOT_EQUALS/GREATER_THAN/GREATER_THAN_OR_EQUALS assertion proving a real progress boundary relative to the clean rollout start.",
    "- requirements: copy the exact requirementId, description, source and default verificationClass pairs below; every CORE_LOOP remains PLAYER_INTERACTION. An ACCEPTANCE item may be SYSTEM only for DATA, RUNTIME or NETWORK and must include systemCategory plus a concrete exemptionReason of at least 10 characters.",
    "- features: array of feature objects, each with:",
    "  - id: unique kebab-case identifier (e.g. \"collect-ember\")",
    "  - requirementIds: one or more IDs from the exact frozen requirement catalog below",
    "  - category: one of core-loop, player-control, data-integrity, runtime-quality, ui, audio",
    "  - description: human-readable feature description",
    "  - verificationMethod: unit, interactive, visual, or manual; manual must never be the only automated coverage for a requirement",
    "  - gdsTestPath: path to test script (typically \"res://tests/e2e.gd\")",
    "  - checkNames: array of assertion names that verify this feature; every unit feature also requires timeoutMs no more than 300000",
    "- At least one feature must be category core-loop, verificationMethod interactive, coreJourney true, launchProfile {type:\"FRESH\"}, and timeoutMs no more than 300000. Scenario fixtures are allowed only on non-core journeys and may initialize state but never perform the tested action.",
    "- Its interactionScript contains only events and no version field, with no more than 200 events. Use semantic target IDs only; fixed x/y coordinates and unrelated key presses are forbidden.",
    "- Action event types are key_tap, key_hold, click, double_click, drag, scroll, text_input, gamepad_button_tap, gamepad_button_hold, gamepad_axis, gamepad_trigger and gamepad_release_all. Every action requires a unique stepId, intent, coversRequirementIds and at least one postcondition. Click/drag/scroll/text targets use stable probe control IDs.",
    "- Example: {\"type\":\"click\",\"stepId\":\"roll-dice\",\"intent\":\"PRIMARY_ACTION\",\"targetId\":\"roll-dice\",\"coversRequirementIds\":[\"req-feature-001-...\"],\"postconditions\":[{\"source\":\"PROGRESS\",\"key\":\"turn\",\"operator\":\"CHANGED\"}],\"delay_ms\":100}.",
    "- Probe assertions use source STATE, PROGRESS, CONTROL or SCENE and operator EQUALS, NOT_EQUALS, GREATER_THAN, GREATER_THAN_OR_EQUALS, LESS_THAN, LESS_THAN_OR_EQUALS, CONTAINS, EXISTS or CHANGED.",
    "- Every PLAYER_INTERACTION requirement must be covered by at least one real action inside a feature that maps that requirement, and every such action must verify an operation-after state change through postconditions.",
    "- The fresh core journey must cross a real progress boundary and include at least two real actions with PRIMARY_ACTION and COMPLETE_LOOP intents.",
    "- The core journey must contain asserted checkpoint events with unique IDs and the roles START, READY, PROGRESS, and COMPLETION; at least one must use visualMode STABLE_REPLAY. Other checkpoints may use DYNAMIC.",
    "- Every DYNAMIC ACTION, PROGRESS or COMPLETION checkpoint must declare changeTargetId for a stable semantic control or viewport region whose pixels must change after the preceding real input.",
    "- A checkpoint requires non-empty assertions. expectedOutput is optional auxiliary synchronization and, if present, must equal DEVILUDO_E2E_CHECKPOINT:<checkpoint-id>.",
    checkpointEmitterInstruction,
    probeInstruction,
    "- A checkpoint may declare referenceImage as a safe project-relative PNG and threshold from 0 to 1; the default threshold is 0.01.",
    "- Across the manifest: at most 500 requirements, 500 features, 32 interactive journeys, and 64 checkpoints. Each journey is at most 300 seconds. Core freezes a calculated 30-90 minute platform budget before E2E begins.",
    `- Frozen requirement catalog: ${JSON.stringify(requirementCatalog)}`,
    "",
    "assetManifest structure:",
    "- schemaVersion: \"deviludo.asset-manifest.v1\"",
    "- items: array of required game assets, each with:",
    "  - assetKey: unique path identifier (e.g. \"sprites/player_idle\", \"backgrounds/menu\")",
    "  - assetType: one of sprite, animation, background, ui, icon, tileset",
    "  - description: precise user-facing description of what this asset looks like (e.g. \"Player character idle animation, 4 frames, pixel art style, 32x32, facing right\")",
    "  - generationPrompt: detailed technical prompt for image generation model (e.g. \"pixel art sprite sheet, 4 frames of idle animation, character facing right, 32x32 per frame, transparent background, retro game style\")",
    "  - frameCount: number of frames if animation (null for single sprites)",
    "  - dimensions: recommended size like \"32x32\" or \"128x128\"",
    "",
    "Asset planning guidelines:",
    "- List ALL sprites, backgrounds, UI elements, and tilesets the game needs",
    "- assetKey is an ASCII relative path without a file extension; use only letters, digits, dots, underscores, hyphens, and slashes",
    "- For animations, specify exact frame count and describe the motion sequence",
    "- The controlled builder materializes supplied images at res://assets/generated/<assetKey>.png, .jpg, or .webp",
    "- Game code must try those three generated paths at runtime and use its placeholder only when none exists",
    "- Write descriptions assuming the player may upload custom art or use image generation",
    "- generationPrompt should be optimized for DALL-E 3 or Stable Diffusion XL",
    "",
    "Test script requirements (res://tests/e2e.gd):",
    "1. Must extend SceneTree and run all tests in _initialize()",
    "2. Use check(condition: bool, name: String) for each assertion",
    "3. Assertion names must be kebab-case and match checkNames in testManifest",
    "4. Must output: print(\"DEVILUDO_E2E_RESULT:\", JSON.stringify({suite, checks, failures, duration_ms}))",
    "5. Must exit with: quit(0 if failures.is_empty() else 1)",
    "",
    "Reference implementation: fixtures/godot-smoke/tests/e2e.gd demonstrates the required pattern.",
    "",
    "Every player-operable feature declared in the project document must have corresponding real system-level keyboard/mouse actions and postconditions. Headless unit checks remain appropriate only for data, runtime, network and deterministic algorithm details.",
  ];
  const specificationInstructions = existingManifestValid
    ? [`Current revision notes: ${JSON.stringify(specification.revisionNotes ?? [])}`]
    : [`Specification: ${JSON.stringify(specification)}`];
  const prompt = [
    importedSource || restoredCheckpoint
      ? "Continue developing the existing Godot 4 project in /workspace/project. Inspect and preserve its working structure before changing it."
      : "Create a complete Godot 4 project in /workspace/project.",
    "Do not access paths outside /workspace/project except to read /run/deviludo/guidance.ndjson and, on an E2E repair pass, /workspace/inputs/e2e-repair. Include project.godot, main scene, source, tests, Linux/Windows/macOS export presets, and LICENSES.json.",
    "Enable rendering/textures/vram_compression/import_s3tc_bptc so release exports are portable.",
    "The result must run headlessly and expose a deterministic smoke-test path.",
    "Godot and Python may be absent from this Agent container. Do not search for or install them, and do not treat their absence as a failure. The next controlled builder stage performs real Godot validation; use Node-based static checks here when useful.",
    "Prioritize a complete playable vertical slice, required files, and deterministic tests before optional polish.",
    "Implement the current revision notes and missing behavior without re-auditing unrelated code that is already complete.",
    "Start with the current revision notes. Inspect no more than the few source and test files directly needed for them, and make the first concrete source edit before inspecting broad regression coverage or manifest tooling.",
    ...manifestInstructions,
    "Real-window interaction timing contract: the guest driver waits event.delay_ms BEFORE it performs that event. This applies to key presses, key releases, mouse events, waits, and checkpoints.",
    "A checkpoint also captures a real PNG after its delay and therefore consumes unpredictable wall-clock time while the exported game keeps running. Never model checkpoints as zero-time events.",
    "Place checkpoints only where capture latency cannot invalidate later input (for example READY before the first input, after the last input needed for a KEY_STATE, and after completion), or explicitly make the game state safe while capturing.",
    "When generating or repairing an interactionScript, reconstruct actual action times by adding each event delay before recording the action. Validate the emitted key/mouse schedule under that exact ordering; do not use a helper that records an action before its delay.",
    "Do not spawn subagents, background agents, background tasks, or delegated code reviews. Work directly with the available file and shell tools.",
    "Run at most one bounded static validation pass. The controlled Builder and E2E stages perform the exhaustive runtime validation, so finish once the requested source and manifests are complete.",
    ...(restoredCheckpoint ? [
      "A source checkpoint from an interrupted attempt is already restored. Continue only the interrupted implementation; do not start a general project audit, add unrelated improvements, invent new validators, or rewrite documentation outside the current requirement.",
      "Treat completed checkpoint files as authoritative. Inspect only the files needed to finish the interrupted requirement, run one existing bounded static check, update the required manifests, and finish immediately.",
    ] : []),
    "During development, repeatedly check /run/deviludo/guidance.ndjson. It is an append-only stream of live player guidance. Incorporate every new entry before the next major change and never overwrite it. The latest live guidance is the highest-priority scope constraint: stop broader analysis immediately when it narrows the requested change.",
    "Briefly report what you are inspecting, changing, and validating while you work; these updates are shown live to the player.",
    ...(e2eRepairContext ? [
      "",
      "This is an automatic repair pass after a trusted E2E product failure. Reproduce the reported game behavior from the existing source, fix the game content, scripts, scenes, or project configuration, and preserve unrelated working behavior.",
      "Do not dismiss the report as infrastructure failure and do not merely rewrite the report. Make concrete source changes that address its diagnostics.",
      ...((e2eRepairContext.report ?? e2eRepairContext).testDetails?.failures?.length > 0 ? [
        `Failed feature checks: ${(e2eRepairContext.report ?? e2eRepairContext).testDetails.failures.join(", ")}`,
        "Review the test script to understand what each failed check validates, then fix the game logic or configuration that caused the failure. Do not modify test assertions unless they are objectively incorrect.",
      ] : []),
      "The verified evidence files are available in /workspace/inputs/e2e-repair. Inspect report.json, logs, and only the failed checkpoint screenshots needed for the fix.",
      `E2E failure summary: ${JSON.stringify(e2eRepairPromptSummary(e2eRepairContext))}`,
    ] : []),
    ...specificationInstructions,
  ].join("\n");
  const completedCheckpoint = checkpointMetadata?.state === "AGENT_COMPLETE"
    && checkpointMetadata.originJobId === plan.job.jobId;
  if (completedCheckpoint) {
    emitProgress("PHASE", "已恢复本任务完成的 Agent 检查点，跳过重复模型调用");
  } else {
    // Claude can occasionally end a successful CLI session after announcing
    // its next step but before editing anything. A fresh pass over existing
    // source must therefore produce a concrete change. A restored checkpoint
    // is exempt only when it already differs from the frozen input revision;
    // an unchanged "complete" checkpoint from an earlier failed job must not
    // bypass the guard on a stage rerun.
    const restoredOrImportedDigest = importedSource
      ? await projectTreeDigest("/workspace/project")
      : null;
    const frozenSourceDigest = typeof plan.job.payload.sourceDigest === "string"
      ? plan.job.payload.sourceDigest
      : null;
    const startingDigest = restoredOrImportedDigest === frozenSourceDigest
      ? restoredOrImportedDigest
      : null;
    const apiKey = (await readFile("/run/deviludo/provider.key", "utf8")).trim();
    const environment = { ...safeEnvironment(), ...configuration.environment };
    emitProgress("PHASE", "Agent 正在编写并验证游戏项目");
    await runGenerationAgent(
      configuration,
      environment,
      prompt,
      emitAgentOutput,
      apiKey,
      plan.job.jobId,
      plan.job.timeoutSeconds,
      startingDigest === null ? null : async () => {
        const currentDigest = await projectTreeDigest("/workspace/project");
        if (currentDigest === startingDigest) {
          throw new Error("Agent returned before making required source changes");
        }
        return currentDigest;
      },
      e2eRepairContext ? 2 * 60_000 : 5 * 60_000,
      e2eRepairContext ? 60_000 : undefined,
    );
    flushAgentOutput();
  }
  // The CLI stdout is an event stream (Codex JSONL or Claude stream-json), not
  // the agent.json contract. Upload the file the Agent wrote into the generated
  // source so Core can ingest its test and asset manifests from the trusted,
  // digest-checked output object.
  const agentManifest = await readGeneratedAgentManifest(requirementCatalog);
  await writeFile("/workspace/outputs/agent.json", JSON.stringify(agentManifest), "utf8");
  emitProgress("PHASE", "Agent 已完成代码修改，正在发布源码 revision");
  await manifest([
    { file: "agent.json", kind: "SPECIFICATION", contentType: "application/json" },
  ]);
}

async function readCheckpointMetadata() {
  try {
    const value = JSON.parse(await readFile("/workspace/inputs/checkpoint.json", "utf8"));
    if (value?.schemaVersion !== "deviludo.source-checkpoint.v1"
      || !["PARTIAL", "AGENT_COMPLETE"].includes(value.state)
      || typeof value.originJobId !== "string") return null;
    return value;
  } catch {
    // Legacy checkpoints have no metadata and remain valid partial source.
    return null;
  }
}

async function readGeneratedAgentManifest(requirementCatalog) {
  let value;
  try {
    value = JSON.parse(await readFile("/workspace/project/agent.json", "utf8"));
  } catch {
    throw new Error("Agent did not produce a valid agent.json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent did not produce a valid agent.json");
  }
  const testManifest = value.testManifest;
  if (!validTestManifest(testManifest, requirementCatalog)) {
    throw new Error("Agent did not produce a valid testManifest");
  }
  const assetManifest = value.assetManifest;
  if (!assetManifest || typeof assetManifest !== "object" || Array.isArray(assetManifest)
    || assetManifest.schemaVersion !== "deviludo.asset-manifest.v1"
    || !Array.isArray(assetManifest.items)
    || assetManifest.items.length < 1 || assetManifest.items.length > 500
    || assetManifest.items.some(item => !validPlannedAsset(item))) {
    throw new Error("Agent did not produce a valid assetManifest");
  }
  if (new Set(assetManifest.items.map(item => item.assetKey)).size !== assetManifest.items.length) {
    throw new Error("Agent assetManifest keys must be unique");
  }
  return value;
}

async function existingAgentManifestIsValid(requirementCatalog) {
  try {
    await readGeneratedAgentManifest(requirementCatalog);
    return true;
  } catch {
    return false;
  }
}

function validPlannedAsset(item) {
  return item && typeof item === "object" && !Array.isArray(item)
    && typeof item.assetKey === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(item.assetKey)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(item.assetKey) && !item.assetKey.endsWith("/")
    && ["sprite", "animation", "background", "ui", "icon", "tileset"].includes(item.assetType)
    && typeof item.description === "string" && item.description.length >= 1 && item.description.length <= 2000
    && typeof item.generationPrompt === "string"
    && item.generationPrompt.length >= 1 && item.generationPrompt.length <= 4000
    && (item.frameCount == null || (Number.isInteger(item.frameCount) && item.frameCount >= 1 && item.frameCount <= 4096))
    && (item.dimensions == null || (typeof item.dimensions === "string" && /^[0-9]{1,5}x[0-9]{1,5}$/.test(item.dimensions)));
}

function specificationRequirementCatalog(specification) {
  const catalog = [];
  for (const [kind, value] of [["feature", specification.coreLoop], ["acceptance", specification.acceptanceCriteria]]) {
    if (!Array.isArray(value)) continue;
    value.forEach((item, index) => {
      if (typeof item !== "string" || !item.trim()) return;
      catalog.push({
        requirementId: stableRequirementId(kind, index, item),
        description: item.trim(),
        source: kind === "feature" ? "CORE_LOOP" : "ACCEPTANCE",
        verificationClass: "PLAYER_INTERACTION",
      });
    });
  }
  return catalog;
}

function stableRequirementId(kind, index, text) {
  let hash = 0x811c9dc5;
  for (const character of `${kind}\0${index}\0${text.normalize("NFKC").trim()}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `req-${kind}-${String(index + 1).padStart(3, "0")}-${hash.toString(16).padStart(8, "0")}`;
}

function validTestManifest(value, expectedRequirements = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== "deviludo.test-manifest" || Object.hasOwn(value, "schemaVersion")
    || !Array.isArray(value.requirements) || value.requirements.length < 1 || value.requirements.length > 500
    || !Array.isArray(value.features) || value.features.length < 1 || value.features.length > 500) return false;
  if (!Array.isArray(value.inputProfiles) || value.inputProfiles.length < 1 || value.inputProfiles.length > 2
    || value.inputProfiles.some(profile => !["KEYBOARD_MOUSE", "GAMEPAD"].includes(profile))
    || new Set(value.inputProfiles).size !== value.inputProfiles.length
    || !value.inputProfiles.includes(value.primaryInputProfile)) return false;
  const requirementIds = new Set();
  const playerRequirementIds = new Set();
  const coreRequirementIds = new Set();
  for (const requirement of value.requirements) {
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)
      || typeof requirement.requirementId !== "string" || !stableId(requirement.requirementId)
      || requirementIds.has(requirement.requirementId)
      || typeof requirement.description !== "string" || requirement.description.trim().length < 1 || requirement.description.length > 2000
      || !["CORE_LOOP", "ACCEPTANCE"].includes(requirement.source)
      || !["PLAYER_INTERACTION", "SYSTEM"].includes(requirement.verificationClass)) return false;
    if (requirement.source === "CORE_LOOP" && requirement.verificationClass !== "PLAYER_INTERACTION") return false;
    if (requirement.verificationClass === "SYSTEM") {
      if (requirement.source !== "ACCEPTANCE"
        || !["DATA", "RUNTIME", "NETWORK"].includes(requirement.systemCategory)
        || typeof requirement.exemptionReason !== "string" || requirement.exemptionReason.trim().length < 10
        || requirement.exemptionReason.length > 1000) return false;
    } else if (requirement.systemCategory !== undefined || requirement.exemptionReason !== undefined) return false;
    requirementIds.add(requirement.requirementId);
    if (requirement.verificationClass === "PLAYER_INTERACTION") playerRequirementIds.add(requirement.requirementId);
    if (requirement.source === "CORE_LOOP") coreRequirementIds.add(requirement.requirementId);
  }
  const adaptive = value.adaptivePlayer;
  if (!adaptive || typeof adaptive !== "object" || Array.isArray(adaptive)
    || typeof adaptive.goal !== "string" || adaptive.goal.trim().length < 10 || adaptive.goal.length > 4000
    || !Array.isArray(adaptive.requirementIds) || adaptive.requirementIds.length < 1
    || adaptive.requirementIds.some(id => !playerRequirementIds.has(id))
    || [...coreRequirementIds].some(id => !adaptive.requirementIds.includes(id))
    || !Array.isArray(adaptive.allowedActions) || adaptive.allowedActions.length < 1
    || adaptive.allowedActions.some(item => !["KEYBOARD", "POINTER", "GAMEPAD"].includes(item))
    || !Array.isArray(adaptive.successAssertions) || adaptive.successAssertions.length < 1 || !adaptive.successAssertions.every(validProbeAssertion)
    || !adaptive.successAssertions.some(assertion => assertion && assertion.source === "PROGRESS"
      && ["CHANGED", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS"].includes(assertion.operator))
    || !Array.isArray(adaptive.failureAssertions) || adaptive.failureAssertions.length < 1 || !adaptive.failureAssertions.every(validProbeAssertion)
    || !Number.isInteger(adaptive.rolloutTimeoutMs) || adaptive.rolloutTimeoutMs < 60000 || adaptive.rolloutTimeoutMs > 300000
    || !Number.isInteger(adaptive.maxDecisions) || adaptive.maxDecisions < 8 || adaptive.maxDecisions > 40
    || adaptive.seedStrategy !== "STABLE_PROJECT_PLATFORM"
    || adaptive.allowedActions.includes("GAMEPAD") !== value.inputProfiles.includes("GAMEPAD")
    || (adaptive.allowedActions.includes("KEYBOARD") || adaptive.allowedActions.includes("POINTER")) !== value.inputProfiles.includes("KEYBOARD_MOUSE")) return false;
  if (expectedRequirements) {
    if (value.requirements.length !== expectedRequirements.length) return false;
    const actual = new Map(value.requirements.map(item => [item.requirementId, item]));
    if (expectedRequirements.some(item => {
      const received = actual.get(item.requirementId);
      return !received || received.description !== item.description || received.source !== item.source
        || (item.source === "CORE_LOOP" && received.verificationClass !== "PLAYER_INTERACTION");
    })) return false;
  }
  const featureIds = new Set();
  const checkNames = new Set();
  const automatedCoverage = new Set();
  let journeys = 0;
  let checkpoints = 0;
  let coreJourney = false;
  const interactiveCoverage = new Set();
  const exercisedInputProfiles = new Set();
  for (const feature of value.features) {
    if (!feature || typeof feature !== "object" || Array.isArray(feature)
      || typeof feature.id !== "string" || !stableId(feature.id) || featureIds.has(feature.id)
      || !["core-loop", "player-control", "data-integrity", "runtime-quality", "ui", "audio", "network"].includes(feature.category)
      || typeof feature.description !== "string" || feature.description.trim().length < 1 || feature.description.length > 2000
      || !["unit", "interactive", "visual", "manual"].includes(feature.verificationMethod)
      || !Array.isArray(feature.requirementIds) || feature.requirementIds.length < 1
      || feature.requirementIds.some(id => typeof id !== "string" || !requirementIds.has(id))) return false;
    featureIds.add(feature.id);
    if (feature.verificationMethod !== "manual") for (const id of feature.requirementIds) automatedCoverage.add(id);
    if (feature.verificationMethod === "unit") {
      if (typeof feature.gdsTestPath !== "string"
        || !/^res:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,219}\.gd$/.test(feature.gdsTestPath)
        || /(^|\/)\.{1,2}(\/|$)|\/\//.test(feature.gdsTestPath.slice(6))
        || !Array.isArray(feature.checkNames) || feature.checkNames.length < 1
        || !Number.isInteger(feature.timeoutMs) || feature.timeoutMs < 1 || feature.timeoutMs > 300000
        || feature.checkNames.some(name => typeof name !== "string" || !stableId(name) || checkNames.has(name))) return false;
      for (const name of feature.checkNames) checkNames.add(name);
    } else if (feature.verificationMethod === "interactive") {
      if (!validInteractionScript(feature.interactionScript)
        || !Number.isInteger(feature.timeoutMs) || feature.timeoutMs < 1 || feature.timeoutMs > 300000
        || !validLaunchProfile(feature.launchProfile)) return false;
      journeys += 1;
      const checkpointEvents = feature.interactionScript.events.filter(event => event.type === "checkpoint");
      if (feature.launchProfile.type === "SCENARIO"
        && !checkpointEvents.some(event => event.visualMode === "STABLE_REPLAY")) return false;
      checkpoints += checkpointEvents.length;
      const actionEvents = feature.interactionScript.events.filter(event => isInteractionActionType(event.type));
      for (const event of actionEvents) exercisedInputProfiles.add(event.type.startsWith("gamepad_") ? "GAMEPAD" : "KEYBOARD_MOUSE");
      for (const action of actionEvents) {
        for (const requirementId of action.coversRequirementIds) {
          if (!feature.requirementIds.includes(requirementId) || !playerRequirementIds.has(requirementId)) return false;
          interactiveCoverage.add(requirementId);
        }
      }
      if (feature.coreJourney === true && feature.category === "core-loop") {
        const roles = new Set(checkpointEvents.map(event => event.role));
        const intents = new Set(actionEvents.map(event => event.intent));
        const assertionsComplete = checkpointEvents.every(event => event.assertions.length > 0
          && (event.referenceImage || event.expectedOutput === undefined || event.expectedOutput === checkpointOutputMarker(event.id)));
        if (feature.launchProfile.type === "FRESH"
          && ["START", "READY", "PROGRESS", "COMPLETION"].every(role => roles.has(role))
          && checkpointEvents.some(event => event.visualMode === "STABLE_REPLAY")
          && assertionsComplete && intents.has("PRIMARY_ACTION") && intents.has("COMPLETE_LOOP")
          && actionEvents.length >= 2) coreJourney = true;
      }
    } else if (feature.verificationMethod === "visual") {
      if (!validVisualSpec(feature.expectedVisual)) return false;
      checkpoints += 1;
    }
  }
  return journeys >= 1 && journeys <= 32 && checkpoints >= 3 && checkpoints <= 64 && coreJourney
    && value.inputProfiles.every(profile => exercisedInputProfiles.has(profile))
    && [...requirementIds].every(id => automatedCoverage.has(id))
    && [...playerRequirementIds].every(id => interactiveCoverage.has(id));
}

function validInteractionScript(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.hasOwn(value, "version")
    || !Array.isArray(value.events) || value.events.length < 1 || value.events.length > 200) return false;
  const checkpointIds = new Set();
  const stepIds = new Set();
  return value.events.every(event => {
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") return false;
    const delayRequired = event.type === "wait";
    if (event.delay_ms === undefined ? delayRequired : !Number.isInteger(event.delay_ms) || event.delay_ms < 0 || event.delay_ms > 300000) return false;
    if (isInteractionActionType(event.type)) {
      if (!stableId(event.stepId) || stepIds.has(event.stepId)
        || !["START_SESSION", "NAVIGATION", "PRIMARY_ACTION", "FEATURE_ACTION", "COMPLETE_LOOP"].includes(event.intent)
        || !Array.isArray(event.coversRequirementIds) || event.coversRequirementIds.length > 500
        || event.coversRequirementIds.some(id => typeof id !== "string" || !stableId(id))
        || new Set(event.coversRequirementIds).size !== event.coversRequirementIds.length
        || !Array.isArray(event.postconditions) || event.postconditions.length < 1 || event.postconditions.length > 32
        || !event.postconditions.every(validProbeAssertion)) return false;
      stepIds.add(event.stepId);
      if (event.type === "key_tap") return validKeyboardKey(event.key);
      if (event.type === "key_hold") return validKeyboardKey(event.key) && validDuration(event.duration_ms);
      if (["click", "double_click"].includes(event.type)) return stableId(event.targetId)
        && (event.button === undefined || ["LEFT", "RIGHT", "MIDDLE"].includes(event.button));
      if (event.type === "drag") return stableId(event.fromTargetId) && stableId(event.toTargetId)
        && validDuration(event.duration_ms) && (event.button === undefined || event.button === "LEFT");
      if (event.type === "scroll") return stableId(event.targetId) && Number.isInteger(event.deltaY)
        && event.deltaY !== 0 && Math.abs(event.deltaY) <= 10000;
      if (event.type === "text_input") return stableId(event.targetId) && typeof event.text === "string" && event.text.length >= 1 && event.text.length <= 1000;
      if (["gamepad_button_tap", "gamepad_button_hold"].includes(event.type)) return ["A", "B", "X", "Y", "BACK", "GUIDE", "START", "LEFT_STICK", "RIGHT_STICK", "LEFT_SHOULDER", "RIGHT_SHOULDER", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"].includes(event.button)
        && (event.type !== "gamepad_button_hold" || validDuration(event.duration_ms));
      if (event.type === "gamepad_axis") return ["LEFT_X", "LEFT_Y", "RIGHT_X", "RIGHT_Y"].includes(event.axis)
        && typeof event.value === "number" && event.value >= -1 && event.value <= 1
        && (event.duration_ms === undefined || validDuration(event.duration_ms));
      if (event.type === "gamepad_trigger") return ["LEFT", "RIGHT"].includes(event.trigger)
        && typeof event.value === "number" && event.value >= 0 && event.value <= 1
        && (event.duration_ms === undefined || validDuration(event.duration_ms));
      return event.type === "gamepad_release_all";
    }
    if (event.type === "wait") return true;
    if (event.type !== "checkpoint" || typeof event.id !== "string" || !stableId(event.id)
      || checkpointIds.has(event.id) || !["START", "READY", "ACTION", "PROGRESS", "COMPLETION"].includes(event.role)
      || !Array.isArray(event.assertions) || event.assertions.length < 1 || event.assertions.length > 32
      || !event.assertions.every(validProbeAssertion)
      || !["DYNAMIC", "STABLE_REPLAY"].includes(event.visualMode)
      || (event.changeTargetId !== undefined && !stableId(event.changeTargetId))
      || (event.visualMode === "DYNAMIC" && ["ACTION", "PROGRESS", "COMPLETION"].includes(event.role)
        && !stableId(event.changeTargetId))
      || (event.referenceImage !== undefined && !safeProjectPngPath(event.referenceImage))
      || (event.expectedOutput !== undefined && event.expectedOutput !== checkpointOutputMarker(event.id))
      || (event.threshold !== undefined && (typeof event.threshold !== "number" || !Number.isFinite(event.threshold) || event.threshold < 0 || event.threshold > 1))) return false;
    checkpointIds.add(event.id);
    return true;
  });
}

function isInteractionActionType(value) {
  return ["key_tap", "key_hold", "click", "double_click", "drag", "scroll", "text_input", "gamepad_button_tap", "gamepad_button_hold", "gamepad_axis", "gamepad_trigger", "gamepad_release_all"].includes(value);
}

function validProbeAssertion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !["STATE", "PROGRESS", "CONTROL", "SCENE"].includes(value.source)
    || !["EQUALS", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS", "LESS_THAN", "LESS_THAN_OR_EQUALS", "CONTAINS", "EXISTS", "CHANGED"].includes(value.operator)) return false;
  if (["STATE", "PROGRESS"].includes(value.source)) {
    if (typeof value.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value.key)
      || value.targetId !== undefined || value.property !== undefined) return false;
  } else if (value.source === "CONTROL") {
    if (!stableId(value.targetId) || !["visible", "enabled", "text", "value"].includes(value.property)
      || value.key !== undefined) return false;
  } else if (value.key !== undefined || value.targetId !== undefined || value.property !== undefined) return false;
  const needsValue = !["EXISTS", "CHANGED"].includes(value.operator);
  if (needsValue !== Object.hasOwn(value, "value")) return false;
  return value.value === undefined || ["string", "number", "boolean"].includes(typeof value.value);
}

function validLaunchProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.type === "FRESH") return Object.keys(value).length === 1;
  return value.type === "SCENARIO" && stableId(value.scenarioId);
}

function validKeyboardKey(value) {
  return typeof value === "string" && /^(?:KEY_)?(?:[A-Z0-9]|SPACE|ENTER|TAB|ESCAPE|LEFT|RIGHT|UP|DOWN|MINUS|EQUAL)$/.test(value);
}

function validDuration(value) {
  return Number.isInteger(value) && value >= 1 && value <= 300000;
}

function checkpointOutputMarker(checkpointId) {
  return `DEVILUDO_E2E_CHECKPOINT:${checkpointId}`;
}

function validVisualSpec(value) {
  return value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "version")
    && safeProjectPngPath(value.referenceImage)
    && (value.threshold === undefined || (typeof value.threshold === "number" && Number.isFinite(value.threshold) && value.threshold >= 0 && value.threshold <= 1))
    && (value.captureDelay === undefined || (Number.isInteger(value.captureDelay) && value.captureDelay >= 0 && value.captureDelay <= 300000));
}

function stableId(value) {
  return /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}

function safeProjectPngPath(value) {
  return typeof value === "string" && value.length >= 5 && value.length <= 240
    && value.toLowerCase().endsWith(".png") && !value.startsWith("/") && !value.startsWith("res://")
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value) && /^[A-Za-z0-9][A-Za-z0-9._/-]*\.png$/i.test(value);
}

async function extractE2eRepairEvidence(path) {
  const root = "/workspace/inputs/e2e-repair";
  await rm(root, { recursive: true, force: true });
  const { extractAndValidateEvidenceBundle } = await import("/usr/local/lib/deviludo/e2e-evidence.mjs");
  const { report } = await extractAndValidateEvidenceBundle(path, root, 1024 * 1024 * 1024);
  if (report?.schema !== "deviludo.e2e-evidence" || report.outcome !== "FAILED" || report.failureDomain !== "PRODUCT") {
    throw new Error("E2E evidence is not a trusted product failure");
  }
  return { report };
}

function e2eRepairPromptSummary(context) {
  const report = context?.report ?? context ?? {};
  const details = report?.testDetails && typeof report.testDetails === "object"
    ? report.testDetails
    : {};
  const failures = Array.isArray(details.failures)
    ? details.failures.filter(value => typeof value === "string").slice(0, 50)
    : [];
  const failedCheckpoints = Array.isArray(report.checkpoints)
    ? report.checkpoints
      .filter(checkpoint => checkpoint && typeof checkpoint === "object"
        && !["PASSED", "SUCCEEDED"].includes(String(checkpoint.outcome ?? checkpoint.status ?? "").toUpperCase()))
      .map(checkpoint => String(checkpoint.id ?? checkpoint.checkpointId ?? "unknown"))
      .slice(0, 20)
    : [];
  return {
    schema: report.schema,
    platform: report.platform,
    action: report.action,
    failureDomain: report.failureDomain,
    summary: report.summary,
    failures,
    failedCheckpoints,
    screenshotCount: report.screenshotCount,
    visualDiff: report.visualDiff,
  };
}

function godotErrorLines(...logs) {
  const pattern = /(?:SCRIPT ERROR|Parse Error|Parser Error|Compile Error|Failed to load script|Cannot load script|runtime error|Invalid call\.|GDScript::reload)/i;
  return logs.flatMap(log => String(log ?? "").split(/\r?\n/)).map(line => line.trim()).filter(line => pattern.test(line)).slice(0, 20);
}

async function runGenerationAgent(configuration, environment, prompt, onOutput, apiKey, jobId, timeoutSeconds, verifyCompletion = null, initialProgressDeadlineMs = 5 * 60_000, completionQuiescenceMs = undefined) {
  if (configuration.runtime === "CLAUDE_CODE") {
    environment.ANTHROPIC_AUTH_TOKEN = apiKey;
    // Prompt instructions are not a security boundary: Claude's Bash tool can
    // otherwise launch long-running work with run_in_background and keep the
    // CLI alive after the requested edit is complete. Force the CLI-level
    // switch after instance configuration has been merged so it cannot be
    // overridden by stored provider settings.
    environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  }
  else {
    environment.CODEX_API_KEY = apiKey;
    environment.CODEX_HOME = "/workspace/codex-home";
    await mkdir(environment.CODEX_HOME, { recursive: true });
    const baseUrl = configuration.baseUrl.replace(/"/g, "");
    await writeFile(`${environment.CODEX_HOME}/config.toml`, [
      'model_provider = "deviludo"',
      '[model_providers.deviludo]',
      'name = "Deviludo Provider"',
      `base_url = "${baseUrl}"`,
      'env_key = "CODEX_API_KEY"',
      'wire_api = "responses"',
    ].join("\n"), { mode: 0o600 });
  }

  const deadline = Date.now() + Math.max(60_000, Math.min(80 * 60_000, (timeoutSeconds - 600) * 1_000));
  let lastError;
  let resumeInstruction = "Resume from the current session and files. Finish only the remaining requested implementation and one bounded validation pass. Do not restart analysis or spawn background agents, background shell commands, or background tasks.";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const resumedClaude = configuration.runtime === "CLAUDE_CODE" && attempt > 1;
    const continuation = attempt === 1 ? prompt : resumedClaude
      ? resumeInstruction
      : [
        "Continue from the files already present in /workspace/project after a transient Provider or CLI interruption.",
        "Inspect the existing work first, preserve completed functionality, and finish only the missing validation and required files. Do not restart the project from scratch.",
        prompt,
      ].join("\n");
    const executable = configuration.runtime === "CLAUDE_CODE" ? "claude" : "codex";
    const arguments_ = configuration.runtime === "CLAUDE_CODE"
      ? claudeGenerationArguments(configuration, continuation, jobId, resumedClaude)
      : ["exec", "--ephemeral", "--json", "--skip-git-repo-check", "-C", "/workspace/project", "-"];
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Agent deadline exceeded after 80 minutes");
      const result = await command(
        executable,
        arguments_,
        environment,
        configuration.runtime === "CODEX_CLI" ? continuation : undefined,
        onOutput,
        {
          idleTimeoutMs: 8 * 60_000,
          overallTimeoutMs: remaining,
          initialProgressDeadlineMs: verifyCompletion ? initialProgressDeadlineMs : undefined,
          verifyInitialProgress: verifyCompletion,
          completionQuiescenceMs: verifyCompletion ? completionQuiescenceMs : undefined,
          killProcessGroup: true,
        },
      );
      if (verifyCompletion) await verifyCompletion();
      return result;
    } catch (error) {
      flushAgentOutput();
      lastError = error instanceof Error ? error : new Error("Agent CLI failed");
      const failure = classifyAgentFailure(lastError.message);
      if (attempt === 2 || !failure.recoverable) {
        throw new Error(`Agent CLI failed [${failure.code}]: ${failure.detail}`);
      }
      if (failure.code === "INCOMPLETE_OUTPUT") {
        resumeInstruction = "Resume from the current session and files now. Your previous response stopped before changing any source files. Make the smallest concrete source change required by the latest player guidance or reported E2E failure. For normal development, update only the directly affected automated tests and manifest mapping; for an E2E repair, preserve valid tests and manifests unless the report proves they are wrong. Run one bounded validation pass, then finish. Do not repeat the project audit or merely describe the next step.";
      }
      const delaySeconds = agentRetryDelaySeconds(failure);
      emitProgress("PHASE", `Agent CLI 暂时中断 [${failure.code}]：${failure.detail}；${delaySeconds} 秒后恢复同一会话（2/2）`);
      await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
  }
  throw lastError ?? new Error("Agent CLI failed");
}

function claudeGenerationArguments(configuration, prompt, sessionId, resume) {
  const arguments_ = [
    "-p", "--disable-slash-commands",
    "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--max-turns", "100",
    "--tools", "Read,Write,Edit,Glob,Grep,Bash",
    "--disallowedTools", "Agent,Task",
    "--dangerously-skip-permissions",
  ];
  arguments_.push(resume ? "--resume" : "--session-id", sessionId);
  const primary = configuration.models?.primary;
  const fallbacks = [configuration.models?.sonnet, configuration.models?.haiku, configuration.models?.opus]
    .filter((model, index, models) => typeof model === "string" && model !== primary && models.indexOf(model) === index);
  if (fallbacks.length > 0) arguments_.push("--fallback-model", fallbacks.join(","));
  arguments_.push(prompt);
  return arguments_;
}

function classifyAgentFailure(message) {
  const detail = sanitizeError(message.replace(/^claude exited [^:]+:\s*/i, "").replace(/^codex exited [^:]+:\s*/i, ""));
  if (/\b(?:401|403)\b|invalid api key|authentication|unauthorized|forbidden/i.test(detail)) {
    return { code: "AUTH_ERROR", detail, recoverable: false };
  }
  if (/maximum[ _-]?turns|max[ _-]?turns/i.test(detail)) return { code: "MAX_TURNS", detail, recoverable: true };
  if (/stalled without output/i.test(detail)) return { code: "IDLE_TIMEOUT", detail, recoverable: true };
  if (/deadline exceeded|task container exceeded|timed? out|timeout/i.test(detail)) return { code: "DEADLINE_EXCEEDED", detail, recoverable: true };
  if (/self error/i.test(detail)) return { code: "SELF_ERROR", detail, recoverable: true };
  if (/background tasks still running/i.test(detail)) return { code: "BACKGROUND_TASK_WAIT", detail, recoverable: true };
  if (/returned before making required source changes/i.test(detail)) return { code: "INCOMPLETE_OUTPUT", detail, recoverable: true };
  if (/api error|rate.?limit|overload|temporar|unavailable|connection|econn|socket|fetch failed/i.test(detail)) {
    return { code: "PROVIDER_ERROR", detail, recoverable: true };
  }
  if (/cli exited without a diagnostic/i.test(detail)) return { code: "CLI_ERROR", detail, recoverable: true };
  return { code: "CLI_ERROR", detail, recoverable: false };
}

function agentRetryDelaySeconds(failure) {
  if (failure.code !== "PROVIDER_ERROR") return 5;
  // Provider memory pressure typically survives an immediate retry. Preserve
  // the resumable session and give the gateway enough time to shed work instead
  // of consuming the second model call against the same overload window.
  if (/memory overloaded|memory pressure|capacity|overload/i.test(failure.detail)) return 60;
  return 15;
}

async function projectTreeDigest(root) {
  const normalizedRoot = resolve(root);
  const files = [];
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}/`)) {
        throw new Error("Agent source path escaped the project root");
      }
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error("Agent source contains a link or special file");
      }
      if (info.isDirectory()) await visit(absolute);
      else files.push({
        path: relative(normalizedRoot, absolute).split(sep).join("/"),
        bytes: await readFile(absolute),
      });
    }
  };
  await visit(normalizedRoot);
  const hash = createHash("sha256");
  for (const file of files) {
    const path = Buffer.from(file.path, "utf8");
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(path).update("\0").update(size).update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function runProjectDocumentMaintenance(plan) {
  const configuration = plan.agentConfiguration;
  if (!configuration) throw new Error("Agent configuration is required");
  const apiKey = (await readFile("/run/deviludo/provider.key", "utf8")).trim();
  const payload = plan.job.payload;
  if (payload.maintenanceReason !== "PROJECT_IDLE"
    || typeof payload.projectName !== "string"
    || !Number.isSafeInteger(payload.baseRevision)
    || !payload.document || typeof payload.document !== "object" || Array.isArray(payload.document)
    || !payload.specification || typeof payload.specification !== "object" || Array.isArray(payload.specification)) {
    throw new Error("Idle project document maintenance payload is invalid");
  }
  const prompt = [
    "Maintain the collaborative game project document after the project became idle.",
    "Use the current document and specification as the only source of truth. Do not invent completed functionality.",
    "Write /workspace/project/project-document.json as one JSON object with exactly these fields:",
    'introduction: non-empty string; gameplay: non-empty string; categories: non-empty string array; features: non-empty string array.',
    "Keep the writing concise, current, and useful to multiple collaborators. Do not write any other file.",
    `Project name: ${payload.projectName}`,
    `Current document: ${JSON.stringify(payload.document)}`,
    `Current specification: ${JSON.stringify(payload.specification)}`,
  ].join("\n");
  await runConfiguredAgent(configuration, apiKey, prompt);
  let content;
  try {
    content = JSON.parse(await readFile("/workspace/project/project-document.json", "utf8"));
  } catch {
    throw new Error("Agent did not produce a valid project-document.json");
  }
  validateProjectDocument(content);
  await writeFile("/workspace/outputs/project-document.json", JSON.stringify({
    schemaVersion: "deviludo.project-document.v1",
    content,
  }), "utf8");
  await manifest([{ file: "project-document.json", kind: "PROJECT_DOCUMENT", contentType: "application/json" }]);
}

async function runConfiguredAgent(configuration, apiKey, prompt) {
  const environment = { ...safeEnvironment(), ...configuration.environment };
  if (configuration.runtime === "CLAUDE_CODE") {
    environment.ANTHROPIC_AUTH_TOKEN = apiKey;
    environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    return command("claude", [
      "-p", "--no-session-persistence", "--disable-slash-commands",
      "--output-format", "json", "--max-turns", "12",
      "--tools", "Read,Write,Edit,Glob,Grep",
      "--disallowedTools", "Agent,Task",
      "--dangerously-skip-permissions", prompt,
    ], environment);
  }
  environment.CODEX_API_KEY = apiKey;
  environment.CODEX_HOME = "/workspace/codex-home";
  await mkdir(environment.CODEX_HOME, { recursive: true });
  const baseUrl = configuration.baseUrl.replace(/"/g, "");
  await writeFile(`${environment.CODEX_HOME}/config.toml`, [
    'model_provider = "deviludo"',
    '[model_providers.deviludo]',
    'name = "Deviludo Provider"',
    `base_url = "${baseUrl}"`,
    'env_key = "CODEX_API_KEY"',
    'wire_api = "responses"',
  ].join("\n"), { mode: 0o600 });
  return command("codex", ["exec", "--ephemeral", "--json", "--skip-git-repo-check", "-C", "/workspace/project", "-"], environment, prompt);
}

function validateProjectDocument(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)
    || typeof content.introduction !== "string" || content.introduction.trim().length < 1
    || typeof content.gameplay !== "string" || content.gameplay.trim().length < 1
    || !Array.isArray(content.categories) || content.categories.length < 1 || content.categories.length > 32
    || content.categories.some(value => typeof value !== "string" || value.trim().length < 1)
    || !Array.isArray(content.features) || content.features.length < 1 || content.features.length > 32
    || content.features.some(value => typeof value !== "string" || value.trim().length < 1)) {
    throw new Error("Agent project document does not satisfy the fixed schema");
  }
}

async function runGodotBuild(plan) {
  const { godotExportTarget, prepareGodotProject } = await import("./godot-build.mjs");
  const input = "/workspace/inputs/source.tar.gz";
  emitProgress("PHASE", "正在展开并校验 Agent 生成的 Godot 项目");
  await command("tar", ["-xzf", input, "-C", "/workspace/project"], safeEnvironment());
  await materializeBuildAssets(plan);
  const packagedE2e = await preparePackagedE2eContract();
  const platforms = await prepareGodotProject("/workspace/project", plan.job.payload.targetPlatforms);
  await mkdir("/workspace/.local/share/godot", { recursive: true });
  await symlink("/home/task/.local/share/godot/export_templates", "/workspace/.local/share/godot/export_templates");
  emitProgress("PHASE", "正在导入 Godot 资源并验证主场景");
  await godotCommand(["--headless", "--path", "/workspace/project", "--import"]);
  await godotCommand(["--headless", "--path", "/workspace/project", "--quit-after", "120"]);
  const outputs = [];
  for (const platform of platforms) {
    const target = godotExportTarget(platform);
    const exportDirectory = `/workspace/project/.deviludo-export/${platform}`;
    await mkdir(exportDirectory, { recursive: true });
    emitProgress("PHASE", `正在导出 ${target.name} 制品`);
    await godotCommand(["--headless", "--path", "/workspace/project", "--export-release", target.name, `${exportDirectory}/${target.filename}`]);
    await copyPackagedE2eContract(packagedE2e, exportDirectory);
    const archive = `godot-build-${platform}.tar.gz`;
    await command("tar", ["-czf", `/workspace/outputs/${archive}`, "-C", exportDirectory, "."], safeEnvironment());
    outputs.push({ file: archive, kind: "BUILD", targetPlatform: platform, contentType: "application/gzip" });
  }
  emitProgress("PHASE", "Godot 制品导出完成，正在生成制品清单");
  await manifest(outputs);
}

async function godotCommand(arguments_) {
  const result = await command("godot", arguments_, godotEnvironment());
  const errors = godotErrorLines(result.stdout, result.stderr);
  if (errors.length > 0) throw new Error(`Godot reported script errors despite exit code 0: ${errors.join(" | ")}`);
  return result;
}

async function preparePackagedE2eContract() {
  const { inspectScreenshot } = await import("/usr/local/lib/deviludo/e2e-evidence.mjs");
  let agentManifest;
  try { agentManifest = JSON.parse(await readFile("/workspace/project/agent.json", "utf8")); }
  catch { throw new Error("Build source is missing a valid agent.json test contract"); }
  if (!validTestManifest(agentManifest?.testManifest)) throw new Error("Build source has an invalid deviludo.test-manifest contract");
  const root = "/workspace/project/.deviludo-e2e-package";
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await writeFile(`${root}/manifest.json`, `${JSON.stringify(agentManifest.testManifest, null, 2)}\n`, "utf8");
  const referenceImages = [];
  for (const feature of agentManifest.testManifest.features) {
    if (feature.verificationMethod === "visual") referenceImages.push(feature.expectedVisual.referenceImage);
    if (feature.verificationMethod === "interactive") {
      for (const event of feature.interactionScript.events) if (event.type === "checkpoint" && event.referenceImage) referenceImages.push(event.referenceImage);
    }
  }
  for (const relativePath of new Set(referenceImages)) {
    if (!safeProjectPngPath(relativePath)) throw new Error(`E2E visual baseline path is unsafe: ${relativePath}`);
    const source = resolve("/workspace/project", relativePath);
    if (!source.startsWith("/workspace/project/")) throw new Error("E2E visual baseline escaped the project root");
    const info = await lstat(source).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 64 * 1024 * 1024) {
      throw new Error(`E2E visual baseline is missing or invalid: ${relativePath}`);
    }
    await inspectScreenshot(source).catch(error => {
      throw new Error(`E2E visual baseline is not a valid 1280x720 game frame (${relativePath}): ${error instanceof Error ? error.message : String(error)}`);
    });
    const target = resolve(root, relativePath);
    if (!target.startsWith(`${root}/`)) throw new Error("E2E baseline package path escaped its root");
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return root;
}

async function copyPackagedE2eContract(source, exportDirectory) {
  const target = `${exportDirectory}/.deviludo-e2e`;
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
    const path = resolve(entry.parentPath, entry.name);
    const relativePath = path.slice(source.length + 1);
    const destination = resolve(target, relativePath);
    if (!destination.startsWith(`${target}/`) && destination !== target) throw new Error("E2E package escaped its controlled directory");
    if (entry.isDirectory()) await mkdir(destination, { recursive: true });
    else if (entry.isFile()) { await mkdir(dirname(destination), { recursive: true }); await copyFile(path, destination); }
    else throw new Error("E2E package contains an unsupported file type");
  }
}

async function materializeBuildAssets(plan) {
  const assets = plan.job.inputObjects.filter(input => input.kind === "ASSET");
  if (assets.length === 0) return;
  const root = resolve("/workspace/project/assets/generated");
  const manifestItems = [];
  for (const asset of assets) {
    if (typeof asset.assetKey !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(asset.assetKey)
      || /(^|\/)\.{1,2}(\/|$)|\/\//.test(asset.assetKey) || asset.assetKey.endsWith("/")) {
      throw new Error("Build asset key is invalid");
    }
    const extension = asset.key.match(/\.(png|jpg|webp)$/)?.[1];
    if (!extension) throw new Error("Build asset extension is invalid");
    const target = resolve(root, `${asset.assetKey}.${extension}`);
    if (!target.startsWith(`${root}/`)) throw new Error("Build asset path escaped the generated asset root");
    await mkdir(dirname(target), { recursive: true });
    await copyFile(`/workspace/inputs/${assetInputFilename(asset)}`, target);
    manifestItems.push({
      assetKey: asset.assetKey,
      resourcePath: `res://assets/generated/${asset.assetKey}.${extension}`,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
    });
  }
  await writeFile(`${root}/manifest.json`, JSON.stringify({
    schemaVersion: "deviludo.generated-assets.v1",
    items: manifestItems,
  }), "utf8");
  emitProgress("PHASE", `已同步 ${assets.length} 个图片素材到构建源码`);
}

function assetInputFilename(input) {
  const extension = input.key.match(/\.(png|jpg|webp)$/)?.[1];
  if (!extension) throw new Error("Build asset extension is invalid");
  return `asset-${createHash("sha256").update(input.key).digest("hex")}.${extension}`;
}

async function runSteamPublish(plan) {
  const operation = plan.job.payload.operation;
  if (!operation || typeof operation !== "object") throw new Error("Steam publish operation is required");
  const steam = JSON.parse(await readFile("/run/deviludo/steam.json", "utf8"));
  const platforms = plan.job.payload.targetPlatforms;
  if (!Array.isArray(platforms) || platforms.length < 1
    || platforms.some(platform => !["linux", "windows", "macos"].includes(platform))) {
    throw new Error("Steam targetPlatforms are required");
  }
  if (!steam.username || !steam.loginToken || !/^\d+$/.test(steam.appId)
    || platforms.some(platform => !/^\d+$/.test(steam.depots?.[platform] ?? ""))
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(steam.version ?? "")
    || !Number.isSafeInteger(steam.releaseNumber) || steam.releaseNumber < 1
    || !["TEST", "DEFAULT"].includes(steam.channel)
    || (steam.channel === "DEFAULT" ? steam.targetBranch !== "default" : steam.targetBranch === "default")) {
    throw new Error("Steam publisher configuration is invalid");
  }
  const depotFiles = [];
  const inputFiles = await readdir("/workspace/inputs");
  for (const platform of [...new Set(platforms)]) {
    const filename = inputFiles.find(file => file.startsWith(`build-${platform}-`) && file.endsWith(".tar.gz"));
    if (!filename) throw new Error(`Validated ${platform} build input is missing`);
    const archive = `/workspace/inputs/${filename}`;
    const content = `/workspace/project/content/${platform}`;
    await mkdir(content, { recursive: true });
    await command("tar", ["-xzf", archive, "-C", content], safeEnvironment());
    const depotFile = `/tmp/depot-${platform}.vdf`;
    await writeFile(depotFile, `"DepotBuildConfig"\n{\n  "DepotID" "${steam.depots[platform]}"\n  "ContentRoot" "${content}"\n  "FileMapping" { "LocalPath" "*" "DepotPath" "." "recursive" "1" }\n}\n`, { mode: 0o600 });
    depotFiles.push([steam.depots[platform], depotFile]);
  }
  const appBuild = "/tmp/app-build.vdf";
  const setLive = steam.channel === "TEST" ? `  "SetLive" "${steam.targetBranch}"\n` : "";
  await writeFile(appBuild, `"AppBuild"\n{\n  "AppID" "${steam.appId}"\n  "Desc" "DeviLudo ${steam.version} #${steam.releaseNumber}"\n${setLive}  "ContentRoot" "/workspace/project/content"\n  "BuildOutput" "/tmp/steam-output"\n  "Depots"\n  {\n${depotFiles.map(([id, file]) => `    "${id}" "${file}"`).join("\n")}\n  }\n}\n`, { mode: 0o600 });
  const uploadScript = "/tmp/steam-upload.vdf";
  await writeFile(uploadScript, `@ShutdownOnFailedCommand 1\n@NoPromptForPassword 1\nlogin ${steam.username} ${steam.loginToken}\nrun_app_build ${appBuild}\nquit\n`, { mode: 0o600 });
  const published = await command("steamcmd", ["+runscript", uploadScript], safeEnvironment());
  await rm(uploadScript, { force: true });
  const buildId = published.stdout.match(/\bBuildID\s+(\d+)\b/i)?.[1];
  if (!buildId) throw new Error("Steam did not return a published BuildID");
  await writeFile("/workspace/outputs/steam-publish.json", JSON.stringify({
    published: true,
    operationId: operation.id,
    appId: steam.appId,
    buildId,
    depots: steam.depots,
    releaseId: steam.releaseId,
    version: steam.version,
    releaseNumber: steam.releaseNumber,
    channel: steam.channel,
    targetBranch: steam.targetBranch,
    state: steam.channel === "TEST" ? "LIVE_TEST" : "AWAITING_DEFAULT_PROMOTION",
  }), "utf8");
  await manifest([{ file: "steam-publish.json", kind: "PUBLISH_RECEIPT", contentType: "application/json" }]);
}

async function manifest(outputs) {
  await writeFile("/workspace/outputs/manifest.json", JSON.stringify({ schemaVersion: "deviludo.task-outputs.v1", outputs }), "utf8");
}

function safeEnvironment() {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/workspace",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY } : {}),
  };
}

function godotEnvironment() {
  return {
    ...safeEnvironment(),
    XDG_DATA_HOME: "/workspace/.local/share",
    XDG_CACHE_HOME: "/workspace/.cache",
    XDG_CONFIG_HOME: "/workspace/.config",
  };
}

async function command(executable, arguments_, env, stdin, onStdout, options = {}) {
  const child = spawn(executable, arguments_, {
    cwd: "/workspace/project",
    env,
    shell: false,
    detached: options.killProcessGroup === true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (stdin) child.stdin.end(stdin); else child.stdin.end();
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const progressDecoder = new StringDecoder("utf8");
  let progressBuffer = "";
  let inactivityError = null;
  let inactivityTimer = null;
  let overallTimer = null;
  let initialProgressTimer = null;
  let progressPollTimer = null;
  let completionTimer = null;
  let progressProbeRunning = false;
  let latestProgressToken = null;
  let acceptedAfterProgress = false;
  let forceKillTimer = null;
  const signalChild = signal => {
    if (options.killProcessGroup === true && child.pid) {
      try { process.kill(-child.pid, signal); }
      catch { child.kill(signal); }
    } else child.kill(signal);
  };
  const terminate = error => {
    if (inactivityError) return;
    inactivityError = error;
    signalChild("SIGTERM");
    forceKillTimer = setTimeout(() => signalChild("SIGKILL"), 5_000);
  };
  const acceptCompletedProgress = () => {
    if (inactivityError || acceptedAfterProgress) return;
    acceptedAfterProgress = true;
    signalChild("SIGTERM");
    forceKillTimer = setTimeout(() => signalChild("SIGKILL"), 5_000);
  };
  const resetInactivityTimer = () => {
    if (!options.idleTimeoutMs || inactivityError) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      terminate(new Error(`${executable} stalled without output for ${Math.round(options.idleTimeoutMs / 60_000)} minutes`));
    }, options.idleTimeoutMs);
  };
  resetInactivityTimer();
  if (options.overallTimeoutMs) {
    overallTimer = setTimeout(() => terminate(new Error(`${executable} deadline exceeded after 80 minutes`)), options.overallTimeoutMs);
  }
  if (options.initialProgressDeadlineMs && options.verifyInitialProgress) {
    const probeProgress = async () => {
      if (progressProbeRunning || inactivityError || acceptedAfterProgress) return;
      progressProbeRunning = true;
      try {
        const token = await options.verifyInitialProgress();
        if (initialProgressTimer) {
          clearTimeout(initialProgressTimer);
          initialProgressTimer = null;
        }
        if (!options.completionQuiescenceMs) {
          if (progressPollTimer) clearInterval(progressPollTimer);
          progressPollTimer = null;
          return;
        }
        if (token !== latestProgressToken) {
          latestProgressToken = token;
          if (completionTimer) clearTimeout(completionTimer);
          completionTimer = setTimeout(acceptCompletedProgress, options.completionQuiescenceMs);
        }
      } catch {
        // No source progress yet; the hard first-edit deadline below remains authoritative.
      } finally {
        progressProbeRunning = false;
      }
    };
    progressPollTimer = setInterval(() => { void probeProgress(); }, 5_000);
    void probeProgress();
    initialProgressTimer = setTimeout(() => {
      void Promise.resolve(options.verifyInitialProgress()).catch(error => {
        terminate(error instanceof Error ? error : new Error("Agent did not make required source progress"));
      });
    }, options.initialProgressDeadlineMs);
  }
  child.stdout.on("data", chunk => {
    resetInactivityTimer();
    const data = Buffer.from(chunk);
    stdout.push(data);
    stdoutBytes += data.length;
    if (onStdout) stdoutBytes = trimBufferedTail(stdout, stdoutBytes, 2 * 1024 * 1024);
    if (!onStdout) return;
    progressBuffer += progressDecoder.write(data);
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop() ?? "";
    for (const line of lines) onStdout(line);
  });
  child.stderr.on("data", chunk => {
    resetInactivityTimer();
    const data = Buffer.from(chunk);
    stderr.push(data);
    stderrBytes += data.length;
    stderrBytes = trimBufferedTail(stderr, stderrBytes, 2 * 1024 * 1024);
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (overallTimer) clearTimeout(overallTimer);
  if (initialProgressTimer) clearTimeout(initialProgressTimer);
  if (progressPollTimer) clearInterval(progressPollTimer);
  if (completionTimer) clearTimeout(completionTimer);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  progressBuffer += progressDecoder.end();
  if (onStdout && progressBuffer.trim()) onStdout(progressBuffer);
  if (inactivityError) throw inactivityError;
  if (acceptedAfterProgress) {
    return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  }
  if (result.code !== 0) {
    const diagnostic = commandFailureDiagnostic(executable, Buffer.concat(stdout).toString("utf8"), Buffer.concat(stderr).toString("utf8"));
    throw new Error(`${executable} exited ${result.code ?? `by ${result.signal ?? "signal"}`}: ${diagnostic}`);
  }
  return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

function trimBufferedTail(chunks, total, maximum) {
  while (total > maximum && chunks.length > 1) total -= chunks.shift().length;
  if (total > maximum && chunks.length === 1) {
    chunks[0] = chunks[0].subarray(total - maximum);
    return maximum;
  }
  return total;
}

function commandFailureDiagnostic(executable, stdout, stderr) {
  const diagnostic = [...stderr.split(/\r?\n/), ...stdout.split(/\r?\n/)]
    .reverse()
    .map(agentDiagnosticText)
    .find(Boolean);
  return diagnostic ? sanitizeError(diagnostic) : `${executable} CLI exited without a diagnostic`;
}

function agentDiagnosticText(line) {
  const value = line.trim();
  if (!value) return null;
  try {
    const event = JSON.parse(value);
    const candidates = [event.error, event.result, event.message, event.reason, event.subtype]
      .filter(candidate => typeof candidate === "string");
    return candidates.find(candidate => /api error|error|timed? out|timeout|rate.?limit|overload|unavailable|connection|maximum[ _-]?turns|max[ _-]?turns|background tasks/i.test(candidate)) ?? null;
  } catch {
    if (value.length <= 1_000 && !value.startsWith("{")) return value;
    return null;
  }
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function emitProgress(kind, content) {
  const sanitized = String(content).replaceAll(/\u0000/g, "").slice(0, 4000);
  const normalized = kind === "AGENT_OUTPUT" ? sanitized : sanitized.trim();
  if (normalized.length === 0) return;
  progressWrites = progressWrites.then(() => appendFile(
    "/run/deviludo/progress.ndjson",
    `${JSON.stringify({ kind, content: normalized })}\n`,
    { mode: 0o600 },
  ));
}

function emitAgentOutput(line) {
  const event = agentEventText(line);
  if (!event) return;
  if (event.partial) {
    sawPartialAgentOutput = true;
    agentOutputBuffer += event.text;
    if (agentOutputBuffer.length >= 160 || agentOutputBuffer.includes("\n")) flushAgentOutput();
    return;
  }
  flushAgentOutput();
  emitProgress("AGENT_OUTPUT", event.text.endsWith("\n") ? event.text : `${event.text}\n`);
}

function flushAgentOutput() {
  const content = agentOutputBuffer;
  agentOutputBuffer = "";
  if (content.length > 0) emitProgress("AGENT_OUTPUT", content);
}

function agentEventText(line) {
  const value = line.trim();
  if (!value) return null;
  let event;
  try {
    event = JSON.parse(value);
  } catch {
    return { text: value, partial: false };
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  if (typeof event.event?.delta?.text === "string") return { text: event.event.delta.text, partial: true };
  if (typeof event.delta?.text === "string") return { text: event.delta.text, partial: true };
  if (typeof event.item?.text === "string" && event.item.type === "agent_message") return { text: event.item.text, partial: false };
  if (typeof event.item?.command === "string" && event.item.type === "command_execution") {
    return { text: `执行：${event.item.command}`, partial: false };
  }
  if (Array.isArray(event.message?.content)) {
    if (sawPartialAgentOutput && event.type === "assistant") return null;
    const text = event.message.content
      .filter(item => item && typeof item === "object" && typeof item.text === "string")
      .map(item => item.text)
      .join("\n");
    return text ? { text, partial: false } : null;
  }
  if (typeof event.message === "string") return { text: event.message, partial: false };
  if (typeof event.text === "string") return { text: event.text, partial: false };
  if (typeof event.result === "string") return { text: event.result, partial: false };
  return null;
}

function sanitizeError(message) {
  return message
    .replace(/\b(sk|key|token)-[A-Za-z0-9._-]{8,}\b/gi, "$1-[REDACTED]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[REDACTED]")
    .slice(0, 2000);
}
