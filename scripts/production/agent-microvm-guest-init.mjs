#!/usr/bin/node

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";

const DATA_ROOT = "/run/deviludo";
const CREDENTIAL_ROOT = "/run/deviludo-credentials";
const ENV_FILE = `${CREDENTIAL_ROOT}/guest-runtime.json`;
const SERVICE = "/opt/deviludo/agent-microvm-guest-service.mjs";
const SAFE_ENV = new Set([
  "DEVILUDO_MICROVM_GUEST_ATTESTATION_KEY_ID", "DEVILUDO_MICROVM_GUEST_ATTESTATION_PRIVATE_KEY_FILE",
  "DEVILUDO_MICROVM_GUEST_GATEWAY_CA_FILE", "DEVILUDO_MICROVM_GUEST_GATEWAY_TLS_CERT_FILE",
  "DEVILUDO_MICROVM_GUEST_GATEWAY_TLS_KEY_FILE", "DEVILUDO_MICROVM_GUEST_RELAY_ORIGIN",
  "DEVILUDO_MICROVM_GUEST_RELAY_TLS_CERT_FILE", "DEVILUDO_MICROVM_GUEST_RELAY_TLS_KEY_FILE",
  "DEVILUDO_EPHEMERAL_SECRET_BROKER_URL", "DEVILUDO_EPHEMERAL_SECRET_CA_FILE",
  "DEVILUDO_EPHEMERAL_SECRET_TLS_CERT_FILE", "DEVILUDO_EPHEMERAL_SECRET_TLS_KEY_FILE",
]);

export async function runAgentMicrovmGuestInit({ command = run } = {}) {
  if (process.platform !== "linux" || typeof process.geteuid !== "function" || process.geteuid() !== 0) fail();
  await command("/bin/mount", ["-t", "proc", "proc", "/proc"]);
  await command("/bin/mount", ["-t", "sysfs", "sysfs", "/sys"]);
  await command("/bin/mount", ["-t", "ext4", "-o", "rw,nosuid,nodev,noexec", "/dev/vdb", DATA_ROOT]);
  await command("/bin/mount", ["-t", "ext4", "-o", "ro,nosuid,nodev,noexec", "/dev/vdc", CREDENTIAL_ROOT]);
  const runtime = parseRuntime(JSON.parse(await readFile(ENV_FILE, "utf8")));
  const serviceEnv = Object.freeze({
    NODE_ENV: "production", NODE_OPTIONS: "--enable-source-maps", NODE_PATH: "", HOME: "/run/deviludo-home",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LD_LIBRARY_PATH: "", LD_PRELOAD: "",
    DEVILUDO_AGENT_UPDATE_POLICY: "immutable-image-only", DISABLE_UPDATES: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DEVILUDO_MICROVM_GUEST_RUN_ROOT: DATA_ROOT,
    DEVILUDO_MICROVM_GUEST_WORKSPACE_ROOT: `${DATA_ROOT}/workspace`,
    DEVILUDO_MICROVM_GUEST_REQUEST_FILE: `${DATA_ROOT}/control/request.json`,
    DEVILUDO_MICROVM_GUEST_RESPONSE_FILE: `${DATA_ROOT}/control/response.json`, ...runtime,
  });
  let succeeded = false;
  try { await command("/usr/bin/node", [SERVICE], serviceEnv); succeeded = true; }
  finally {
    await command("/bin/sync", []).catch(() => undefined);
    await command("/bin/umount", [CREDENTIAL_ROOT]).catch(() => undefined);
    await command("/bin/umount", [DATA_ROOT]).catch(() => undefined);
  }
  if (!succeeded) fail();
  await command("/sbin/poweroff", ["-f"]);
}

function parseRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...SAFE_ENV].sort())) fail();
  const result = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== "string" || !raw || raw.length > 4096 || /[\0\r\n]/.test(raw)) fail();
    if (name.endsWith("_FILE") && (!raw.startsWith(`${CREDENTIAL_ROOT}/`) || raw.includes(".."))) fail();
    if ((name.endsWith("_URL") || name.endsWith("_ORIGIN"))) {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail();
      if (name.endsWith("_ORIGIN") && url.hostname !== "127.0.0.1") fail();
    }
    result[name] = raw;
  }
  return Object.freeze(result);
}

function run(executable, args, environment) {
  return new Promise((resolve, reject) => execFile(executable, args, {
    env: environment ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" }, shell: false,
    windowsHide: true, timeout: executable === "/usr/bin/node" ? 86_400_000 : 30_000, maxBuffer: 256 * 1024,
  }, (error, stdout, stderr) => error || stdout || stderr ? reject(error ?? new Error("unexpected init output")) : resolve()));
}

function fail() { throw new Error("Agent microVM guest init contract is invalid"); }

if (process.argv[1]?.endsWith("agent-microvm-guest-init.mjs")) {
  runAgentMicrovmGuestInit().catch(async () => {
    try { const file = await open("/dev/console", constants.O_WRONLY); await file.write("[deviludo-guest] init failed\n"); await file.close(); }
    catch { /* fail closed even without a console */ }
    process.exitCode = 1;
  });
}
