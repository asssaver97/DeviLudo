#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, copyFile, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { assertBuildAssetsReferenced } from "./build-asset-usage.mjs";

let progressWrites = Promise.resolve();
let agentOutputBuffer = "";
let sawPartialAgentOutput = false;
// The task entrypoint awaits runAgent before module evaluation reaches later
// declarations. Keep inventory constants initialized above that first await so
// Agent completion cannot read these bindings before initialization.
const SOURCE_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|svg)$/i;
const SOURCE_IMAGE_IGNORED_DIRECTORIES = new Set([
  ".git", ".godot", ".deviludo-export", ".deviludo-e2e",
  "node_modules", "build", "dist", "coverage",
]);

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
  const baselineSourceAvailable = await exists("/workspace/inputs/baseline-source.tar.gz");
  if (baselineSourceAvailable) {
    await mkdir("/workspace/baseline", { recursive: true });
    await command("tar", ["-xzf", "/workspace/inputs/baseline-source.tar.gz", "-C", "/workspace/baseline"], safeEnvironment());
  }
  const restoredCheckpoint = await exists("/workspace/inputs/checkpoint.tar.gz");
  const checkpointMetadata = restoredCheckpoint
    ? await readCheckpointMetadata()
    : null;
  if (restoredCheckpoint) {
    await command("tar", ["-xzf", "/workspace/inputs/checkpoint.tar.gz", "-C", "/workspace/project"], safeEnvironment());
    emitProgress("PHASE", "上次尝试的源码检查点已恢复，Agent 将从现有成果继续");
  }
  const startingAgentManifestIssue = importedSource || restoredCheckpoint
    ? await currentAgentManifestValidationError()
    : null;
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
  const upstreamFailureKind = plan.job.payload.repairFailureKind === "ARTIFACT_BUILD"
    ? "ARTIFACT_BUILD"
    : null;
  const upstreamFailureSummary = upstreamFailureKind
    && typeof plan.job.payload.repairFailureSummary === "string"
    && plan.job.payload.repairFailureSummary.length > 0
    && plan.job.payload.repairFailureSummary.length <= 1_800
    ? plan.job.payload.repairFailureSummary
    : null;
  if (upstreamFailureSummary && !e2eRepairContext) {
    emitProgress("PHASE", "Agent 正在修复制品构建发现的源码问题");
  }
  const isRepairPass = e2eRepairContext !== null || upstreamFailureSummary !== null;
  const checkpointEmitterInstruction = "A DEVILUDO_E2E_CHECKPOINT:<checkpoint-id> runtime marker is optional synchronization metadata only and can never satisfy an assertion by itself. If used, emit it only after the real semantic state exists and append it to DEVILUDO_E2E_CHECKPOINT_FILE when that environment variable is non-empty.";
  const probeInstruction = "Implement the read-only deviludo.e2e-ui-probe contract in the actual game. Atomically replace DEVILUDO_E2E_UI_PROBE_FILE after each visible/state/progress change. Include asynchronous UI lifecycle changes: a window, popup, dialog, overlay, animation, or deferred layout must publish again from its real visibility/layout signal or a completed draw frame, not only from the synchronous input handler that requested the change. Show and hide must both advance the sequence, and the snapshot must read the actual rendered state. Every state object must publish the fixed lifecycle fields screen_mode (MENU, PLAYING, PAUSED or RESULT), session_active, gameplay_input_enabled and blocking_layer_count. MENU means no session, no gameplay input, zero blocking layers; PLAYING means an active session, enabled gameplay input and zero blocking layers; PAUSED means an active session and disabled gameplay input, with blocking_layer_count reflecting the actual visible blocking layers rather than assuming one exists. Every control must declare scope NAVIGATION, GAMEPLAY, OVERLAY or STATUS. MENU must never publish an enabled visible GAMEPLAY control. Map every control and embedded Window/Popup rectangle against the root game client viewport before converting to 1280x720; never use a child window's own content size as the root scale, clamp an invalid rectangle, or publish an out-of-client snapshot. A node detached from the scene tree or without a live root viewport must never be published as visible or enabled: wait until it is attached and laid out, or publish the truthful non-actionable state using the last valid in-client rectangle. Never invent a fallback viewport size to make a detached node appear actionable. If real dialog content exceeds the root client, fix the production UI with a bounded window and scrollable content; never shrink, clip, or substitute only the Probe rectangle. Every control reported visible and enabled for an action must be connected to its production input handler. After real OS input, successful, rejected, and asynchronously completed actions must all converge on a final UI refresh and publish a newer Probe with the truthful outcome, so an action can never silently leave the previous sequence in place. Every snapshot uses schema deviludo.e2e-ui-probe and must contain the current DEVILUDO_E2E_SESSION_NONCE, OS process id, a strictly increasing sequence, sceneId, flat state and progress objects, and unique stable controls with id, scope, visible, enabled, text/value, and 1280x720 client-relative rect. Also publish assetBindings by inspecting each live production TextureRect, TextureButton, Sprite2D, NinePatchRect, or texture-backed StyleBox on its actual control. Each binding contains assetKey, targetId, the exact res:// resourcePath currently bound, truthful visible, and the rendered texture rectangle inside that control; sha256 is required for generated assets listed in res://assets/generated/manifest.json and may be omitted only for source images without a generated digest. Never copy bindings from agent.json, report a path that is only loaded in dead code, or publish a binding for an untextured/placeholder control. The probe may describe state but must never invoke actions, complete gameplay, or fake results.";
  const performanceInstruction = "Cross-platform E2E launches the real exported game with Godot --print-fps and measures native-input-to-truthful-Probe response latency under fixed runner-owned thresholds. Keep normal gameplay responsive: avoid blocking work, synchronous disk or network I/O, repeated scene/layout rebuilds, per-frame allocations, unbounded searches, and synchronous resource loading in input or frame callbacks. Treat renderer and device names reported by a virtualized runner as environment context, not as a standalone root cause. Do not switch rendering backends merely because the runner reports a software or virtual GPU; any renderer change must preserve application launch, window creation, and compatible fallbacks on every configured E2E target. Never suppress or forge FPS output, publish Probe state before the real rendered state exists, or add test-only shortcuts to evade performance evidence.";
  const manifestInstructions = [
    "The cross-platform E2E node owns test-plan generation. Do not create, update, or preserve testManifest in agent.json; remove that field if it exists.",
    "Implement the real game behavior, deterministic hooks, and read-only UI Probe needed for later native-input testing, but do not decide E2E journeys or assertions here.",
    probeInstruction,
    checkpointEmitterInstruction,
    performanceInstruction,
    "agent.json must contain exactly the current assetManifest planning object plus any non-test metadata required by the source; it must not contain testManifest.",
    "assetManifest uses schemaVersion deviludo.asset-manifest.v1 and 1-500 unique items. Each Agent-planned item needs assetKey, assetType, description, generationPrompt, nullable frameCount, nullable dimensions, and usageTargets.",
    "usageTargets is a non-empty list of {targetId, checkpointRole}. targetId is the stable production Probe control that must render this asset; checkpointRole is START, READY, ACTION, PROGRESS, or COMPLETION and declares when it must be visible. Each targetId/checkpointRole pair belongs to exactly one asset; give independently visible child controls distinct IDs. Add multiple targets when one asset is deliberately used by multiple controls or stages. Never map mutually exclusive or conditional variants as if they were simultaneously visible. Leave existing optional variants to the executor's discovered-source inventory instead of inventing a placement. Do not map an asset to a parent/root control unless that exact control renders it.",
    "Plan every image required by the complete player-facing gameplay and UI. The game must load controlled assets from res://assets/generated/<assetKey>.png, .jpg, or .webp and use a deliberate placeholder only when none exists.",
    "Every planned generated asset key must be referenced by executable runtime source and visibly connected to the actual scene or control that uses it. Remove a genuinely unnecessary plan item instead of leaving generated art on disk; the controlled Builder rejects materialized generated assets that only appear in agent.json, tests, tools, comments, or documentation and automatically returns the failure to this Agent for repair.",
    "Build a composed production UI, not an engineering dashboard: the current objective and next action must be clear, required art cannot be replaced by blank/dash slots or raw state dumps, textures must be cropped/aspected for their real controls, and secondary diagnostics must not dominate gameplay.",
    "Make layout and input resolution-independent across window sizes and display scales. Use containers/anchors and root-viewport coordinate conversion; do not tie hit testing or UI placement to one fixed pixel resolution.",
    "Make every Agent-planned asset visibly connected to the actual scene or control that uses it; the E2E node will verify texture placement, visibility, aspect, and gameplay/UI context.",
  ];
  const specificationInstructions = [
    `Specification: ${JSON.stringify(specification)}`,
    `Current revision notes: ${JSON.stringify(specification.revisionNotes ?? [])}`,
    ...(typeof plan.job.payload.implementationBrief === "string"
      ? [`Confirmed implementation change: ${plan.job.payload.implementationBrief}`]
      : []),
    ...(Array.isArray(plan.job.payload.e2eGoals)
      ? [`Complete E2E goal snapshot G${plan.job.payload.e2eGoalRevision}: ${JSON.stringify(plan.job.payload.e2eGoals)}`]
      : []),
  ];
  const e2eRepairInstructions = e2eRepairContext ? [
    "",
    "BLOCKING E2E REPAIR: fix the verified product failure before any broad audit, manifest review, refactor, or explanation.",
    "Open only the exact source/test file named by the evidence first, locate the reported symbol or behavior, and make the smallest concrete source edit immediately. Inspect wider code only when that edit genuinely requires it.",
    "This is an automatic repair pass after a trusted E2E product failure. Reproduce the reported game behavior from the existing source, fix the game content, scripts, scenes, or project configuration, and preserve unrelated working behavior.",
    "Do not dismiss the report as infrastructure failure and do not merely rewrite the report. Make concrete source changes that address its diagnostics.",
    "For ASSET_PLACEMENT_PLAN_MISSING, add truthful usageTargets to the planned asset. For ASSET_CONTROL_BINDING_MISSING, ASSET_CONTROL_BINDING_MISMATCH, ASSET_CONTROL_VISUALLY_BLANK, or ASSET_PLACEMENT_NOT_OBSERVED, fix the production control's real texture/style binding and its read-only Probe assetBindings evidence; never add a fake hidden control or Probe-only claim.",
    "When present, report.json interactionContracts contains the complete frozen native-input contract for each interactive feature. It is read-only evidence owned by the E2E node; never copy it into agent.json or modify the E2E plan.",
    "After fixing the named failure, when its interactionContract is present, perform one bounded consistency pass over that same failed feature: every remaining targetId and changeTargetId must resolve to exactly one truthful production Probe control when its step is reachable, and every remaining postcondition/checkpoint key must be published from the real resulting state after native input. Fix directly related omissions now so the same frozen journey does not fail one step at a time. Do not finish until this pass is complete. Do not audit other features, invent test-only controls/state, or execute future actions.",
    "If the report contains PACKAGE_WINDOW_TIMEOUT, treat an alive process that never creates an operable window as a product startup failure. Inspect the included startup logs first and fix the initialization loop, resource error storm, or blocking startup work; preserve a real player launch and window.",
    ...((e2eRepairContext.report ?? e2eRepairContext).performance?.passed === false ? [
      "PERFORMANCE REPAIR: use report.performance to identify the slow run and input step, then fix the real runtime hotspot in game scripts, scenes, resources, rendering, or project configuration. Profile the narrow path suggested by the evidence; preserve gameplay behavior and visual quality unless the approved design itself causes the hotspot.",
      "Do not change E2E thresholds, remove --print-fps, reduce measured coverage, pre-publish Probe results, or replace production work with E2E-only behavior. The next exported build will repeat the same independent measurement.",
    ] : []),
    ...((e2eRepairContext.report ?? e2eRepairContext).testDetails?.failures?.length > 0 ? [
      `Failed feature checks: ${(e2eRepairContext.report ?? e2eRepairContext).testDetails.failures.join(", ")}`,
      "Review the named failing test only as needed to understand the intended behavior. Fix game logic or configuration first; do not modify test assertions unless they are objectively incorrect.",
    ] : []),
    "The verified evidence files are available in /workspace/inputs/e2e-repair. Start from report.json and the named error; inspect logs or failed screenshots only when needed for the concrete fix.",
    `E2E failure summary: ${JSON.stringify(e2eRepairPromptSummary(e2eRepairContext))}`,
    "",
  ] : [];
  const upstreamRepairInstructions = upstreamFailureSummary && !e2eRepairContext ? [
    "",
    "BLOCKING BUILD REPAIR: fix the trusted controlled Builder failure before any broad audit, feature work, refactor, or explanation.",
    "Open the exact file and line named by the diagnostic first when one is present, make the smallest concrete source correction, and preserve unrelated working behavior.",
    "Do not dismiss, rewrite, or work around the diagnostic. The next controlled Builder will rerun the real Godot import and export checks.",
    ...(upstreamFailureSummary.includes("Generated assets were materialized but are not referenced by runtime source") ? [
      "ASSET USAGE REPAIR: for every asset key named by the Builder, either connect that generated texture visibly to its intended production scene/control and runtime code, or remove the genuinely unnecessary key from agent.json assetManifest. Do not add a comment, test-only string, hidden node, or dead preload merely to satisfy the reference check.",
      "Prefer completing the incomplete player-facing UI with the named art when its planned description matches a visible feature. If the item was a duplicate of an existing source image, keep the existing image reference and remove the duplicate generated plan item.",
    ] : []),
    `Builder failure summary: ${JSON.stringify(upstreamFailureSummary)}`,
    "",
  ] : [];
  const outputContractInstructions = startingAgentManifestIssue ? [
    "",
    "BLOCKING OUTPUT CONTRACT REPAIR: the current agent.json cannot be published under the active contract. Fix every item named by the diagnostic before finishing; this is required work, not an optional broad audit.",
    `Current manifest diagnostic: ${startingAgentManifestIssue}`,
    "",
  ] : [];
  const languageInstruction = promptLanguageInstruction(plan.job.payload.responseLanguage);
  const prompt = [
    importedSource || restoredCheckpoint
      ? "Continue developing the existing Godot 4 project in /workspace/project. Inspect and preserve its working structure before changing it."
      : "Create a complete Godot 4 project in /workspace/project.",
    ...e2eRepairInstructions,
    ...upstreamRepairInstructions,
    ...outputContractInstructions,
    "Do not access paths outside /workspace/project except the optional read-only /workspace/baseline and, on an E2E repair pass, /workspace/inputs/e2e-repair. Include project.godot, main scene, source, tests, Linux/Windows/macOS export presets, and LICENSES.json.",
    ...(baselineSourceAvailable ? [
      "A read-only snapshot of the workflow-start source is available at /workspace/baseline. The current /workspace/project remains authoritative for approved work. Use the baseline only to compare behavior and restore accidentally deleted or structurally damaged existing declarations; never copy it wholesale, revert unrelated approved changes, or edit files under /workspace/baseline.",
    ] : []),
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
    "Briefly report what you are inspecting, changing, and validating while you work; these updates are shown live to the player.",
    ...(languageInstruction ? [languageInstruction] : []),
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
      5 * 60_000,
      // Real E2E evidence includes screenshots, Probe snapshots, and the
      // failing interaction trace. Three minutes repeatedly terminated Claude
      // while it was still reading that bounded evidence, before the first
      // edit. Keep a hard no-change deadline, but allow one useful diagnosis
      // and edit pass instead of paying for several interrupted resumptions.
      isRepairPass ? 8 * 60_000 : undefined,
      async () => {
        await readGeneratedAgentManifest();
      },
    );
    flushAgentOutput();
  }
  // The CLI stdout is an event stream (Codex JSONL or Claude stream-json), not
  // the agent.json contract. Upload the file the Agent wrote into the generated
  // source so Core can ingest its test and asset manifests from the trusted,
  // digest-checked output object.
  const agentManifest = await mergeDiscoveredSourceImages(
    await readGeneratedAgentManifest(),
    "/workspace/project",
  );
  // Keep the deterministic inventory in both the published source and the
  // completion object. Core can then list existing art without asking the model
  // to notice binary files, and a later Agent pass starts from the same truth.
  await writeFile("/workspace/project/agent.json", `${JSON.stringify(agentManifest, null, 2)}\n`, "utf8");
  await writeFile("/workspace/outputs/agent.json", JSON.stringify(agentManifest), "utf8");
  emitProgress("PHASE", "Agent 已完成代码修改，正在发布源码 revision");
  await manifest([
    { file: "agent.json", kind: "SPECIFICATION", contentType: "application/json" },
  ]);
}

