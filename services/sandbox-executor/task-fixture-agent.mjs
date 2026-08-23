#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

await mkdir("/workspace/project", { recursive: true });
await mkdir("/workspace/outputs", { recursive: true });
await waitFor("/run/deviludo/ready", "Executor did not provide the fixture plan");
const plan = JSON.parse(await readFile("/run/deviludo/plan.json", "utf8"));
const chinese = plan.job?.payload?.responseLanguage === "zh";
await progress("PHASE", chinese ? "Fixture Agent 已启动并读取项目需求" : "Fixture Agent started and read the project requirements");
let taskError = null;
try {
  if (!["AGENT_GENERATION", "PROJECT_DOCUMENT_MAINTENANCE", "ARTIFACT_BUILD", "STEAM_PUBLISH"].includes(plan.job?.jobKind)) {
    throw new Error("Fixture task accepts only the fixed E2E contracts");
  }
  if (plan.job.jobKind === "STEAM_PUBLISH") {
    const operationId = plan.job.payload?.operation?.id;
    if (!/^[0-9a-f-]{36}$/i.test(operationId ?? "")) throw new Error("Fixture Steam operation is invalid");
    await progress("PHASE", chinese ? "Fixture Publisher 已登记固定的 Steam 发布回执" : "Fixture Publisher registered the fixed Steam publication receipt");
    await writeFile("/workspace/outputs/steam-publish.json", JSON.stringify({
      schemaVersion: "deviludo.fixture-steam-publish.v1",
      published: true,
      operationId,
      buildId: "1000001",
      remoteCalled: false,
    }));
    await writeFile("/workspace/outputs/manifest.json", JSON.stringify({
      schemaVersion: "deviludo.task-outputs.v1",
      outputs: [{ file: "steam-publish.json", kind: "PUBLISH_RECEIPT", contentType: "application/json" }],
    }));
  } else if (plan.job.jobKind === "ARTIFACT_BUILD") {
    const platforms = plan.job.payload?.targetPlatforms;
    if (!Array.isArray(platforms) || platforms.length < 1
      || platforms.some(platform => !["linux", "windows", "macos"].includes(platform))) {
      throw new Error("Fixture build platforms are invalid");
    }
    const outputs = [];
    for (const platform of [...new Set(platforms)]) {
      const directory = `/tmp/deviludo-fixture-build-${platform}`;
      const archive = `godot-build-${platform}.tar.gz`;
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/deviludo-fixture-game.txt`, `platform=${platform}\njob=${plan.job.jobId}\n`);
      const materialized = [];
      for (const asset of plan.job.inputObjects.filter(input => input.kind === "ASSET")) {
        const extension = asset.key.match(/\.(png|jpg|webp)$/)?.[1];
        if (!extension || typeof asset.assetKey !== "string") throw new Error("Fixture build asset input is invalid");
        const relativePath = `assets/generated/${asset.assetKey}.${extension}`;
        const target = `${directory}/${relativePath}`;
        await mkdir(dirname(target), { recursive: true });
        await copyFile(`/workspace/inputs/${assetInputFilename(asset)}`, target);
        materialized.push({ assetKey: asset.assetKey, resourcePath: `res://${relativePath}`, sha256: asset.sha256 });
      }
      if (materialized.length > 0) {
        await writeFile(`${directory}/assets/generated/manifest.json`, JSON.stringify({
          schemaVersion: "deviludo.generated-assets.v1",
          items: materialized,
        }));
      }
      await command("tar", ["-czf", `/workspace/outputs/${archive}`, "-C", directory, "."]);
      outputs.push({ file: archive, kind: "BUILD", targetPlatform: platform, contentType: "application/gzip" });
    }
    await progress("PHASE", chinese ? "Fixture Builder 已生成固定的三平台构建制品" : "Fixture Builder generated the fixed three-platform builds");
    await writeFile("/workspace/outputs/manifest.json", JSON.stringify({
      schemaVersion: "deviludo.task-outputs.v1",
      outputs,
    }));
  } else if (plan.agentConfiguration?.runtime !== "CLAUDE_CODE") {
    throw new Error("Fixture Agent requires the fixed Claude Code contract");
  } else if (plan.job.jobKind === "PROJECT_DOCUMENT_MAINTENANCE") {
    const current = plan.job.payload?.document ?? {};
    await writeFile("/workspace/outputs/project-document.json", JSON.stringify({
      schemaVersion: "deviludo.project-document.v1",
      content: {
        introduction: String(current.introduction ?? (chinese ? "Fixture 游戏项目" : "Fixture game project")),
        gameplay: String(current.gameplay ?? (chinese ? "完成固定的自动化游戏循环。" : "Complete the fixed automated gameplay loop.")),
        categories: Array.isArray(current.categories) ? current.categories : [chinese ? "自动化测试" : "Automated testing"],
        features: Array.isArray(current.features) ? current.features : [chinese ? "可重复验证" : "Repeatable verification"],
      },
    }));
    await writeFile("/workspace/outputs/manifest.json", JSON.stringify({
      schemaVersion: "deviludo.task-outputs.v1",
      outputs: [{ file: "project-document.json", kind: "PROJECT_DOCUMENT", contentType: "application/json" }],
    }));
  } else {
    await progress("AGENT_OUTPUT", chinese ? "正在生成 Godot 项目结构、主场景和自动化测试。" : "Generating the Godot project structure, main scene, and automated tests.");
    await cp("/opt/deviludo-fixture", "/workspace/project", { recursive: true, force: false });
    const generatedManifest = JSON.parse(await readFile("/workspace/project/agent.json", "utf8"));
    delete generatedManifest.testManifest;
    await writeFile("/workspace/project/agent.json", `${JSON.stringify(generatedManifest, null, 2)}\n`);
    await progress("AGENT_OUTPUT", chinese ? "项目结构生成完成，正在发布源码 revision。" : "Project structure generated; publishing the source revision.");
    // Match the real Agent runner: the output contract is the generated
    // project's agent.json, not diagnostic metadata about the fixture process.
    await writeFile(
      "/workspace/outputs/agent.json",
      await readFile("/workspace/project/agent.json", "utf8"),
    );
    await writeFile("/workspace/outputs/manifest.json", JSON.stringify({
      schemaVersion: "deviludo.task-outputs.v1",
      outputs: [
        { file: "agent.json", kind: "SPECIFICATION", contentType: "application/json" },
      ],
    }));
  }
} catch (error) {
  taskError = error instanceof Error ? error : new Error("Fixture Agent failed");
}

function assetInputFilename(input) {
  const extension = input.key.match(/\.(png|jpg|webp)$/)?.[1];
  if (!extension) throw new Error("Fixture build asset extension is invalid");
  return `asset-${createHash("sha256").update(input.key).digest("hex")}.${extension}`;
}

await writeFile("/run/deviludo/task-result.json", JSON.stringify({
  ok: taskError === null,
  error: taskError?.message.slice(0, 1_000) ?? null,
}), { mode: 0o600 });
await waitFor("/run/deviludo/collected", "Executor did not collect fixture outputs");
if (taskError) throw taskError;

async function waitFor(path, message) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try { await readFile(path); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error(message);
}

async function command(executable, arguments_) {
  const child = spawn(executable, arguments_, {
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (code !== 0) throw new Error(`Fixture archive failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 1_000)}`);
}

async function progress(kind, content) {
  await appendFile("/run/deviludo/progress.ndjson", `${JSON.stringify({ kind, content })}\n`, { mode: 0o600 });
}
