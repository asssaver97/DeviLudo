import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

if (process.platform !== "darwin") throw new Error("local:bootstrap 当前面向 macOS；生产服务器请使用 deploy/<role> 脚本");
const execute = promisify(execFile);
const homebrewInstaller = Object.freeze({
  commit: "7f43d760bdb28c7813b06874eeabc46bd37a843e",
  sha256: "8ff338091a5e10bb5fc040b38316648110f42feff057ecf9feaab51fd0a13ef9",
});
let brew = process.arch === "arm64" ? "/opt/homebrew/bin/brew" : "/usr/local/bin/brew";
try {
  await access(brew);
} catch {
  const temporary = await mkdtemp(join(tmpdir(), "deviludo-homebrew-"));
  const installer = join(temporary, "install.sh");
  await execute("curl", [
    "--fail", "--silent", "--show-error", "--location",
    `https://raw.githubusercontent.com/Homebrew/install/${homebrewInstaller.commit}/install.sh`,
    "--output", installer,
  ], { maxBuffer: 1024 * 1024 });
  const digest = createHash("sha256").update(await readFile(installer)).digest("hex");
  if (digest !== homebrewInstaller.sha256) throw new Error("Homebrew installer SHA-256 mismatch");
  await execute("/bin/bash", [installer], { env: { ...process.env, NONINTERACTIVE: "1" }, maxBuffer: 20 * 1024 * 1024 });
  await access(brew);
}
let changed = false;
for (const formula of ["node@22", "docker", "docker-compose", "colima", "cosign"]) {
  try {
    await execute(brew, ["list", "--versions", formula]);
  } catch {
    if (!changed) await execute(brew, ["update"], { maxBuffer: 10 * 1024 * 1024 });
    changed = true;
    await execute(brew, ["install", formula], { maxBuffer: 20 * 1024 * 1024 });
  }
  await execute(brew, ["pin", formula]).catch(() => undefined);
}
try {
  await execute("docker", ["info"], { timeout: 5_000 });
} catch {
  await execute("colima", ["start", "--cpu", "4", "--memory", "8", "--disk", "60"], { maxBuffer: 10 * 1024 * 1024 });
}
console.log(JSON.stringify({ bootstrapped: true, node: 22, containerRuntime: "colima" }));
