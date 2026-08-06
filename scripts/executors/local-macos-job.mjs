#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (!["test", "clean-install"].includes(process.argv[2])) throw new Error("Unsupported local macOS E2E action");
if (!Array.isArray(request.inputs) || request.inputs.length < 1) throw new Error("E2E job has no authorized build input");
const build = [...request.inputs].reverse().find(input => input?.object?.key?.includes("godot-build")) ?? request.inputs.at(-1);
const response = await fetch(build.url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Artifact download returned ${response.status}`);
const buildContent = Buffer.from(await response.arrayBuffer());
if (buildContent.length !== build.object.sizeBytes
  || `sha256:${createHash("sha256").update(buildContent).digest("hex")}` !== build.object.sha256) {
  throw new Error("Downloaded macOS build does not match its registered artifact");
}
const directory = await mkdtemp(join(tmpdir(), "deviludo-macos-e2e-"));
try {
  const archive = join(directory, "build.tar.gz");
  const project = join(directory, "project");
  await writeFile(archive, buildContent, { mode: 0o600 });
  await execute("mkdir", ["-p", project]);
  await execute("tar", ["-xzf", archive, "-C", project], { timeout: 60_000 });
  const exportedZip = (await readdir(project)).find(name => name.endsWith(".zip"));
  if (exportedZip) await execute("unzip", ["-q", `${project}/${exportedZip}`, "-d", project], { timeout: 60_000 });
  const entries = await readdir(project, { recursive: true, withFileTypes: true });
  let executable = "";
  for (const entry of entries) {
    const candidate = `${entry.parentPath}/${entry.name}`;
    if (!entry.isFile() || !candidate.includes(".app/Contents/MacOS/")) continue;
    try { await access(candidate, constants.X_OK); executable = candidate; break; } catch { /* keep looking */ }
  }

  // Check for test manifest in agent.json
  let testManifest = null;
  let hasUnitTests = false;
  let testScriptPath = null;
  try {
    const agentJsonPath = join(project, "agent.json");
    const agentJsonContent = await readFile(agentJsonPath, "utf8");
    const agentJson = JSON.parse(agentJsonContent);
    if (agentJson.testManifest?.schemaVersion === "deviludo.test-manifest.v1" && Array.isArray(agentJson.testManifest.features)) {
      testManifest = agentJson.testManifest;
      const unitFeatures = testManifest.features.filter(f => f.verificationMethod === "unit" && f.gdsTestPath && Array.isArray(f.checkNames));
      if (unitFeatures.length > 0) {
        hasUnitTests = true;
        testScriptPath = unitFeatures[0].gdsTestPath; // Typically res://tests/e2e.gd
      }
    }
  } catch { /* agent.json may not exist or lack testManifest - fallback to legacy mode */ }

  let outcome = "PASSED";
  let failureDomain = null;
  let summary = "Godot game started and exited successfully";
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  let testDetails = null;

  if (!executable) {
    outcome = "FAILED";
    failureDomain = "PRODUCT";
    exitCode = 126;
    summary = "The macOS game artifact does not contain an executable app bundle";
    stderr = summary;
  } else if (hasUnitTests && testScriptPath) {
    // Execute test script and parse structured results
    try {
      const result = await execute(executable, ["--headless", "--script", testScriptPath], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;

      // Parse DEVILUDO_E2E_RESULT from stdout
      const resultMatch = stdout.match(/DEVILUDO_E2E_RESULT:(.+)/);
      if (resultMatch) {
        testDetails = JSON.parse(resultMatch[1]);

        // Validate that all declared checks were executed
        const declaredChecks = new Set();
        for (const feature of testManifest.features) {
          if (feature.verificationMethod === "unit" && Array.isArray(feature.checkNames)) {
            for (const checkName of feature.checkNames) {
              declaredChecks.add(checkName);
            }
          }
        }
        const executedChecks = new Set(testDetails.checks || []);
        const missingChecks = [...declaredChecks].filter(c => !executedChecks.has(c));

        if (missingChecks.length > 0) {
          outcome = "FAILED";
          failureDomain = "PRODUCT";
          summary = `Test manifest declared ${missingChecks.length} check(s) that were not executed: ${missingChecks.join(", ")}`;
        } else if (testDetails.failures && testDetails.failures.length > 0) {
          outcome = "FAILED";
          failureDomain = "PRODUCT";
          summary = `${testDetails.failures.length} feature check(s) failed: ${testDetails.failures.join(", ")}`;
        } else {
          outcome = "PASSED";
          summary = `All ${testDetails.checks.length} feature check(s) passed in ${testDetails.duration_ms.toFixed(1)}ms`;
        }
      } else {
        outcome = "FAILED";
        failureDomain = "PRODUCT";
        summary = "Test script did not output DEVILUDO_E2E_RESULT";
      }
    } catch (error) {
      if (!error || typeof error !== "object" || error.code === "ENOENT") throw error;
      outcome = "FAILED";
      failureDomain = "PRODUCT";
      exitCode = Number.isInteger(error.code) ? error.code : error.killed ? 124 : 1;
      stdout = typeof error.stdout === "string" ? error.stdout : "";
      stderr = typeof error.stderr === "string" ? error.stderr : error instanceof Error ? error.message : String(error);
      summary = error.killed
        ? "Test script did not finish before the timeout"
        : `Test script exited with code ${exitCode}`;

      // Attempt to parse partial test results
      const resultMatch = stdout.match(/DEVILUDO_E2E_RESULT:(.+)/);
      if (resultMatch) {
        try { testDetails = JSON.parse(resultMatch[1]); } catch { /* ignore */ }
      }
    }
  } else {
    // Fallback: no test manifest or no unit tests - run legacy blind execution
    try {
      const result = await execute(executable, ["--headless", "--quit-after", "120"], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code === "ENOENT") throw error;
      outcome = "FAILED";
      failureDomain = "PRODUCT";
      exitCode = Number.isInteger(error.code) ? error.code : error.killed ? 124 : 1;
      stdout = typeof error.stdout === "string" ? error.stdout : "";
      stderr = typeof error.stderr === "string" ? error.stderr : error instanceof Error ? error.message : String(error);
      summary = error.killed
        ? "The exported game did not finish its headless E2E run before the timeout"
        : `The exported game exited with code ${exitCode}`;
    }
  }
  const report = {
    schemaVersion: "deviludo.godot-guest-report.v1",
    action: process.argv[2],
    jobId: request.jobId,
    inputDigest: build.object.sha256,
    outcome,
    failureDomain,
    summary,
    guest: {
      executor: "native-macos-export",
      isolation: "DEVELOPMENT_NATIVE",
      exitCode,
      stdout: stdout.slice(-16_384),
      stderr: stderr.slice(-16_384),
    },
  };
  if (testDetails) {
    report.testDetails = testDetails;
  }
  process.stdout.write(JSON.stringify(report));
} finally {
  await rm(directory, { recursive: true, force: true });
}
