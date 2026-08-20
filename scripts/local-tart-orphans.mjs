import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const runtimeRoot = resolve(root, ".deviludo/local/tart-host-jobs");
const stagingName = "deviludo-e2e-tahoe-building";
const jobVmName = /^deviludo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function managedLocalTartVmNames(listing) {
  const rows = Array.isArray(listing) ? listing : Array.isArray(listing?.vms) ? listing.vms : [];
  return [...new Set(rows
    .map(item => item?.Name ?? item?.name)
    .filter(name => typeof name === "string" && (name === stagingName || jobVmName.test(name))))];
}

/**
 * Reaps only disposable local E2E VMs. The golden image and base cache never
 * match these names, so a recovery pass cannot destroy reusable setup state.
 */
export async function cleanupLocalTartOrphans() {
  if (platform() !== "darwin" || !await commandExists("tart")) return [];
  let names;
  try {
    const listing = await execute("tart", ["list", "--format", "json"], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }).then(result => JSON.parse(result.stdout));
    names = managedLocalTartVmNames(listing);
  } catch {
    const { stdout } = await execute("tart", ["list"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    names = [...new Set(stdout.split(/\r?\n/)
      .flatMap(line => line.trim().split(/\s+/))
      .filter(name => name === stagingName || jobVmName.test(name)))];
  }
  for (const name of names) {
    await execute("tart", ["stop", name], { timeout: 120_000, maxBuffer: 1024 * 1024 }).catch(() => undefined);
    await execute("tart", ["delete", name], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const jobId = name.slice("deviludo-".length);
    if (jobVmName.test(name)) await rm(resolve(runtimeRoot, `${jobId}.log`), { force: true });
  }
  return names;
}

async function commandExists(name) {
  return execute("/usr/bin/which", [name], { timeout: 10_000, maxBuffer: 64 * 1024 })
    .then(() => true)
    .catch(() => false);
}
