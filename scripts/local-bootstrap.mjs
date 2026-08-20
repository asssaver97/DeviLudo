import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

if (process.platform !== "darwin") throw new Error("local:bootstrap currently supports macOS; use deploy/<role> scripts for production servers");
const execute = promisify(execFile);
console.log("\nInstalling DeviLudo local dependencies\n");
const homebrewInstaller = Object.freeze({
  commit: "7f43d760bdb28c7813b06874eeabc46bd37a843e",
  sha256: "8ff338091a5e10bb5fc040b38316648110f42feff057ecf9feaab51fd0a13ef9",
});
let brew = process.arch === "arm64" ? "/opt/homebrew/bin/brew" : "/usr/local/bin/brew";
try {
  await access(brew);
} catch {
  const installer = await bootstrapStage("Download and verify the Homebrew installer", async () => {
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
  await bootstrapStage("Install Homebrew", () => executeVisible("/bin/bash", [installer], {
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
  await bootstrapStage("Update the Homebrew package index", () => executeVisible(brew, ["update"]));
  for (const formula of missing) {
    await bootstrapStage(`Install ${formula}`, () => executeVisible(brew, ["install", formula]));
  }
}
await Promise.all(formulae.map(formula => execute(brew, ["pin", formula]).catch(() => undefined)));
try {
  await execute("docker", ["info"], { timeout: 5_000 });
} catch {
  await bootstrapStage("Start the Colima container runtime", () => executeVisible("colima", ["start", "--cpu", "4", "--memory", "8", "--disk", "60"]));
}
console.log("\n✓ Local dependencies are ready\n");
console.log(JSON.stringify({ bootstrapped: true, node: 22, containerRuntime: "colima" }));

async function bootstrapStage(label, operation) {
  const startedAt = Date.now();
  console.log(`[dependency] ${label}...`);
  const heartbeat = setInterval(() => console.log(`    Still working (${Math.round((Date.now() - startedAt) / 1_000)}s)`), 10_000);
  heartbeat.unref();
  try {
    const result = await operation();
    console.log(`    ✓ Done (${Math.round((Date.now() - startedAt) / 1_000)}s)\n`);
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
