import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_NAMESPACE = "deviludo.machine-installation.v1";

/**
 * Returns an app-scoped identifier for this physical machine. The native
 * machine identifier is only hashed on the host and is never persisted or
 * passed to a container. A persistent random ID is used only on platforms
 * where no native machine identifier can be read.
 */
export async function resolveMachineInstallationId() {
  const operatingSystem = platform();
  const nativeId = await readNativeMachineId(operatingSystem);
  if (nativeId) return deriveMachineInstallationId(operatingSystem, nativeId);
  return readOrCreateFallbackId(operatingSystem);
}

export function deriveMachineInstallationId(operatingSystem, nativeId) {
  const normalizedPlatform = operatingSystem.trim().toLowerCase();
  const normalizedId = nativeId.trim().toLowerCase();
  if (!normalizedPlatform || !normalizedId) throw new Error("Machine identity source is empty");
  const digest = createHash("sha256")
    .update(`${HASH_NAMESPACE}\0${normalizedPlatform}\0${normalizedId}`, "utf8")
    .digest("hex");
  // Keep UUID metadata bits deterministic so the collector can retain its UUID
  // validation while the remaining 122 bits identify the machine.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function readNativeMachineId(operatingSystem) {
  if (operatingSystem === "darwin") {
    try {
      const { stdout } = await execute("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      });
      return stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
    } catch {
      return null;
    }
  }
  if (operatingSystem === "linux") {
    for (const target of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const value = (await readFile(target, "utf8")).trim();
        if (value) return value;
      } catch {
        // Try the next standard machine-id location.
      }
    }
    return null;
  }
  if (operatingSystem === "win32") {
    try {
      const { stdout } = await execute("reg.exe", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ], { timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true });
      return stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

async function readOrCreateFallbackId(operatingSystem) {
  const directory = fallbackStateDirectory(operatingSystem);
  const target = join(directory, "installation-id");
  try {
    const existing = (await readFile(target, "utf8")).trim();
    if (UUID.test(existing)) return existing.toLowerCase();
  } catch {
    // Create the fallback below.
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const created = randomUUID();
  try {
    await writeFile(target, `${created}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return created;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    const existing = (await readFile(target, "utf8")).trim();
    if (!UUID.test(existing)) throw new Error(`Invalid fallback machine ID at ${target}`);
    return existing.toLowerCase();
  }
}

function fallbackStateDirectory(operatingSystem) {
  if (operatingSystem === "win32") {
    return join(process.env.LOCALAPPDATA?.trim() || homedir(), "DeviLudo");
  }
  return join(process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "deviludo");
}
