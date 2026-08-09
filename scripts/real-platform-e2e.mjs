import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const platformArgument = process.argv.find(value => value.startsWith("--platform="));
const platform = platformArgument?.slice("--platform=".length);
const hostPlatforms = Object.freeze({ linux: "linux", windows: "win32", macos: "darwin" });
if (!platform || !Object.hasOwn(hostPlatforms, platform)) throw new Error("--platform=linux|windows|macos is required");
if (process.platform !== hostPlatforms[platform]) {
  throw new Error(`REAL_PLATFORM_MISMATCH: ${platform} acceptance cannot run on ${process.platform}`);
}

const fixture = resolve(new URL("../fixtures/godot-smoke", import.meta.url).pathname);
const configuredGodot = process.env.DEVILUDO_GODOT_BIN?.trim() || "godot";
const godot = isAbsolute(configuredGodot) ? configuredGodot : await resolveCommand(configuredGodot);
const expectedVersion = process.env.DEVILUDO_GODOT_VERSION ?? "4.5.1";
const versionResult = await execute(godot, ["--version"], { timeout: 30_000, maxBuffer: 1024 * 1024 });
const runtimeVersion = `${versionResult.stdout}${versionResult.stderr}`.trim();
if (!runtimeVersion.startsWith(expectedVersion)) {
  throw new Error(`GODOT_VERSION_MISMATCH: expected ${expectedVersion}, received ${runtimeVersion}`);
}

let stdout = "";
let stderr = "";
let exitCode = 0;
try {
  const result = await execute(godot, ["--headless", "--path", fixture, "--script", "res://tests/e2e.gd"], {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  stdout = result.stdout;
  stderr = result.stderr;
} catch (error) {
  stdout = error?.stdout ?? "";
  stderr = error?.stderr ?? "";
  exitCode = typeof error?.code === "number" ? error.code : 1;
}
const output = `${stdout}\n${stderr}`;
const resultLine = output.split(/\r?\n/).find(line => line.includes("DEVILUDO_E2E_RESULT:"));
if (!resultLine) throw new Error(`Godot did not emit DEVILUDO_E2E_RESULT on ${platform}\n${output.slice(-4000)}`);
const result = JSON.parse(resultLine.slice(resultLine.indexOf("DEVILUDO_E2E_RESULT:") + "DEVILUDO_E2E_RESULT:".length).trim());
if (!Array.isArray(result.checks) || !Array.isArray(result.failures) || result.failures.length || exitCode !== 0) {
  throw new Error(`Godot acceptance failed on ${platform}: ${JSON.stringify({ exitCode, failures: result.failures })}`);
}

const agent = JSON.parse(await readFile(resolve(fixture, "agent.json"), "utf8"));
const requiredChecks = agent.testManifest.features
  .filter(feature => feature.verificationMethod === "unit")
  .flatMap(feature => feature.checkNames);
const missingChecks = requiredChecks.filter(name => !result.checks.includes(name));
if (missingChecks.length) throw new Error(`Godot acceptance omitted required checks on ${platform}: ${missingChecks.join(", ")}`);

const reportPath = resolve(process.env.DEVILUDO_PLATFORM_E2E_REPORT ?? `artifacts/platform-e2e-${platform}.json`);
await mkdir(resolve(reportPath, ".."), { recursive: true });
const report = Object.freeze({
  schemaVersion: "deviludo.real-platform-acceptance.v1",
  platform,
  hostPlatform: process.platform,
  hostArchitecture: process.arch,
  godotExecutable: godot,
  godotVersion: runtimeVersion,
  commit: process.env.GITHUB_SHA ?? null,
  checks: result.checks,
  durationMs: result.duration_ms,
  acceptedAt: new Date().toISOString(),
});
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ acceptance: "passed", platform, checks: result.checks.length, reportPath })}\n`);

async function resolveCommand(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const located = await execute(locator, [command], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const first = located.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean);
  if (!first || !isAbsolute(first)) throw new Error(`Unable to resolve ${command} to an absolute executable path`);
  return first;
}
