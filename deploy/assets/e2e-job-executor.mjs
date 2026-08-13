#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const action = process.argv[2];
if (!["test", "clean-install", "sign"].includes(action)) throw new Error("Unsupported E2E executor action");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (!/^[0-9a-f-]{36}$/i.test(request.jobId) || !Array.isArray(request.inputs)) throw new Error("E2E request is invalid");
const workspace = await mkdtemp(join(process.env.DEVILUDO_E2E_JOB_ROOT ?? tmpdir(), `deviludo-${request.jobId}-`));
let signedOutputReady = false;
let evidenceOutputReady = false;
try {
  const input = selectInput(request.inputs, action === "sign" ? "BUILD" : action === "test" ? "BUILD" : "PUBLISH_RECEIPT");
  const artifact = join(workspace, basename(input.object.key));
  const response = await fetch(input.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Artifact download returned ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== input.object.sha256) throw new Error("Downloaded artifact digest mismatch");
  await writeFile(artifact, content, { mode: 0o600 });
  if (action === "sign") {
    const outputPath = await signArtifact(request, artifact, workspace);
    const signed = await readFile(outputPath);
    signedOutputReady = true;
    process.stdout.write(JSON.stringify({
      schemaVersion: "deviludo.platform-sign-receipt.v1", jobId: request.jobId,
      targetPlatform: request.operatingSystem, inputDigest: input.object.sha256,
      outputPath, outputSha256: `sha256:${createHash("sha256").update(signed).digest("hex")}`,
      outputSizeBytes: signed.length,
    }));
  } else {
    const guestRunner = process.env.DEVILUDO_E2E_GUEST_RUNNER ?? "";
    if (!guestRunner.startsWith("/")) throw new Error("A fixed guest runner is required");
    const evidenceOutput = join(workspace, `e2e-evidence-${request.operatingSystem}-${request.jobId}.zip`);
    const receipt = await runJson(guestRunner, [action, "--job-id", request.jobId, "--artifact", artifact], {
      DEVILUDO_E2E_HOST_OUTPUT: evidenceOutput,
    });
    const outcome = normalizeGuestOutcome(receipt);
    const evidence = await readFile(evidenceOutput);
    const digest = `sha256:${createHash("sha256").update(evidence).digest("hex")}`;
    if (receipt.outputPath !== evidenceOutput || receipt.outputSha256 !== digest || receipt.outputSizeBytes !== evidence.length) {
      throw new Error("Guest evidence copy does not match its receipt");
    }
    evidenceOutputReady = true;
    process.stdout.write(JSON.stringify({ ...receipt, jobId: request.jobId, action, inputDigest: input.object.sha256,
      outcome: outcome.outcome, failureDomain: outcome.failureDomain, summary: outcome.summary }));
  }
} finally {
  if (!signedOutputReady && !evidenceOutputReady) await rm(workspace, { recursive: true, force: true });
}

function selectInput(inputs, kind) {
  const selected = [...inputs].reverse().find(item => item?.object?.kind === kind || item?.object?.key?.toLowerCase().includes(kind.toLowerCase().replaceAll("_", "-")));
  if (!selected?.url || !selected.object?.sha256) throw new Error(`Authorized ${kind} input is missing`);
  return selected;
}

