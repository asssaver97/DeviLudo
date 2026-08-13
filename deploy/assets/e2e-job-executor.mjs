#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
const action = process.argv[2];
if (action !== "test") throw new Error("Unsupported E2E executor action");
const parentLines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const initial = await parentLines.next();
const envelope = initial.done ? null : JSON.parse(initial.value);
const request = envelope?.type === "execute" ? envelope.request : null;
if (!/^[0-9a-f-]{36}$/i.test(request.jobId) || !Array.isArray(request.inputs)) throw new Error("E2E request is invalid");
const workspace = await mkdtemp(join(process.env.DEVILUDO_E2E_JOB_ROOT ?? tmpdir(), `deviludo-${request.jobId}-`));
let evidenceOutputReady = false;
try {
  const input = selectInput(request.inputs, "BUILD");
  const artifact = join(workspace, basename(input.object.key));
  const response = await fetch(input.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Artifact download returned ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== input.object.sha256) throw new Error("Downloaded artifact digest mismatch");
  await writeFile(artifact, content, { mode: 0o600 });
  const regressionInput = selectInput(request.inputs, "E2E_REGRESSION", false);
  const regressionArtifact = regressionInput ? join(workspace, "current-e2e-regression.json") : "";
  if (regressionInput) await downloadInput(regressionInput, regressionArtifact);
  const guestRunner = process.env.DEVILUDO_E2E_GUEST_RUNNER ?? "";
  if (!guestRunner.startsWith("/")) throw new Error("A fixed guest runner is required");
  const evidenceOutput = join(workspace, `e2e-evidence-${request.operatingSystem}-${request.jobId}.zip`);
  const regressionOutput = join(workspace, `e2e-regression-${request.operatingSystem}-${request.jobId}.json`);
  const receipt = await runFramed(guestRunner, [action, "--job-id", request.jobId, "--artifact", artifact,
    ...(regressionArtifact ? ["--regression", regressionArtifact] : [])], parentLines, {
    DEVILUDO_E2E_HOST_OUTPUT: evidenceOutput,
    DEVILUDO_E2E_HOST_REGRESSION_OUTPUT: regressionOutput,
    DEVILUDO_E2E_STREAM_PROTOCOL: "1",
    DEVILUDO_E2E_PROJECT_ID: request.projectId,
    DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS: String(request.timeoutSeconds),
    DEVILUDO_E2E_CONTRACT_DIGEST: String(request.payload?.e2eContractDigest ?? ""),
  });
  const outcome = normalizeGuestOutcome(receipt);
  const evidence = await readFile(evidenceOutput);
  const digest = `sha256:${createHash("sha256").update(evidence).digest("hex")}`;
  if (receipt.outputPath !== evidenceOutput || receipt.outputSha256 !== digest || receipt.outputSizeBytes !== evidence.length) {
    throw new Error("Guest evidence copy does not match its receipt");
  }
  if (receipt.regressionOutputPath) {
    const regression = await readFile(regressionOutput);
    const regressionDigest = `sha256:${createHash("sha256").update(regression).digest("hex")}`;
    if (receipt.regressionOutputPath !== regressionOutput || receipt.regressionOutputSha256 !== regressionDigest
      || receipt.regressionOutputSizeBytes !== regression.length) throw new Error("Guest regression trace copy does not match its receipt");
  }
  evidenceOutputReady = true;
  process.stdout.write(`${JSON.stringify({ type: "result", value: { ...receipt, jobId: request.jobId, action, inputDigest: input.object.sha256,
    outcome: outcome.outcome, failureDomain: outcome.failureDomain, summary: outcome.summary } })}\n`);
} finally {
  if (!evidenceOutputReady) await rm(workspace, { recursive: true, force: true });
}

function selectInput(inputs, kind, required = true) {
  const selected = [...inputs].reverse().find(item => item?.object?.kind === kind || item?.object?.key?.toLowerCase().includes(kind.toLowerCase().replaceAll("_", "-")));
  if (!selected?.url || !selected.object?.sha256) {
    if (!required) return null;
    throw new Error(`Authorized ${kind} input is missing`);
  }
  return selected;
}

async function downloadInput(input, destination) {
  const response = await fetch(input.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Artifact download returned ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== input.object.sha256
    || content.length !== input.object.sizeBytes) throw new Error("Downloaded artifact digest mismatch");
  await writeFile(destination, content, { mode: 0o600 });
}

async function runFramed(executable, arguments_, parentIterator, extraEnvironment = {}) {
  return await new Promise((resolve, reject) => {
    // JavaScript runners are source files, not platform executables. Invoke them
    // through the same trusted Node binary so a checkout that does not preserve
    // executable mode (or a freshly generated local runner) cannot fail with
    // EACCES before the guest VM is reached.
    const invocation = executable.endsWith(".mjs")
      ? { executable: process.execPath, arguments: [executable, ...arguments_] }
      : { executable, arguments: arguments_ };
    const child = spawn(invocation.executable, invocation.arguments, { stdio: ["pipe", "pipe", "pipe"], shell: false, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", ...(process.env.HOME ? { HOME: process.env.HOME } : {}), ...extraEnvironment } });
    const stderr = []; child.stderr.on("data", value => stderr.push(Buffer.from(value)));
    let result = null;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    void (async () => {
      for await (const line of lines) {
        const message = JSON.parse(line);
        if (message?.type === "policy_request" && typeof message.id === "string") {
          process.stdout.write(`${JSON.stringify(message)}\n`);
          const next = await parentIterator.next();
          if (next.done) throw new Error("Player policy relay closed before responding");
          const response = JSON.parse(next.value);
          if (response?.type !== "policy_response" || response.id !== message.id) throw new Error("Player policy relay response is invalid");
          child.stdin.write(`${JSON.stringify(response)}\n`);
        } else if (message?.type === "result" && message.value && typeof message.value === "object") {
          result = message.value;
        }
      }
    })().catch(reject);
    child.once("error", reject); child.once("close", code => {
      if (!result || typeof result !== "object" || Array.isArray(result)) return reject(new Error(`Guest runner returned invalid framed JSON: ${Buffer.concat(stderr).toString("utf8").slice(0, 2000)}`));
      if (!Number.isInteger(result.exitCode)) result.exitCode = Number.isInteger(code) ? code : 1;
      resolve(result);
    });
  });
}

function normalizeGuestOutcome(receipt) {
  const exitCode = receipt.guest?.exitCode ?? receipt.exitCode;
  if (receipt.schema !== "deviludo.godot-guest-report" || Object.hasOwn(receipt, "schemaVersion")) throw new Error("Guest runner contract is invalid");
  if (receipt.outcome === "PASSED" && exitCode === 0
    && typeof receipt.summary === "string" && receipt.summary.trim()) {
    return { outcome: "PASSED", failureDomain: null, summary: receipt.summary.trim().slice(0, 2000) };
  }
  if (receipt.outcome === "FAILED" && receipt.failureDomain === "PRODUCT"
    && exitCode !== 0 && typeof receipt.summary === "string" && receipt.summary.trim()) {
    return { outcome: "FAILED", failureDomain: "PRODUCT", summary: receipt.summary.trim().slice(0, 2000) };
  }
  const diagnostic = {
    schema: receipt.schema ?? null,
    outcome: receipt.outcome ?? null,
    failureDomain: receipt.failureDomain ?? null,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    summary: typeof receipt.summary === "string" ? receipt.summary.trim().slice(0, 500) : null,
  };
  throw new Error(`Guest runner outcome contract is invalid: ${JSON.stringify(diagnostic)}`);
}
