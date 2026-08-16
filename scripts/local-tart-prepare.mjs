import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const localRoot = resolve(root, ".deviludo/local");
const stateFile = resolve(localRoot, "tart-e2e.json");
const keyFile = resolve(localRoot, "tart-guest-ed25519");
const knownHostsFile = resolve(localRoot, "tart-known-hosts");
const guestHostKeyAlias = "deviludo-tart-guest";
const hostGuiDriverFile = resolve(localRoot, "deviludo-gui-driver");
const hostGamepadDriverFile = resolve(localRoot, "deviludo-gamepad-driver");
const goldenName = "deviludo-e2e-tahoe";
const stagingName = `${goldenName}-building`;
const baseCacheName = "deviludo-e2e-tahoe-base-cache";
const baseImage = "ghcr.io/cirruslabs/macos-tahoe-base:latest";

export async function prepareLocalTartE2e({ refresh = false } = {}) {
  if (platform() !== "darwin" || arch() !== "arm64") throw new Error("本地真实窗口 E2E 仅支持 Apple Silicon macOS，且不会降级到宿主机执行");
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  await requireVirtualization();
  await ensureHomebrewTools();
  await ensureSshKey();
  const baseImageDigest = await ensureCachedBaseImage(refresh);
  const fingerprint = await configurationFingerprint(baseImageDigest);
  const previous = await readFile(stateFile, "utf8").then(JSON.parse).catch(() => null);
  if (!refresh && previous?.baseImage === baseImage && previous?.goldenName === goldenName
    && previous?.schema === "deviludo.local-tart-e2e" && previous?.fingerprint === fingerprint
    && await tartVmExists(goldenName)) {
    await ensureAliasedKnownHosts();
    const migrated = { ...previous, baseImageDigest, fingerprint, verifiedAt: new Date().toISOString() };
    await writeState(migrated);
    return Object.freeze({ ...migrated, reused: true });
  }
  await compileHostDrivers();
  const updateFromGolden = !refresh
    && previous?.schema === "deviludo.local-tart-e2e"
    && previous?.baseImage === baseImage
    && previous?.baseImageDigest === baseImageDigest
    && previous?.goldenName === goldenName
    && await tartVmExists(goldenName);
  const updateSource = updateFromGolden ? goldenName : baseCacheName;
  console.log(JSON.stringify({
    event: "local_up_stage",
    stage: "e2e_vm_initializing",
    message: updateFromGolden
      ? "正在增量更新真实窗口 E2E 金镜像"
      : "正在从固定的本地基础镜像构建真实窗口 E2E 金镜像",
  }));
  if (await tartVmExists(stagingName)) await run("tart", ["delete", stagingName], 120_000);
  await visible("tart", ["clone", updateSource, stagingName]);
  await run("tart", ["set", stagingName, "--memory", "6144", "--display", "1440x900"], 30_000);
  const logFile = resolve(localRoot, "tart-provision.log");
  const descriptor = await import("node:fs").then(fs => fs.openSync(logFile, "a", 0o600));
  const vm = spawn("tart", ["run", stagingName, "--no-graphics", "--serial"], { detached: true, stdio: ["ignore", descriptor, descriptor], shell: false });
  await import("node:fs").then(fs => fs.closeSync(descriptor));
  vm.unref();
  let ip = "";
  for (let attempt = 0; attempt < 300; attempt += 1) {
    ip = await execute("tart", ["ip", stagingName], { timeout: 5_000 }).then(result => result.stdout.trim()).catch(() => "");
    if (ip) break;
    await delay(1000);
  }
  if (!ip) throw new Error(`Tart 金镜像未能启动；请查看 ${logFile}`);
  try {
    if (updateFromGolden) {
      await ensureAliasedKnownHosts();
      await waitForGuestSsh(ip);
    } else {
      await authorizeSshKey(ip);
    }
    await installGuestRuntime(ip, { rotateCredentials: !updateFromGolden });
  } catch (error) {
    throw new Error(`Tart 真实窗口环境初始化失败，未启用宿主机降级：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await run("tart", ["stop", stagingName], 120_000).catch(() => undefined);
  }
  // Validate the persisted image after a real reboot. The provisioning session
  // itself inherits the base image's already logged-in desktop and therefore
  // cannot prove that the replacement password still permits automatic login.
  const rebootLogDescriptor = await import("node:fs").then(fs => fs.openSync(logFile, "a", 0o600));
  const rebootedVm = spawn("tart", ["run", stagingName, "--no-graphics", "--serial"], {
    detached: true,
    stdio: ["ignore", rebootLogDescriptor, rebootLogDescriptor],
    shell: false,
  });
  await import("node:fs").then(fs => fs.closeSync(rebootLogDescriptor));
  rebootedVm.unref();
  let rebootedIp = "";
  for (let attempt = 0; attempt < 300; attempt += 1) {
    rebootedIp = await execute("tart", ["ip", stagingName], { timeout: 5_000 }).then(result => result.stdout.trim()).catch(() => "");
    if (rebootedIp) break;
    await delay(1000);
  }
  if (!rebootedIp) throw new Error(`Tart 金镜像重启后未能启动；请查看 ${logFile}`);
  let gamepadAvailable = false;
  try {
    await waitForGuestSsh(rebootedIp);
    await waitForGuestDesktop(rebootedIp);
    gamepadAvailable = await smokeGuestRuntime(rebootedIp);
  } catch (error) {
    throw new Error(`Tart 金镜像重启后真实窗口 smoke 失败，未启用宿主机降级：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await run("tart", ["stop", stagingName], 120_000).catch(() => undefined);
  }
  if (await tartVmExists(goldenName)) await run("tart", ["delete", goldenName], 120_000);
  await run("tart", ["rename", stagingName, goldenName], 120_000);
  const state = { schema: "deviludo.local-tart-e2e", goldenName, baseImage, baseCacheName, baseImageDigest, fingerprint, gamepadAvailable, guestUser: "admin", keyFile, knownHostsFile, createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString() };
  await writeState(state);
  return Object.freeze({ ...state, reused: false });
}

async function ensureHomebrewTools() {
  await access("/opt/homebrew/bin/brew").catch(() => { throw new Error("缺少 Homebrew，无法自动安装 Tart 和 SSH 辅助工具"); });
  const tools = [["tart", "tart"], ["sshpass", "sshpass"]];
  const missing = [];
  for (const [command, formula] of tools) if (!await commandExists(command)) missing.push([command, formula]);
  if (!missing.length) return;
  await assertHomebrewCommandLineTools();
  await visible("/opt/homebrew/bin/brew", ["tap", "cirruslabs/cli"]);
  const trustedFormulae = new Set(missing.map(([, formula]) => `cirruslabs/cli/${formula}`));
  if (missing.some(([command]) => command === "tart")) trustedFormulae.add("cirruslabs/cli/softnet");
  await visible("/opt/homebrew/bin/brew", ["trust", "--formula", ...trustedFormulae]);
  for (const [command, formula] of missing) {
    console.log(JSON.stringify({ event: "local_up_stage", stage: "installing_e2e_tool", tool: command }));
    await visible("/opt/homebrew/bin/brew", ["install", `cirruslabs/cli/${formula}`]);
  }
}

async function assertHomebrewCommandLineTools() {
  let diagnosis = "";
  try {
    const result = await execute("/opt/homebrew/bin/brew", ["doctor"], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    diagnosis = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    diagnosis = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  }
  if (!/Command Line Tools are too outdated/i.test(diagnosis)) return;
  const installed = await execute("pkgutil", ["--pkg-info=com.apple.pkg.CLTools_Executables"], { timeout: 10_000 })
    .then(result => result.stdout.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? "未知版本")
    .catch(() => "未知版本");
  const required = diagnosis.match(/Command Line Tools for Xcode\s+([0-9.]+)/i)?.[1];
  throw new Error(
    `当前 Command Line Tools ${installed} 与系统不兼容。请先在“系统设置 → 通用 → 软件更新”安装${required ? ` Command Line Tools for Xcode ${required}` : "最新版 Command Line Tools"}，`
      + "或从 https://developer.apple.com/download/all/ 手动下载安装；完成后重新运行 npm run local:up。",
  );
}

async function ensureSshKey() {
  if (await access(keyFile).then(() => true).catch(() => false)) return;
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile], 30_000);
  await chmod(keyFile, 0o600); await chmod(`${keyFile}.pub`, 0o644);
}

