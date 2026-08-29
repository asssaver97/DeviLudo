#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { assertBuildAssetsReferenced } from "./build-asset-usage.mjs";

let progressWrites = Promise.resolve();

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
  if (plan.job.jobKind === "BUILD") await runGodotBuild(plan);
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
  const { godotErrorLines } = await import("/usr/local/lib/deviludo/e2e-evidence.mjs");
  let result;
  try {
    result = await command("godot", arguments_, godotEnvironment());
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Godot command failed";
    if (/SCRIPT ERROR|Parse Error|Failed to load script|Invalid call|Invalid assignment/i.test(reason)) {
      const diagnostic = arguments_.includes("--import") ? await directGodotScriptDiagnostic() : null;
      throw new Error(`BUILD_PRODUCT: Godot project validation failed: ${diagnostic ?? reason}`, { cause: error });
    }
    throw error;
  }
  const errors = godotErrorLines(result.stdout, result.stderr);
  if (errors.length > 0) {
    const diagnostic = arguments_.includes("--import") ? await directGodotScriptDiagnostic() : null;
    throw new Error(`BUILD_PRODUCT: Godot reported script errors despite exit code 0: ${diagnostic ?? errors.join(" | ")}`);
  }
  return result;
}

async function directGodotScriptDiagnostic() {
  const { godotProjectScripts } = await import("./godot-build.mjs");
  for (const script of await godotProjectScripts("/workspace/project")) {
    try {
      await command("godot", [
        "--headless", "--path", "/workspace/project",
        "--script", `res://${script}`, "--check-only",
      ], godotEnvironment());
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Godot script validation failed";
      if (/SCRIPT ERROR|Parse Error|Failed to load script|Invalid call|Invalid assignment/i.test(reason)) {
        return reason;
      }
    }
  }
  return null;
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
    const extension = asset.key.match(/\.(png|jpg|webp|mp3|ogg|wav)$/)?.[1];
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
  emitProgress("PHASE", `已同步 ${assets.length} 个素材到构建源码`);
}

function assetInputFilename(input) {
  const extension = input.key.match(/\.(png|jpg|webp|mp3|ogg|wav)$/)?.[1];
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