async function readCheckpointMetadata() {
  let value;
  try {
    value = JSON.parse(await readFile("/workspace/inputs/checkpoint.json", "utf8"));
  } catch {
    throw new Error("Agent checkpoint metadata is missing or invalid");
  }
  if (value?.schemaVersion !== "deviludo.source-checkpoint.v1"
    || !["PARTIAL", "AGENT_COMPLETE"].includes(value.state)
    || typeof value.originJobId !== "string") {
    throw new Error("Agent checkpoint metadata is missing or invalid");
  }
  return value;
}

async function readGeneratedAgentManifest() {
  let value;
  try {
    value = JSON.parse(await readFile("/workspace/project/agent.json", "utf8"));
  } catch {
    throw new Error("Agent did not produce a valid agent.json");
  }
  const issue = agentManifestValidationError(value);
  if (issue) throw new Error(`Agent did not produce a valid assetManifest: ${issue}`);
  return value;
}

async function currentAgentManifestValidationError() {
  try {
    return agentManifestValidationError(JSON.parse(await readFile("/workspace/project/agent.json", "utf8")));
  } catch {
    return "agent.json is missing or invalid JSON";
  }
}

function agentManifestValidationError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "agent.json must contain one JSON object";
  if (Object.hasOwn(value, "testManifest")) return "remove testManifest because the E2E node owns it";
  const assetManifest = value.assetManifest;
  if (!assetManifest || typeof assetManifest !== "object" || Array.isArray(assetManifest)) return "assetManifest must be an object";
  if (assetManifest.schemaVersion !== "deviludo.asset-manifest.v1") return "assetManifest.schemaVersion must be deviludo.asset-manifest.v1";
  if (!Array.isArray(assetManifest.items) || assetManifest.items.length < 1 || assetManifest.items.length > 500) {
    return "assetManifest.items must contain between 1 and 500 entries";
  }
  const invalid = assetManifest.items
    .map((item, index) => validPlannedAsset(item) ? null : String(item?.assetKey ?? `item ${index}`))
    .filter(Boolean);
  if (invalid.length > 0) return `fix invalid assetManifest items: ${invalid.join(", ")}`;
  const keys = assetManifest.items.map(item => item.assetKey);
  if (new Set(keys).size !== keys.length) return "assetManifest assetKey values must be unique";
  const owners = new Map();
  for (const item of assetManifest.items.filter(item => item.discoveredSourceImage !== true)) {
    for (const target of item.usageTargets) {
      const key = `${target.targetId}:${target.checkpointRole}`;
      owners.set(key, [...(owners.get(key) ?? []), item.assetKey]);
    }
  }
  const conflicts = [...owners].filter(([, assetKeys]) => assetKeys.length > 1);
  return conflicts.length === 0 ? null
    : `each control checkpoint must identify exactly one asset; fix ${conflicts.map(([key, assetKeys]) => `${key}=[${assetKeys.slice(0, 6).join(",")}${assetKeys.length > 6 ? `,+${assetKeys.length - 6}` : ""}]`).join("; ")}`;
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
    && (item.dimensions == null || (typeof item.dimensions === "string" && /^[0-9]{1,5}x[0-9]{1,5}$/.test(item.dimensions)))
    && (item.discoveredSourceImage === true
      ? (item.usageTargets === undefined || validAssetUsageTargets(item.usageTargets, true))
      : validAssetUsageTargets(item.usageTargets, false));
}

