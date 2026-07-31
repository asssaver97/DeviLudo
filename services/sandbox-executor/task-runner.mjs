#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { godotExportTarget, prepareGodotProject } from "./godot-build.mjs";

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
  const apiKey = (await readFile("/run/deviludo/provider.key", "utf8")).trim();
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
    importedSource
      ? "Continue developing the existing Godot 4 project in /workspace/project. Inspect and preserve its working structure before changing it."
      : "Create a complete Godot 4 project in /workspace/project.",
    "Do not access paths outside /workspace/project except to read /run/deviludo/guidance.ndjson. Include project.godot, main scene, source, tests, Linux/Windows/macOS export presets, and LICENSES.json.",
    "Enable rendering/textures/vram_compression/import_s3tc_bptc so release exports are portable.",
    "The result must run headlessly and expose a deterministic smoke-test path.",
    "Godot and Python may be absent from this Agent container. Do not search for or install them, and do not treat their absence as a failure. The next controlled builder stage performs real Godot validation; use Node-based static checks here when useful.",
    "Prioritize a complete playable vertical slice, required files, and deterministic tests before optional polish.",
    "During development, repeatedly check /run/deviludo/guidance.ndjson. It is an append-only stream of live player guidance. Incorporate every new entry before the next major change and never overwrite it.",
    "Briefly report what you are inspecting, changing, and validating while you work; these updates are shown live to the player.",
    ...(e2eRepairContext ? [
      "This is an automatic repair pass after a trusted E2E product failure. Reproduce the reported game behavior from the existing source, fix the game content, scripts, scenes, or project configuration, and preserve unrelated working behavior.",
      "Do not dismiss the report as infrastructure failure and do not merely rewrite the report. Make concrete source changes that address its diagnostics.",
      `E2E failure report: ${JSON.stringify(e2eRepairContext)}`,
    ] : []),
    `Specification: ${JSON.stringify(specification)}`,
  ].join("\n");
  const environment = { ...safeEnvironment(), ...configuration.environment };
  let executable;
  let arguments_;
  if (configuration.runtime === "CLAUDE_CODE") {
    environment.ANTHROPIC_AUTH_TOKEN = apiKey;
    executable = "claude";
    arguments_ = [
      "-p", "--no-session-persistence", "--disable-slash-commands",
      "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--max-turns", "60",
      "--allowedTools", "Read,Write,Edit,Glob,Grep,Bash",
      "--dangerously-skip-permissions", prompt,
    ];
  } else {
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
    executable = "codex";
    arguments_ = ["exec", "--ephemeral", "--json", "--skip-git-repo-check", "-C", "/workspace/project", "-"];
  }
  emitProgress("PHASE", "Agent 正在编写并验证游戏项目");
  const result = await command(
    executable,
    arguments_,
    environment,
    configuration.runtime === "CODEX_CLI" ? prompt : undefined,
    emitAgentOutput,
  );
  flushAgentOutput();
  await writeFile("/workspace/outputs/agent.json", result.stdout, "utf8");
  emitProgress("PHASE", "Agent 已完成代码修改，正在发布源码 revision");
  await manifest([
    { file: "agent.json", kind: "SPECIFICATION", contentType: "application/json" },
  ]);
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
      "--allowedTools", "Read,Write,Edit,Glob,Grep",
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
  const input = "/workspace/inputs/source.tar.gz";
  emitProgress("PHASE", "正在展开并校验 Agent 生成的 Godot 项目");
  await command("tar", ["-xzf", input, "-C", "/workspace/project"], safeEnvironment());
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

async function command(executable, arguments_, env, stdin, onStdout) {
  const child = spawn(executable, arguments_, { cwd: "/workspace/project", env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  if (stdin) child.stdin.end(stdin); else child.stdin.end();
  const stdout = [];
  const stderr = [];
  const progressDecoder = new StringDecoder("utf8");
  let progressBuffer = "";
  child.stdout.on("data", chunk => {
    const data = Buffer.from(chunk);
    stdout.push(data);
    if (!onStdout) return;
    progressBuffer += progressDecoder.write(data);
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop() ?? "";
    for (const line of lines) onStdout(line);
  });
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  progressBuffer += progressDecoder.end();
  if (onStdout && progressBuffer.trim()) onStdout(progressBuffer);
  if (result.code !== 0) throw new Error(`${executable} exited ${result.code ?? `by ${result.signal ?? "signal"}`}: ${Buffer.concat(stderr).toString("utf8").slice(0, 4000)}`);
  return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
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
