#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  const e2eReportObject = plan.job.inputObjects.find(input => input.kind === "E2E_REPORT");
  let e2eRepairContext = null;
  if (e2eReportObject) {
    if (e2eReportObject.sizeBytes > 131_072) throw new Error("E2E failure report exceeds the Agent repair input limit");
    const filename = e2eReportObject.key.split("/").pop();
    if (!filename || !filename.endsWith(".json")) throw new Error("E2E failure report input is invalid");
    try {
      e2eRepairContext = JSON.parse(await readFile(`/workspace/inputs/${filename}`, "utf8"));
    } catch {
      throw new Error("E2E failure report input is unreadable");
    }
    if (e2eRepairContext?.schemaVersion !== "deviludo.godot-guest-report.v1"
      || e2eRepairContext.outcome !== "FAILED" || e2eRepairContext.failureDomain !== "PRODUCT") {
      throw new Error("E2E failure report is not a trusted product failure");
    }
    emitProgress("PHASE", `Agent 正在修复 ${plan.job.payload.failedPlatform ?? "目标平台"} E2E 发现的游戏问题`);
  }
  const prompt = [
    importedSource || restoredCheckpoint
      ? "Continue developing the existing Godot 4 project in /workspace/project. Inspect and preserve its working structure before changing it."
      : "Create a complete Godot 4 project in /workspace/project.",
    "Do not access paths outside /workspace/project except to read /run/deviludo/guidance.ndjson. Include project.godot, main scene, source, tests, Linux/Windows/macOS export presets, and LICENSES.json.",
    "Enable rendering/textures/vram_compression/import_s3tc_bptc so release exports are portable.",
    "The result must run headlessly and expose a deterministic smoke-test path.",
    "Godot and Python may be absent from this Agent container. Do not search for or install them, and do not treat their absence as a failure. The next controlled builder stage performs real Godot validation; use Node-based static checks here when useful.",
    "Prioritize a complete playable vertical slice, required files, and deterministic tests before optional polish.",
    "Implement the current revision notes and missing behavior without re-auditing unrelated code that is already complete.",
    "Do not spawn subagents, background agents, background tasks, or delegated code reviews. Work directly with the available file and shell tools.",
    "Run at most one bounded static validation pass. The controlled Builder and E2E stages perform the exhaustive runtime validation, so finish once the requested source and manifests are complete.",
    ...(restoredCheckpoint ? [
      "A source checkpoint from an interrupted attempt is already restored. Continue only the interrupted implementation; do not start a general project audit, add unrelated improvements, invent new validators, or rewrite documentation outside the current requirement.",
      "Treat completed checkpoint files as authoritative. Inspect only the files needed to finish the interrupted requirement, run one existing bounded static check, update the required manifests, and finish immediately.",
    ] : []),
    "During development, repeatedly check /run/deviludo/guidance.ndjson. It is an append-only stream of live player guidance. Incorporate every new entry before the next major change and never overwrite it.",
    "Briefly report what you are inspecting, changing, and validating while you work; these updates are shown live to the player.",
    "",
    "IMPORTANT: The generated agent.json must include a complete testManifest AND an assetManifest.",
    "",
    "testManifest structure:",
    "- schemaVersion: \"deviludo.test-manifest.v1\"",
    "- features: array of feature objects, each with:",
    "  - id: unique kebab-case identifier (e.g. \"collect-ember\")",
    "  - category: one of core-loop, player-control, data-integrity, runtime-quality, ui, audio",
    "  - description: human-readable feature description",
    "  - verificationMethod: \"unit\" for automated GDScript tests (required for all core game logic)",
    "  - gdsTestPath: path to test script (typically \"res://tests/e2e.gd\")",
    "  - checkNames: array of assertion names that verify this feature",
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
    "Every feature declared in the project document (gameplay mechanics, save/load, pause, win conditions, damage system, etc.) must have corresponding test checks.",
    ...(e2eRepairContext ? [
      "",
      "This is an automatic repair pass after a trusted E2E product failure. Reproduce the reported game behavior from the existing source, fix the game content, scripts, scenes, or project configuration, and preserve unrelated working behavior.",
      "Do not dismiss the report as infrastructure failure and do not merely rewrite the report. Make concrete source changes that address its diagnostics.",
      ...(e2eRepairContext.testDetails?.failures?.length > 0 ? [
        `Failed feature checks: ${e2eRepairContext.testDetails.failures.join(", ")}`,
        "Review the test script to understand what each failed check validates, then fix the game logic or configuration that caused the failure. Do not modify test assertions unless they are objectively incorrect.",
      ] : []),
      `E2E failure report: ${JSON.stringify(e2eRepairContext)}`,
    ] : []),
    `Specification: ${JSON.stringify(specification)}`,
  ].join("\n");
  const completedCheckpoint = checkpointMetadata?.state === "AGENT_COMPLETE"
    && checkpointMetadata.originJobId === plan.job.jobId;
  if (completedCheckpoint) {
    emitProgress("PHASE", "已恢复本任务完成的 Agent 检查点，跳过重复模型调用");
  } else {
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
    );
    flushAgentOutput();
  }
  // The CLI stdout is an event stream (Codex JSONL or Claude stream-json), not
  // the agent.json contract. Upload the file the Agent wrote into the generated
  // source so Core can ingest its test and asset manifests from the trusted,
  // digest-checked output object.
  const agentManifest = await readGeneratedAgentManifest();
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