function validAssetUsageTargets(value, allowEmpty) {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > 32) return false;
  const keys = new Set();
  for (const target of value) {
    if (!target || typeof target !== "object" || Array.isArray(target)
      || Object.keys(target).some(key => !["targetId", "checkpointRole"].includes(key))
      || typeof target.targetId !== "string" || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(target.targetId)
      || !["START", "READY", "ACTION", "PROGRESS", "COMPLETION"].includes(target.checkpointRole)) return false;
    const key = `${target.targetId}:${target.checkpointRole}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

/**
 * Merge a deterministic source-tree image inventory into the Agent plan.
 *
 * The model plans what the game needs; the executor decides what files actually
 * exist. Matching a unique basename is intentionally a fallback only after exact
 * project-relative keys, so common names such as icon.png cannot accidentally
 * satisfy several unrelated planned assets.
 */
async function mergeDiscoveredSourceImages(agentManifest, root) {
  const planned = agentManifest.assetManifest.items
    .filter(item => item.discoveredSourceImage !== true)
    .map(item => {
      const plan = { ...item };
      delete plan.status;
      delete plan.sourcePath;
      return plan;
    });
  const sourcePaths = await discoverSourceImages(root);
  const sourceRecords = sourcePaths.map(sourcePath => ({
    sourcePath,
    strippedPath: sourcePath.replace(SOURCE_IMAGE_EXTENSIONS, ""),
  }));
  const basenameCounts = new Map();
  for (const record of sourceRecords) {
    const basename = record.strippedPath.split("/").at(-1);
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }
  const consumed = new Set();
  const merged = planned.map(item => {
    const candidates = sourceRecords.filter(record => {
      const aliases = sourceImageAliases(record.strippedPath);
      if (aliases.has(item.assetKey)) return true;
      const plannedBase = item.assetKey.split("/").at(-1);
      const sourceBase = record.strippedPath.split("/").at(-1);
      return plannedBase === sourceBase && basenameCounts.get(sourceBase) === 1;
    });
    if (candidates.length !== 1) return item;
    consumed.add(candidates[0].sourcePath);
    return { ...item, status: "existing", sourcePath: candidates[0].sourcePath };
  });
  for (const record of sourceRecords) {
    if (consumed.has(record.sourcePath) || merged.length >= 500) continue;
    const assetKey = sourceInventoryKey(record.strippedPath);
    if (merged.some(item => item.assetKey === assetKey)) continue;
    merged.push({
      assetKey,
      assetType: inferSourceAssetType(record.sourcePath),
      description: `Existing project image: ${record.sourcePath}`,
      generationPrompt: `Recreate the existing game image at ${record.sourcePath} while preserving its current visual role and style.`,
      frameCount: null,
      dimensions: null,
      usageTargets: [],
      status: "existing",
      sourcePath: record.sourcePath,
      discoveredSourceImage: true,
    });
  }
  return {
    ...agentManifest,
    assetManifest: { ...agentManifest.assetManifest, items: merged },
  };
}

async function discoverSourceImages(root) {
  const found = [];
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SOURCE_IMAGE_IGNORED_DIRECTORIES.has(entry.name)) await visit(resolve(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !SOURCE_IMAGE_EXTENSIONS.test(entry.name)) continue;
      const sourcePath = relative(root, resolve(directory, entry.name)).split(sep).join("/");
      if (sourcePath.length > 500 || sourcePath.startsWith("../")) continue;
      found.push(sourcePath);
    }
  };
  await visit(root);
  return found;
}

function sourceImageAliases(strippedPath) {
  const aliases = new Set([strippedPath]);
  for (const prefix of ["assets/generated/", "assets/", "art/", "images/", "data/sprites/", "data/generated_assets/"]) {
    if (strippedPath.startsWith(prefix)) aliases.add(strippedPath.slice(prefix.length));
  }
  return aliases;
}

function sourceInventoryKey(strippedPath) {
  if (strippedPath.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(strippedPath)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(strippedPath)
    && !strippedPath.endsWith("/")) return strippedPath;
  return `existing/${createHash("sha256").update(strippedPath).digest("hex").slice(0, 32)}`;
}

function inferSourceAssetType(sourcePath) {
  const path = sourcePath.toLowerCase();
  if (/(^|[\/_-])(tile|tileset)/.test(path)) return "tileset";
  if (/(^|[\/_-])(background|backdrop|bg)([\/_-]|\.)/.test(path)) return "background";
  if (/(^|[\/_-])(icon|favicon)([\/_-]|\.)/.test(path)) return "icon";
  if (/(^|[\/_-])(ui|hud|button|panel|menu)([\/_-]|\.)/.test(path)) return "ui";
  if (/(^|[\/_-])(animation|anim|sheet)([\/_-]|\.)/.test(path)) return "animation";
  return "sprite";
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
  const measuredPerformance = report.performance && typeof report.performance === "object"
    ? report.performance
    : null;
  const frameRate = measuredPerformance?.frameRate && typeof measuredPerformance.frameRate === "object"
    ? measuredPerformance.frameRate
    : null;
  const inputResponse = measuredPerformance?.inputResponse && typeof measuredPerformance.inputResponse === "object"
    ? measuredPerformance.inputResponse
    : null;
  const performance = measuredPerformance ? {
    schema: measuredPerformance.schema,
    passed: measuredPerformance.passed,
    thresholds: measuredPerformance.thresholds,
    failures: Array.isArray(measuredPerformance.failures) ? measuredPerformance.failures.slice(0, 10) : [],
    frameRate: frameRate ? {
      sampleCount: frameRate.sampleCount,
      minimumFps: frameRate.minimumFps,
      p10Fps: frameRate.p10Fps,
      medianFps: frameRate.medianFps,
      slowSampleCount: frameRate.slowSampleCount,
      slowSampleRatio: frameRate.slowSampleRatio,
      runs: Array.isArray(frameRate.runs) ? frameRate.runs.slice(0, 50).map(run => ({
        runId: run.runId,
        sampleCount: run.sampleCount,
        minimumFps: run.minimumFps,
        p10Fps: run.p10Fps,
        medianFps: run.medianFps,
      })) : [],
    } : null,
    inputResponse: inputResponse ? {
      sampleCount: inputResponse.sampleCount,
      p95Ms: inputResponse.p95Ms,
      maximumMs: inputResponse.maximumMs,
      slowest: Array.isArray(inputResponse.samples) ? [...inputResponse.samples]
        .sort((left, right) => Number(right?.latencyMs ?? 0) - Number(left?.latencyMs ?? 0))
        .slice(0, 20) : [],
    } : null,
  } : null;
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
    performance,
  };
}

function godotErrorLines(...logs) {
  const pattern = /(?:SCRIPT ERROR|Parse Error|Parser Error|Compile Error|Failed to load script|Cannot load script|runtime error|Invalid call\.|GDScript::reload)/i;
  return logs.flatMap(log => String(log ?? "").split(/\r?\n/)).map(line => line.trim()).filter(line => pattern.test(line)).slice(0, 20);
}

async function runGenerationAgent(configuration, environment, prompt, onOutput, apiKey, jobId, timeoutSeconds, verifyCompletion = null, initialProgressDeadlineMs = 5 * 60_000, completionQuiescenceMs = undefined, validateOutput = null) {
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
    await prepareCodexCredential(environment, configuration.baseUrl, apiKey);
  }

  const deadline = Date.now() + Math.max(60_000, Math.min(80 * 60_000, (timeoutSeconds - 600) * 1_000));
  let lastError;
  let resumeInstruction = "Resume from the current session and files. Finish only the remaining requested implementation and one bounded validation pass. Do not restart analysis or spawn background agents, background shell commands, or background tasks.";
  // A no-change completion is different from a Provider/CLI interruption: the
  // model has usually finished useful diagnosis and only needs another turn
  // in the same session to make and validate the concrete edit. Keep those
  // continuations inside this container so an outer database retry does not
  // destroy the Claude session and repeat the project scan from scratch. All
  // calls still share the single 80-minute deadline above.
  // Provider outages must not burn the database retry budget in under a
  // minute. Keep the resumable worktree alive for the Agent's existing
  // 80-minute budget and back off inside this task container. Non-provider
  // failures retain their small, purpose-specific retry limits below.
  const maxProviderAttempts = 16;
  for (let attempt = 1; attempt <= maxProviderAttempts; attempt += 1) {
    const resumedClaude = configuration.runtime === "CLAUDE_CODE" && attempt > 1;
    const continuation = attempt === 1 ? prompt : resumedClaude
      ? resumeInstruction
      : [
        resumeInstruction,
        "Continue from the files already present in /workspace/project after a transient Provider or CLI interruption.",
        "Inspect the existing work first, preserve completed functionality, and finish only the missing validation and required files. Do not restart the project from scratch.",
        prompt,
      ].join("\n");
    const executable = configuration.runtime === "CLAUDE_CODE" ? "claude" : "codex";
    const arguments_ = configuration.runtime === "CLAUDE_CODE"
      ? claudeGenerationArguments(configuration, continuation, jobId, resumedClaude)
      : codexArguments(configuration.environment.DEVILUDO_CODEX_MODEL ?? configuration.model, configuration.baseUrl);
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
      if (validateOutput) {
        try {
          await validateOutput();
        } catch (error) {
          throw Object.assign(error instanceof Error ? error : new Error("Agent output contract validation failed"), {
            code: "OUTPUT_CONTRACT",
          });
        }
      }
      return result;
    } catch (error) {
      flushAgentOutput();
      lastError = error instanceof Error ? error : new Error("Agent CLI failed");
      const failure = classifyAgentFailure(lastError);
      const maxAttemptsForFailure = failure.code === "INCOMPLETE_OUTPUT"
        ? 4
        : failure.code === "OUTPUT_CONTRACT" ? 3
        : failure.code === "PROVIDER_ERROR" ? maxProviderAttempts : 2;
      if (attempt >= maxAttemptsForFailure || !failure.recoverable) {
        throw new Error(`Agent generation failed [${failure.code}]: ${failure.detail}`);
      }
      if (failure.code === "INCOMPLETE_OUTPUT") {
        resumeInstruction = "Resume from the current session and files now. Your previous response stopped before changing any source files. Make the smallest concrete source change required by the frozen implementation brief or reported E2E failure. For normal development, update only the directly affected automated tests and manifest mapping; for an E2E repair, preserve valid tests and manifests unless the report proves they are wrong. Run one bounded validation pass, then finish. Do not repeat the project audit or merely describe the next step.";
      } else if (failure.code === "OUTPUT_CONTRACT") {
        resumeInstruction = `Your previous result failed the executor output contract: ${failure.detail}. Fix every named agent.json entry, preserve completed game changes, run one bounded validation, and finish.`;
      }
      const delaySeconds = agentRetryDelaySeconds(failure, attempt);
      if (Date.now() + delaySeconds * 1_000 >= deadline) {
        throw new Error(`Agent generation failed [DEADLINE_EXCEEDED]: Provider did not recover before the shared 80-minute deadline; last failure: ${failure.detail}`);
      }
      const nextAttempt = attempt + 1;
      emitProgress("PHASE", `Agent CLI 暂时中断 [${failure.code}]：${failure.detail}；${delaySeconds} 秒后恢复同一会话（${nextAttempt}/${maxAttemptsForFailure}）`);
      if (delaySeconds > 0) await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
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

function classifyAgentFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const detail = sanitizeError(message.replace(/^claude exited [^:]+:\s*/i, "").replace(/^codex exited [^:]+:\s*/i, ""));
  if (error?.code === "OUTPUT_CONTRACT") return { code: "OUTPUT_CONTRACT", detail, recoverable: true };
  // Codex refreshes its account model catalogue independently from the
  // Responses request. A CDN/proxy can reject that refresh while the official
  // login and inference route remain valid; treating this diagnostic as a
  // permanent credential failure aborts otherwise recoverable work.
  if (/(?:codex_models_manager|failed to refresh available models)[\s\S]*\b403\b/i.test(detail)) {
    return { code: "PROVIDER_ERROR", detail, recoverable: true };
  }
  // ChatGPT account authentication errors are concise API diagnostics. A
  // reverse proxy/CDN block instead arrives as an HTML 403 (often with a
  // Cloudflare Ray ID). That is an infrastructure routing failure, not an
  // invalid user credential, and should recover in place without consuming a
  // fresh database job attempt.
  if (/\b403\b/i.test(detail)
    && /(?:<html|<!doctype html|cloudflare|cf-ray|sorry, you have been blocked)/i.test(detail)) {
    return { code: "PROVIDER_ERROR", detail, recoverable: true };
  }
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

function agentRetryDelaySeconds(failure, attempt = 1) {
  if (failure.code !== "PROVIDER_ERROR") return 5;
  // Provider memory pressure typically survives an immediate retry. Preserve
  // the resumable session and give the gateway enough time to shed work instead
  // of consuming the second model call against the same overload window.
  if (/memory overloaded|memory pressure|capacity|overload/i.test(failure.detail)) {
    return Math.min(120, 30 * Math.max(1, attempt));
  }
  // HTML 403s from the edge are unlikely to clear in a few seconds. Other
  // transport failures start faster, then converge on the same five-minute
  // ceiling. The shared Agent deadline remains the hard upper bound.
  const base = /(?:<html|<!doctype html|cloudflare|cf-ray|sorry, you have been blocked)/i.test(failure.detail)
    ? 30
    : 15;
  return Math.min(300, base * (2 ** Math.min(4, Math.max(0, attempt - 1))));
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
  const languageInstruction = promptLanguageInstruction(payload.responseLanguage);
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
    ...(languageInstruction ? [languageInstruction] : []),
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

function promptLanguageInstruction(value) {
  return value === "zh"
    ? "请用中文回答。Keep code, file paths, schema names, JSON property names, and enum values unchanged."
    : null;
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
  await prepareCodexCredential(environment, configuration.baseUrl, apiKey);
  return command("codex", codexArguments(
    configuration.environment.DEVILUDO_CODEX_MODEL ?? configuration.model,
    configuration.baseUrl,
  ), environment, prompt);
}

async function prepareCodexCredential(environment, baseUrl, credential) {
  environment.CODEX_HOME = "/workspace/codex-home";
  await mkdir(environment.CODEX_HOME, { recursive: true });
  if (usesCodexOfficialLogin(baseUrl)) {
    validateCodexAuth(credential);
    await writeFile(`${environment.CODEX_HOME}/auth.json`, credential, { mode: 0o600 });
  } else {
    environment.DEVILUDO_CODEX_PROVIDER_API_KEY = credential;
  }
}

function codexArguments(model, baseUrl) {
  // The task container is already the security boundary: it has a read-only
  // root filesystem, a bounded writable project mount, dropped capabilities,
  // no host credentials, and allowlisted Provider egress. Running Codex's
  // nested Linux sandbox inside that container depends on user namespaces and
  // bubblewrap features that hardened Docker/Kata tasks deliberately deny.
  const official = usesCodexOfficialLogin(baseUrl);
  const provider = official ? "deviludo_chatgpt" : "deviludo_custom";
  const arguments_ = [
    "exec",
    "--ephemeral",
    "--json",
    "--ignore-user-config",
    // Official ChatGPT login normally advertises WebSocket transport. Some
    // locked-down executor networks and authenticated forward proxies cannot
    // preserve that upgrade reliably. Register the same official backend as
    // an HTTP-only Responses provider so a transport failure cannot be
    // mistaken for an Agent or product failure.
    "--config", `model_provider=${provider}`,
    "--config", `model_providers.${provider}.name=${official ? "OpenAI" : "DeviLudo custom Provider"}`,
    "--config", `model_providers.${provider}.base_url=${official ? "https://chatgpt.com/backend-api/codex" : baseUrl}`,
    "--config", `model_providers.${provider}.wire_api=responses`,
    "--config", `model_providers.${provider}.requires_openai_auth=${official}`,
    "--config", `model_providers.${provider}.supports_websockets=false`,
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (!official) arguments_.push("--config", `model_providers.${provider}.env_key=DEVILUDO_CODEX_PROVIDER_API_KEY`);
  if (model !== "account-default") arguments_.push("-m", model);
  arguments_.push("-C", "/workspace/project", "-");
  return arguments_;
}

function usesCodexOfficialLogin(baseUrl) {
  const url = new URL(baseUrl);
  return url.protocol === "https:"
    && url.hostname === "chatgpt.com"
    && ["", "/", "/backend-api/codex"].includes(url.pathname.replace(/\/$/, ""));
}

function validateCodexAuth(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("Codex official login data is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex official login data is invalid");
  }
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
    const archive = `godot-build-${platform}.tar.gz`;
    await command("tar", ["-czf", `/workspace/outputs/${archive}`, "-C", exportDirectory, "."], safeEnvironment());
    outputs.push({ file: archive, kind: "BUILD", targetPlatform: platform, contentType: "application/gzip" });
  }
  emitProgress("PHASE", "Godot 制品导出完成，正在生成制品清单");
  await manifest(outputs);
}

async function godotCommand(arguments_) {
  let result;
  try {
    result = await command("godot", arguments_, godotEnvironment());
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Godot command failed";
    if (/SCRIPT ERROR|Parse Error|Failed to load script|Invalid call|Invalid assignment/i.test(reason)) {
      throw new Error(`BUILD_PRODUCT: Godot project validation failed: ${reason}`, { cause: error });
    }
    throw error;
  }
  const errors = godotErrorLines(result.stdout, result.stderr);
  if (errors.length > 0) {
    throw new Error(`BUILD_PRODUCT: Godot reported script errors despite exit code 0: ${errors.join(" | ")}`);
  }
  return result;
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
  await assertBuildAssetsReferenced("/workspace/project", assets.map(asset => asset.assetKey));
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
  const diagnosticLines = [...stderr.split(/\r?\n/), ...stdout.split(/\r?\n/)]
    .map(agentDiagnosticText)
    .filter(Boolean);
  const errorLineIndexes = diagnosticLines
    .map((line, index) => /\b(?:error|failed|failure|cannot|invalid|denied|timed? out|timeout|unavailable)\b/i.test(line) ? index : -1)
    .filter(index => index >= 0);
  let diagnostic = diagnosticLines.at(-1);
  if (errorLineIndexes.length > 0) {
    const lastErrorIndex = errorLineIndexes.at(-1);
    const previousErrorIndex = errorLineIndexes.at(-2);
    const startIndex = previousErrorIndex !== undefined && lastErrorIndex - previousErrorIndex <= 8
      ? previousErrorIndex
      : lastErrorIndex;
    diagnostic = diagnosticLines.slice(startIndex, lastErrorIndex + 1).join(" | ");
  }
  return diagnostic ? sanitizeError(diagnostic) : `${executable} CLI exited without a diagnostic`;
}

function agentDiagnosticText(line) {
  const value = stripTerminalControlSequences(line).trim();
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
  return stripTerminalControlSequences(message)
    .replace(/\b(sk|key|token)-[A-Za-z0-9._-]{8,}\b/gi, "$1-[REDACTED]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[REDACTED]")
    .slice(0, 2000);
}

function stripTerminalControlSequences(value) {
  return String(value)
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
