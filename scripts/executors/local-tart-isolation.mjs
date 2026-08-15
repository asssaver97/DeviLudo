#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readCliArgument } from "../../deploy/assets/e2e-process-lifecycle.mjs";

const action = process.argv[2];
const argument = name => readCliArgument(process.argv, name);
const stage = argument("--stage");
const jobId = argument("--job-id");
const generation = argument("--generation");
if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^\d+$/.test(generation) || !["reimage", "cleanup"].includes(action)) throw new Error("Tart isolation request is invalid");
const configuration = JSON.parse(await readFile(new URL("../../.deviludo/local/tart-e2e.json", import.meta.url), "utf8"));
if (!/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(configuration.goldenName)) throw new Error("Local Tart golden image configuration is invalid");
const vmName = `deviludo-${jobId}`;
const runtimeRoot = resolve(process.env.DEVILUDO_E2E_JOB_ROOT ?? new URL("../../.deviludo/local/tart-host-jobs/", import.meta.url).pathname);
if (!runtimeRoot.startsWith(resolve(new URL("../../.deviludo/local/", import.meta.url).pathname) + "/")) {
  throw new Error("Local Tart job root escaped .deviludo/local");
}

if (action === "reimage" && stage === "before") {
  await run("tart", ["clone", configuration.goldenName, vmName], 10 * 60_000);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const output = await import("node:fs").then(fs => fs.openSync(resolve(runtimeRoot, `${jobId}.log`), "a", 0o600));
  const child = spawn("tart", ["run", vmName, "--no-graphics", "--serial"], { detached: true, stdio: ["ignore", output, output], shell: false });
  child.unref();
  if (!child.pid) throw new Error("Tart VM process did not start");
} else if ((action === "cleanup" || action === "reimage") && stage === "after") {
  await run("tart", ["stop", vmName], 60_000).catch(() => undefined);
  await run("tart", ["delete", vmName], 60_000).catch(() => undefined);
  await rm(resolve(runtimeRoot, `${jobId}.log`), { force: true });
  for (const entry of await readdir(runtimeRoot).catch(() => [])) {
    if (entry.startsWith(`deviludo-${jobId}-`)) await rm(join(runtimeRoot, entry), { recursive: true, force: true });
  }
} else throw new Error("Unsupported Tart isolation transition");
process.stdout.write(`${action}:${stage}:${jobId}:g${generation}:${configuration.fingerprint}`);

function run(executable, arguments_, timeout) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, arguments_, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectPromise);
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${executable} failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`));
    });
  });
}