async function signArtifact(request, artifact, workspace) {
  if (!request.grant?.wrappedToken || Date.parse(request.grant.expiresAt) <= Date.now()) throw new Error("A live signing grant is required");
  const broker = new URL(process.env.DEVILUDO_E2E_SIGNING_BROKER_URL ?? "");
  if (broker.protocol !== "https:") throw new Error("Signing broker HTTPS URL is required");
  const redeemed = await fetch(new URL("/v1/redeem", broker), {
    method: "POST", headers: { authorization: `Bearer ${request.grant.wrappedToken}`, "content-type": "application/json" },
    body: JSON.stringify({ jobId: request.jobId, platform: request.operatingSystem }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!redeemed.ok) throw new Error(`Signing broker returned ${redeemed.status}`);
  const authorization = await redeemed.json();
  if (Date.parse(authorization.expiresAt) <= Date.now() || Date.parse(authorization.expiresAt) > Date.now() + 5 * 60_000) throw new Error("Signing authorization lifetime is invalid");
  const output = join(workspace, `signed-${request.operatingSystem}.tar.gz`);
  const unpacked = join(workspace, "unpacked");
  await mkdir(unpacked, { mode: 0o700 });
  await execute("tar", ["-xzf", artifact, "-C", unpacked], { timeout: 120_000 });
  const files = await walk(unpacked);
  if (request.operatingSystem === "macos") {
    const zip = files.find(file => file.endsWith(".zip"));
    if (zip) await execute("unzip", ["-q", zip, "-d", unpacked], { timeout: 120_000 });
    const app = (await walk(unpacked)).find(file => file.endsWith(".app"));
    if (!app || typeof authorization.identity !== "string") throw new Error("macOS signing identity or app bundle is missing");
    await execute("codesign", ["--force", "--deep", "--options", "runtime", "--timestamp", "--sign", authorization.identity, app], { timeout: 300_000, env: safeSignerEnvironment(authorization.environment) });
  } else if (request.operatingSystem === "windows") {
    const executables = files.filter(file => file.toLowerCase().endsWith(".exe"));
    if (!executables.length || typeof authorization.thumbprint !== "string") throw new Error("Windows signing certificate or executable is missing");
    for (const file of executables) await execute("signtool", ["sign", "/sha1", authorization.thumbprint, "/fd", "SHA256", "/tr", authorization.timestampUrl, "/td", "SHA256", file], { timeout: 300_000, env: safeSignerEnvironment(authorization.environment) });
  } else if (request.operatingSystem === "linux") {
    if (typeof authorization.cosignKey !== "string") throw new Error("Linux signing KMS key is missing");
    const signature = join(unpacked, "deviludo-build.sig");
    await execute("cosign", ["sign-blob", "--yes", "--key", authorization.cosignKey, "--output-signature", signature, artifact], { timeout: 300_000, env: safeSignerEnvironment(authorization.environment) });
  } else throw new Error("Unsupported signing platform");
  await execute("tar", ["-czf", output, "-C", unpacked, "."], { timeout: 120_000 });
  await chmod(output, 0o600);
  return output;
}

function safeSignerEnvironment(values) {
  const allow = new Set(["PATH", "LANG", "HOME", "PKCS11_MODULE_PATH", "AWS_REGION", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE"]);
  const environment = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: tmpdir() };
  if (values && typeof values === "object") for (const [key, value] of Object.entries(values)) if (allow.has(key) && typeof value === "string") environment[key] = value;
  return environment;
}

async function walk(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.map(entry => join(entry.parentPath, entry.name));
}

function runJson(executable, arguments_, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    // JavaScript runners are source files, not platform executables. Invoke them
    // through the same trusted Node binary so a checkout that does not preserve
    // executable mode (or a freshly generated local runner) cannot fail with
    // EACCES before the guest VM is reached.
    const invocation = executable.endsWith(".mjs")
      ? { executable: process.execPath, arguments: [executable, ...arguments_] }
      : { executable, arguments: arguments_ };
    const child = spawn(invocation.executable, invocation.arguments, { stdio: ["ignore", "pipe", "pipe"], shell: false, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", ...(process.env.HOME ? { HOME: process.env.HOME } : {}), ...extraEnvironment } });
    const stdout = [], stderr = []; child.stdout.on("data", value => stdout.push(Buffer.from(value))); child.stderr.on("data", value => stderr.push(Buffer.from(value)));
    child.once("error", reject); child.once("close", code => {
      try {
        const value = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid shape");
        if (!Number.isInteger(value.exitCode)) value.exitCode = Number.isInteger(code) ? code : 1;
        resolve(value);
      } catch {
        reject(new Error(`Guest runner returned invalid JSON: ${Buffer.concat(stderr).toString("utf8").slice(0, 2000)}`));
      }
    });
  });
}

function normalizeGuestOutcome(receipt) {
  const exitCode = receipt.guest?.exitCode ?? receipt.exitCode;
  if (receipt.schemaVersion !== "deviludo.godot-guest-report.v3") throw new Error("Guest runner protocol is obsolete");
  if (receipt.outcome === "PASSED" && exitCode === 0
    && typeof receipt.summary === "string" && receipt.summary.trim()) {
    return { outcome: "PASSED", failureDomain: null, summary: receipt.summary.trim().slice(0, 2000) };
  }
  if (receipt.outcome === "FAILED" && receipt.failureDomain === "PRODUCT"
    && exitCode !== 0 && typeof receipt.summary === "string" && receipt.summary.trim()) {
    return { outcome: "FAILED", failureDomain: "PRODUCT", summary: receipt.summary.trim().slice(0, 2000) };
  }
  const diagnostic = {
    schemaVersion: receipt.schemaVersion ?? null,
    outcome: receipt.outcome ?? null,
    failureDomain: receipt.failureDomain ?? null,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    summary: typeof receipt.summary === "string" ? receipt.summary.trim().slice(0, 500) : null,
  };
  throw new Error(`Guest runner outcome contract is invalid: ${JSON.stringify(diagnostic)}`);
}