async function ensureCachedBaseImage(refresh) {
  const cacheExists = await tartVmExists(baseCacheName);
  if (refresh || !cacheExists) await requireDiskSpace();
  if (refresh && await tartVmExists(baseCacheName)) await run("tart", ["delete", baseCacheName], 120_000);
  if (!await tartVmExists(baseCacheName)) {
    console.log(JSON.stringify({ event: "local_up_stage", stage: "e2e_vm_base_downloading", message: "首次下载 macOS E2E 基础镜像（约 25 GB）" }));
    await visible("tart", ["clone", baseImage, baseCacheName]);
  }
  let identity = "";
  try {
    const listing = JSON.parse((await execute("tart", ["list", "--format", "json"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
    const rows = Array.isArray(listing) ? listing : Array.isArray(listing?.vms) ? listing.vms : [];
    const canonicalPrefix = `${baseImage.replace(/:latest$/, "")}@sha256:`;
    const canonical = rows.map(item => item?.Name ?? item?.name).find(name => typeof name === "string" && name.startsWith(canonicalPrefix));
    const canonicalDigest = canonical?.slice(canonical.lastIndexOf("@") + 1);
    if (/^sha256:[0-9a-f]{64}$/i.test(canonicalDigest ?? "")) return canonicalDigest;
    const row = rows.find(item => [item?.Name, item?.name].includes(baseCacheName));
    if (row) identity = JSON.stringify({
      disk: row.Disk ?? row.disk,
      name: row.Name ?? row.name,
      size: row.Size ?? row.size,
      source: row.Source ?? row.source,
    });
  } catch { /* older Tart versions expose only the tabular listing */ }
  if (!identity) {
    const configuration = (await execute("tart", ["get", baseCacheName], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    identity = configuration.replace(/\b(?:running|stopped)\s*$/gim, "").trim();
  }
  if (!identity) throw new Error("无法读取缓存的 Tart 基础镜像标识");
  const digest = createHash("sha256").update(baseImage).update("\0").update(identity).digest("hex");
  return `sha256:${digest}`;
}

async function authorizeSshKey(ip) {
  const publicKey = (await readFile(`${keyFile}.pub`, "utf8")).trim();
  const bootstrapArguments = [
    "-p", "admin", "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=5",
    "-o", "ConnectionAttempts=1",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=1",
    "-o", "PreferredAuthentications=password",
    "-o", "PubkeyAuthentication=no",
    `admin@${ip}`,
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && IFS= read -r key && { grep -qxF \"$key\" ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' \"$key\" >> ~/.ssh/authorized_keys; } && chmod 600 ~/.ssh/authorized_keys",
  ];
  let authorized = false;
  let authorizationError;
  for (let attempt = 0; attempt < 20 && !authorized; attempt += 1) {
    try {
      await spawnWithInput("sshpass", bootstrapArguments, `${publicKey}\n`, 15_000);
      authorized = true;
    } catch (error) {
      authorizationError = error;
      await delay(2000);
    }
  }
  if (!authorized) throw authorizationError ?? new Error("无法授权 Tart guest SSH key");
  let knownHosts = "";
  for (let attempt = 0; attempt < 20 && !knownHosts; attempt += 1) {
    const scan = await execute("ssh-keyscan", ["-T", "5", "-H", ip], { timeout: 10_000, maxBuffer: 1024 * 1024 })
      .then(result => result.stdout.trim())
      .catch(error => String(error?.stdout ?? "").trim());
    knownHosts = scan.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#") && line.split(/\s+/).length >= 3)
      .join("\n");
    if (!knownHosts) await delay(1000);
  }
  if (!knownHosts) throw new Error("无法固定 Tart guest SSH host key");
  await writeFile(knownHostsFile, `${knownHosts}\n`, { mode: 0o600 });
  await ensureAliasedKnownHosts();
}

async function ensureAliasedKnownHosts() {
  const knownHosts = await readFile(knownHostsFile, "utf8");
  const aliased = [...new Set(knownHosts.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .map(line => line.split(/\s+/))
    .filter(parts => parts.length >= 3)
    .map(parts => `${guestHostKeyAlias} ${parts.slice(1).join(" ")}`))];
  if (!aliased.length) throw new Error("缓存的 Tart guest SSH host key 无效");
  await writeFile(knownHostsFile, `${aliased.join("\n")}\n`, { mode: 0o600 });
}

async function compileHostDrivers() {
  const moduleCache = resolve(localRoot, "swift-module-cache");
  await mkdir(moduleCache, { recursive: true, mode: 0o700 });
  await execute("swiftc", [
    "-Onone",
    "-target", "arm64-apple-macosx15.0",
    "-module-cache-path", moduleCache,
    "-o", hostGuiDriverFile,
    resolve(root, "scripts/executors/macos-gui-driver.swift"),
  ], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  await chmod(hostGuiDriverFile, 0o755);
  await execute("swiftc", [
    "-Onone", "-parse-as-library", "-target", "arm64-apple-macosx15.0", "-module-cache-path", moduleCache,
    "-o", hostGamepadDriverFile, resolve(root, "scripts/executors/macos-gamepad-driver.swift"),
  ], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  await chmod(hostGamepadDriverFile, 0o755);
}

async function installGuestRuntime(ip, { rotateCredentials = true } = {}) {
  const ssh = sshArguments();
  for (const [source, destination] of [
    [resolve(root, "scripts/executors/godot-window-e2e-guest.mjs"), "/Users/Shared/godot-window-e2e-guest.mjs"],
    [resolve(root, "scripts/executors/game-test-environment.mjs"), "/Users/Shared/game-test-environment.mjs"],
    [resolve(root, "scripts/executors/gui-event-batches.mjs"), "/Users/Shared/gui-event-batches.mjs"],
    [resolve(root, "scripts/e2e-evidence.mjs"), "/Users/Shared/e2e-evidence.mjs"],
    [resolve(root, "scripts/e2e-ui-probe.mjs"), "/Users/Shared/e2e-ui-probe.mjs"],
    [resolve(root, "scripts/e2e-interaction-contract.mjs"), "/Users/Shared/e2e-interaction-contract.mjs"],
    [resolve(root, "scripts/executors/godot-system-gamepad-smoke.mjs"), "/Users/Shared/godot-system-gamepad-smoke.mjs"],
    [resolve(root, "fixtures/godot-input-smoke/project.godot"), "/Users/Shared/godot-input-smoke-project.godot"],
    [resolve(root, "fixtures/godot-input-smoke/main.tscn"), "/Users/Shared/godot-input-smoke-main.tscn"],
    [resolve(root, "fixtures/godot-input-smoke/main.gd"), "/Users/Shared/godot-input-smoke-main.gd"],
    [hostGuiDriverFile, "/Users/Shared/deviludo-gui-driver"],
    [hostGamepadDriverFile, "/Users/Shared/deviludo-gamepad-driver"],
    [resolve(root, "scripts/local-tart-provision.sh"), "/Users/Shared/local-tart-provision.sh"],
  ]) await run("scp", [...ssh, source, `admin@${ip}:${destination}`], 120_000);
  // loginwindow silently rejects longer auto-login secrets on current
  // Tahoe images and restores the base image's stale kcpassword. Twenty-four
  // base64url characters still provide 144 bits of random entropy while
  // remaining compatible with the persisted desktop login path.
  const password = randomBytes(12).toString("hex");
  const environment = rotateCredentials
    ? `DEVILUDO_ROTATE_GUEST_CREDENTIALS=1 DEVILUDO_REPLACEMENT_PASSWORD=${password}`
    : "DEVILUDO_ROTATE_GUEST_CREDENTIALS=0";
  await spawnWithInput("ssh", [...ssh, `admin@${ip}`, `env ${environment} sudo -S -E bash /Users/Shared/local-tart-provision.sh`], "admin\n", 45 * 60_000);
}

async function smokeGuestRuntime(ip) {
  const ssh = sshArguments();
  const command = "set -e; printf 'DeviLudo real-window E2E smoke\\n' > /Users/Shared/deviludo-smoke.txt; open -a TextEdit /Users/Shared/deviludo-smoke.txt; sleep 3; pid=$(pgrep -x TextEdit | head -n1); test -n \"$pid\"; /usr/local/bin/deviludo-gui-driver wait --pid \"$pid\" --width 1 --height 1; /usr/local/bin/deviludo-gui-driver event --pid \"$pid\" --event '{\"type\":\"key_press\",\"key\":\"KEY_A\"}'; /usr/local/bin/deviludo-gui-driver event --pid \"$pid\" --event '{\"type\":\"key_release\",\"key\":\"KEY_A\"}'; /usr/local/bin/deviludo-gui-driver capture --pid \"$pid\" --output /Users/Shared/deviludo-smoke.png; /usr/local/bin/node -e \"import('/usr/local/lib/deviludo/e2e-evidence.mjs').then(m=>m.inspectScreenshot('/Users/Shared/deviludo-smoke.png')).then(()=>process.stdout.write('smoke-ok'))\"; mkdir -p /Users/Shared/godot-input-smoke; cp /Users/Shared/godot-input-smoke-project.godot /Users/Shared/godot-input-smoke/project.godot; cp /Users/Shared/godot-input-smoke-main.tscn /Users/Shared/godot-input-smoke/main.tscn; cp /Users/Shared/godot-input-smoke-main.gd /Users/Shared/godot-input-smoke/main.gd; DEVILUDO_GAMEPAD_OPTIONAL=1 DEVILUDO_GAMEPAD_DRIVER=/usr/local/bin/deviludo-gamepad-driver /usr/local/bin/node /Users/Shared/godot-system-gamepad-smoke.mjs /Users/Shared/godot-input-smoke";
  const { stdout } = await execute("ssh", [...ssh, `admin@${ip}`, command], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  if (!stdout.includes("smoke-ok") || (!stdout.includes("gamepad-smoke-ok") && !stdout.includes("gamepad-smoke-unavailable"))) throw new Error("Tart guest 截图/键鼠 smoke 未通过（检查 Screen Recording 与 Accessibility 权限）");
  const available = stdout.includes("gamepad-smoke-ok");
  if (!available) console.warn("Tart guest 未获得 Apple Core HID 虚拟设备 entitlement；键鼠 E2E 可用，声明 GAMEPAD 的项目将明确报基础设施不可用");
  return available;
}

async function waitForGuestSsh(ip) {
  const ssh = sshArguments();
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await execute("ssh", [...ssh, "-o", "ConnectTimeout=5", `admin@${ip}`, "true"], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(2000);
    }
  }
  throw lastError ?? new Error("Tart guest SSH did not become ready after reboot");
}

async function waitForGuestDesktop(ip) {
  const ssh = sshArguments();
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await execute("ssh", [
        ...ssh,
        `admin@${ip}`,
        "test \"$(stat -f '%Su' /dev/console)\" = admin && launchctl print gui/501 >/dev/null",
      ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      return;
    } catch (error) {
      lastError = error;
      await delay(2000);
    }
  }
  throw lastError ?? new Error("Tart guest admin desktop did not become ready after reboot");
}

function sshArguments() { return ["-i", keyFile, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `HostKeyAlias=${guestHostKeyAlias}`, "-o", `UserKnownHostsFile=${knownHostsFile}`]; }
async function configurationFingerprint(baseImageDigest) {
  const hash = createHash("sha256").update("deviludo-tart-adaptive-e2e\0tahoe-26\0node-22.22.0\0godot-4.5.1\0ffmpeg\0memory-6144\0display-1440x900\0swift-Onone\0").update(baseImageDigest);
  hash.update(await readFile(`${keyFile}.pub`));
  for (const file of ["scripts/executors/godot-window-e2e-guest.mjs", "scripts/executors/game-test-environment.mjs", "scripts/executors/gui-event-batches.mjs", "scripts/executors/godot-system-gamepad-smoke.mjs", "scripts/e2e-evidence.mjs", "scripts/e2e-ui-probe.mjs", "scripts/e2e-interaction-contract.mjs", "scripts/executors/macos-gui-driver.swift", "scripts/executors/macos-gamepad-driver.swift", "fixtures/godot-input-smoke/project.godot", "fixtures/godot-input-smoke/main.tscn", "fixtures/godot-input-smoke/main.gd", "scripts/local-tart-provision.sh"]) hash.update(await readFile(resolve(root, file)));
  return `sha256:${hash.digest("hex")}`;
}
async function tartVmExists(name) {
  try {
    const { stdout } = await execute("tart", ["list", "--format", "json"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const listing = JSON.parse(stdout);
    const rows = Array.isArray(listing) ? listing : Array.isArray(listing?.vms) ? listing.vms : [];
    return rows.some(item => [item?.Name, item?.name].includes(name));
  } catch {
    const { stdout } = await execute("tart", ["list"], { timeout: 30_000 });
    return stdout.split(/\r?\n/).some(line => line.trim().split(/\s+/).includes(name));
  }
}
async function commandExists(name) { return execute("/usr/bin/which", [name], { timeout: 10_000 }).then(() => true).catch(() => false); }
async function requireDiskSpace() { const { stdout } = await execute("df", ["-Pk", localRoot]); const available = Number(stdout.trim().split(/\s+/).at(-3)); if (!Number.isFinite(available) || available < 35 * 1024 * 1024) throw new Error("Tart E2E 初始化至少需要 35 GiB 可用磁盘空间"); }
async function requireVirtualization() { const { stdout } = await execute("sysctl", ["-n", "kern.hv_support"]); if (stdout.trim() !== "1") throw new Error("当前 Mac 未启用 Apple 虚拟化能力"); }
async function writeState(value) { await writeFile(stateFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function delay(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }
function run(executable, arguments_, timeout) { return execute(executable, arguments_, { timeout, maxBuffer: 4 * 1024 * 1024 }); }
function visible(executable, arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, arguments_, { stdio: "inherit", shell: false });
    child.once("error", rejectPromise);
    child.once("close", code => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${executable} exited ${code}`));
    });
  });
}
function spawnWithInput(executable, arguments_, input, timeout) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, arguments_, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.stdin.end(input);
    child.once("error", rejectPromise);
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${executable} failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 2000)}`));
    });
  });
}