async function readGeneratedAgentManifest() {
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
  if (!testManifest || typeof testManifest !== "object" || Array.isArray(testManifest)
    || testManifest.schemaVersion !== "deviludo.test-manifest.v1"
    || !Array.isArray(testManifest.features)
    || testManifest.features.length < 1 || testManifest.features.length > 500) {
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

async function runGenerationAgent(configuration, environment, prompt, onOutput, apiKey, jobId, timeoutSeconds) {
  if (configuration.runtime === "CLAUDE_CODE") environment.ANTHROPIC_AUTH_TOKEN = apiKey;
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
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const resumedClaude = configuration.runtime === "CLAUDE_CODE" && attempt > 1;
    const continuation = attempt === 1 ? prompt : resumedClaude
      ? "Resume from the current session and files. Finish only the remaining requested implementation and one bounded validation pass. Do not restart analysis or spawn background agents."
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
      return await command(
        executable,
        arguments_,
        environment,
        configuration.runtime === "CODEX_CLI" ? continuation : undefined,
        onOutput,
        { idleTimeoutMs: 8 * 60_000, overallTimeoutMs: remaining },
      );
    } catch (error) {
      flushAgentOutput();
      lastError = error instanceof Error ? error : new Error("Agent CLI failed");
      const failure = classifyAgentFailure(lastError.message);
      if (attempt === 2 || !failure.recoverable) {
        throw new Error(`Agent CLI failed [${failure.code}]: ${failure.detail}`);
      }
      const delaySeconds = 5;
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
  if (/api error|rate.?limit|overload|temporar|unavailable|connection|econn|socket|fetch failed/i.test(detail)) {
    return { code: "PROVIDER_ERROR", detail, recoverable: true };
  }
  if (/cli exited without a diagnostic/i.test(detail)) return { code: "CLI_ERROR", detail, recoverable: true };
  return { code: "CLI_ERROR", detail, recoverable: false };
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
  const platforms = await prepareGodotProject("/workspace/project", plan.job.payload.targetPlatforms);
  await mkdir("/workspace/.local/share/godot", { recursive: true });
  await symlink("/home/task/.local/share/godot/export_templates", "/workspace/.local/share/godot/export_templates");
  emitProgress("PHASE", "正在导入 Godot 资源并验证主场景");
  await command("godot", ["--headless", "--path", "/workspace/project", "--import"], godotEnvironment());
  await command("godot", ["--headless", "--path", "/workspace/project", "--quit-after", "120"], godotEnvironment());
  const outputs = [];
  for (const platform of platforms) {
    const target = godotExportTarget(platform);
    const exportDirectory = `/workspace/project/.deviludo-export/${platform}`;
    await mkdir(exportDirectory, { recursive: true });
    emitProgress("PHASE", `正在导出 ${target.name} 制品`);
    await command("godot", ["--headless", "--path", "/workspace/project", "--export-release", target.name, `${exportDirectory}/${target.filename}`], godotEnvironment());
    const archive = `godot-build-${platform}.tar.gz`;
    await command("tar", ["-czf", `/workspace/outputs/${archive}`, "-C", exportDirectory, "."], safeEnvironment());
    outputs.push({ file: archive, kind: "BUILD", targetPlatform: platform, contentType: "application/gzip" });
  }
  emitProgress("PHASE", "Godot 制品导出完成，正在生成制品清单");
  await manifest(outputs);
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
  if (!steam.username || !steam.loginToken || !/^\d+$/.test(steam.appId)
    || ["linux", "windows", "macos"].some(platform => !/^\d+$/.test(steam.depots?.[platform]))) {
    throw new Error("Steam publisher configuration is invalid");
  }
  const platforms = plan.job.payload.targetPlatforms;
  if (!Array.isArray(platforms) || platforms.length < 1
    || platforms.some(platform => !["linux", "windows", "macos"].includes(platform))) {
    throw new Error("Steam targetPlatforms are required");
  }
  const depotFiles = [];
  const inputFiles = await readdir("/workspace/inputs");
  for (const platform of [...new Set(platforms)]) {
    const filename = inputFiles.find(file => file.startsWith(`signed-build-${platform}-`) && file.endsWith(".tar.gz"));
    if (!filename) throw new Error(`Signed ${platform} build input is missing`);
    const archive = `/workspace/inputs/${filename}`;
    const content = `/workspace/project/content/${platform}`;
    await mkdir(content, { recursive: true });
    await command("tar", ["-xzf", archive, "-C", content], safeEnvironment());
    const depotFile = `/tmp/depot-${platform}.vdf`;
    await writeFile(depotFile, `"DepotBuildConfig"\n{\n  "DepotID" "${steam.depots[platform]}"\n  "ContentRoot" "${content}"\n  "FileMapping" { "LocalPath" "*" "DepotPath" "." "recursive" "1" }\n}\n`, { mode: 0o600 });
    depotFiles.push([steam.depots[platform], depotFile]);
  }
  const appBuild = "/tmp/app-build.vdf";
  await writeFile(appBuild, `"AppBuild"\n{\n  "AppID" "${steam.appId}"\n  "Desc" "Deviludo ${operation.id}"\n  "ContentRoot" "/workspace/project/content"\n  "BuildOutput" "/tmp/steam-output"\n  "Depots"\n  {\n${depotFiles.map(([id, file]) => `    "${id}" "${file}"`).join("\n")}\n  }\n}\n`, { mode: 0o600 });
  const uploadScript = "/tmp/steam-upload.vdf";
  await writeFile(uploadScript, `@ShutdownOnFailedCommand 1\n@NoPromptForPassword 1\nlogin ${steam.username} ${steam.loginToken}\nrun_app_build ${appBuild}\nquit\n`, { mode: 0o600 });
  const published = await command("steamcmd", ["+runscript", uploadScript], safeEnvironment());
  const buildId = published.stdout.match(/\bBuildID\s+(\d+)\b/i)?.[1];
  if (!buildId) throw new Error("Steam did not return a published BuildID");
  await writeFile("/workspace/outputs/steam-publish.json", JSON.stringify({
    published: true,
    operationId: operation.id,
    appId: steam.appId,
    buildId,
    depots: steam.depots,
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
  const child = spawn(executable, arguments_, { cwd: "/workspace/project", env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
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
  let forceKillTimer = null;
  const terminate = error => {
    if (inactivityError) return;
    inactivityError = error;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
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
  if (forceKillTimer) clearTimeout(forceKillTimer);
  progressBuffer += progressDecoder.end();
  if (onStdout && progressBuffer.trim()) onStdout(progressBuffer);
  if (inactivityError) throw inactivityError;
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
