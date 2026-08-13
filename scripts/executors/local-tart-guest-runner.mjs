#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);
const action = process.argv[2];
const argument = name => process.argv[process.argv.indexOf(name) + 1] ?? "";
const jobId = argument("--job-id");
const artifact = argument("--artifact");
const hostOutput = process.env.DEVILUDO_E2E_HOST_OUTPUT ?? "";
if (!/^[0-9a-f-]{36}$/i.test(jobId) || !isAbsolute(artifact) || !["test", "clean-install"].includes(action)) throw new Error("Local Tart guest request is invalid");
const configuration = JSON.parse(await readFile(new URL("../../.deviludo/local/tart-e2e.json", import.meta.url), "utf8"));
const vmName = `deviludo-${jobId}`;
let ip = "";
for (let attempt = 0; attempt < 180; attempt += 1) {
  ip = (await execute("tart", ["ip", vmName], { timeout: 5_000 }).then(result => result.stdout.trim()).catch(() => ""));
  if (ip) break;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
}
if (!ip) throw new Error("Tart guest did not report an address");
const ssh = ["-i", configuration.keyFile, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "HostKeyAlias=deviludo-tart-guest", "-o", `UserKnownHostsFile=${configuration.knownHostsFile}`];
const remoteArtifact = `/Users/Shared/deviludo-artifact-${jobId}`;
await execute("scp", [...ssh, artifact, `${configuration.guestUser}@${ip}:${remoteArtifact}`], { timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
const command = [
  "env", "DEVILUDO_GUI_DRIVER=/usr/local/bin/deviludo-gui-driver",
  "DEVILUDO_GUEST_EVIDENCE_ROOT=/Users/Shared",
  "DEVILUDO_GUEST_JOB_ROOT=/Users/Shared",
  "/usr/local/bin/node", "/usr/local/lib/deviludo/executors/godot-window-e2e-guest.mjs",
  action, remoteArtifact, "--job-id", jobId, "--json",
];
const { stdout } = await execute("ssh", [...ssh, `${configuration.guestUser}@${ip}`, ...command], { timeout: 15 * 60_000, maxBuffer: 2 * 1024 * 1024 });
const receipt = JSON.parse(stdout);
if (action === "test") {
  if (!isAbsolute(hostOutput) || typeof receipt.outputPath !== "string" || !receipt.outputPath.startsWith("/Users/Shared/")) throw new Error("Tart guest evidence path is invalid");
  await execute("scp", [...ssh, `${configuration.guestUser}@${ip}:${receipt.outputPath}`, hostOutput], { timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  receipt.outputPath = hostOutput;
}
process.stdout.write(JSON.stringify(receipt));
