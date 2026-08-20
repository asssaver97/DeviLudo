import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

if (process.platform !== "darwin") throw new Error("local:bootstrap 当前面向 macOS；生产服务器请使用 deploy/<role> 脚本");
const execute = promisify(execFile);
console.log("\nDeviLudo 本地依赖安装\n");
const homebrewInstaller = Object.freeze({
  commit: "7f43d760bdb28c7813b06874eeabc46bd37a843e",
  sha256: "8ff338091a5e10bb5fc040b38316648110f42feff057ecf9feaab51fd0a13ef9",
});
let brew = process.arch === "arm64" ? "/opt/homebrew/bin/brew" : "/usr/local/bin/brew";
try {
  await access(brew);
} catch {
  const installer = await bootstrapStage("下载并校验 Homebrew 安装器", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "deviludo-homebrew-"));
    const target = join(temporary, "install.sh");
    await execute("curl", [
      "--fail", "--silent", "--show-error", "--location",
      `https://raw.githubusercontent.com/Homebrew/install/${homebrewInstaller.commit}/install.sh`,
      "--output", target,
    ], { maxBuffer: 1024 * 1024 });
    const digest = createHash("sha256").update(await readFile(target)).digest("hex");
    if (digest !== homebrewInstaller.sha256) throw new Error("Homebrew installer SHA-256 mismatch");
    return target;
  });
  await bootstrapStage("安装 Homebrew", () => executeVisible("/bin/bash", [installer], {
    env: { ...process.env, NONINTERACTIVE: "1" },
  }));
  await access(brew);
}
const formulae = ["node@22", "docker", "docker-compose", "colima"];
const missing = [];
for (const formula of formulae) {
  try {
    await execute(brew, ["list", "--versions", formula]);
  } catch {
    missing.push(formula);
  }
}
if (missing.length) {
  await bootstrapStage("更新 Homebrew 软件索引", () => executeVisible(brew, ["update"]));
  for (const formula of missing) {
    await bootstrapStage(`安装 ${formula}`, () => executeVisible(brew, ["install", formula]));
  }
}
await Promise.all(formulae.map(formula => execute(brew, ["pin", formula]).catch(() => undefined)));
try {
  await execute("docker", ["info"], { timeout: 5_000 });
} catch {
  await bootstrapStage("启动 Colima 容器运行时", () => executeVisible("colima", ["start", "--cpu", "4", "--memory", "8", "--disk", "60"]));
}
console.log("\n✓ 本地依赖已就绪\n");
console.log(JSON.stringify({ bootstrapped: true, node: 22, containerRuntime: "colima" }));

async function bootstrapStage(label, operation) {
  const startedAt = Date.now();
  console.log(`[依赖] ${label}…`);
  const heartbeat = setInterval(() => console.log(`    仍在进行（${Math.round((Date.now() - startedAt) / 1_000)} 秒）`), 10_000);
  heartbeat.unref();
  try {
    const result = await operation();
    console.log(`    ✓ 完成（${Math.round((Date.now() - startedAt) / 1_000)} 秒）\n`);
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

function executeVisible(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { ...options, stdio: "inherit", shell: false });
    child.once("error", rejectPromise);
    child.once("close", code => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`${command} exited ${code}`)));
  });
}
