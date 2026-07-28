#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Canonical } from "../../services/runner-control/src/canonical.ts";
import { verifyAgentExecutionWorkerNativeRuntime } from "../../services/agent-execution-broker/src/native-worker-release.ts";
import { verifyAgentMicrovmWorkerRuntimeFromEnv } from "../../services/agent-execution-broker/src/run-native-worker.ts";
import {
  agentExecutionWorkerBindingFromEnv,
  assertAgentExecutionWorkerGuestBinding,
} from "../../services/agent-execution-broker/src/worker-binding.ts";
import { parseNativeMicrovmLauncherConfig } from "../../services/agent-execution-broker/src/native-microvm-launcher.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const UNIT_PATH = "/etc/systemd/system/deviludo-agent-execution-worker.service";
const SERVICE_ID = "deviludo-agent-execution-worker.service";

export function parseAgentHostDeploymentArguments(argv) {
  if (!Array.isArray(argv) || !new Set([4, 5]).has(argv.length)) invalid();
  const applyIndex = argv.indexOf("--apply");
  const filtered = applyIndex < 0 ? argv : argv.filter((_, index) => index !== applyIndex);
  if (filtered.length !== 4 || filtered[0] !== "--config" || filtered[2] !== "--config-digest"
    || !SHA256.test(filtered[3])) invalid();
  return Object.freeze({ apply: applyIndex >= 0, configPath: absolute(filtered[1]), configDigest: filtered[3] });
}

export function validateAgentHostDeploymentConfig(value) {
  const keys = ["environmentFile", "environmentFileDigest", "receiptPath", "schemaVersion"];
  if (!record(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
    || value.schemaVersion !== "deviludo.agent-worker-host-deployment.v1" || !SHA256.test(value.environmentFileDigest)) invalid();
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    environmentFile: absolute(value.environmentFile),
    environmentFileDigest: value.environmentFileDigest,
    receiptPath: absolute(value.receiptPath),
  });
}

export function parseAgentWorkerEnvironment(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_ENV_BYTES || bytes.includes(0)) invalid();
  const env = Object.create(null);
  for (const raw of bytes.toString("utf8").split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("="); if (separator < 1) invalid();
    const name = line.slice(0, separator); const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]{1,159}$/.test(name) || Object.hasOwn(env, name) || /[\0\r\n]/.test(value)) invalid();
    env[name] = value;
  }
  if (env.NODE_ENV !== "production") invalid();
  return Object.freeze(env);
}

export async function deployAgentWorkerHost(options, dependencies = {}) {
  const configBytes = await boundedFile(options.configPath, MAX_CONFIG_BYTES, false);
  if (sha256(configBytes) !== options.configDigest) throw new Error("Agent host deployment configuration digest does not match");
  let configValue; try { configValue = JSON.parse(configBytes.toString("utf8")); } catch { invalid(); }
  const config = validateAgentHostDeploymentConfig(configValue);
  const envBytes = await boundedFile(config.environmentFile, MAX_ENV_BYTES, true);
  if (sha256(envBytes) !== config.environmentFileDigest) throw new Error("Agent Worker environment digest does not match");
  const env = parseAgentWorkerEnvironment(envBytes);
  const verifyNative = dependencies.verifyNative ?? verifyAgentExecutionWorkerNativeRuntime;
  const verifyMicrovm = dependencies.verifyMicrovm ?? verifyAgentMicrovmWorkerRuntimeFromEnv;
  const loadBinding = dependencies.loadBinding ?? agentExecutionWorkerBindingFromEnv;
  const host = dependencies.host ?? new NodeAgentWorkerSystemdHost();
  const now = dependencies.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) invalid();
  const artifactPath = absolute(env.DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_ARTIFACT_FILE);
  if (/\s/.test(artifactPath) || /\s/.test(config.environmentFile)) invalid();
  const [nativeRelease, microvmRuntime, loadedBinding] = await Promise.all([
    verifyNative(env, { executedPath: artifactPath, now }), verifyMicrovm(env, now), loadBinding(env), host.preflight(env),
  ]);
  if (!nativeRelease || !microvmRuntime?.launcher || !microvmRuntime?.guest || !loadedBinding) invalid();
  const binding = assertAgentExecutionWorkerGuestBinding(loadedBinding, microvmRuntime.guest);
  const unit = renderAgentWorkerSystemdUnit(artifactPath, config.environmentFile);
  const unitDigest = sha256(Buffer.from(unit));
  const plan = Object.freeze({
    schemaVersion: "deviludo.agent-worker-host-deployment-plan.v1",
    deploymentConfigDigest: options.configDigest,
    serviceId: SERVICE_ID,
    unitPath: UNIT_PATH,
    unitDigest,
    environmentFile: config.environmentFile,
    environmentFileDigest: config.environmentFileDigest,
    artifactPath,
    artifactDigest: env.DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_ARTIFACT_DIGEST,
    launcherReleaseId: microvmRuntime.launcher.releaseId,
    guestReleaseId: microvmRuntime.guest.releaseId,
    workerPool: binding.workerPool,
    installationIds: Object.freeze([...binding.installationIds]),
  });
  if (!options.apply) return Object.freeze({ applied: false, plan });
  const receipt = await actuateAgentWorker(plan, unit, config.receiptPath, host, now);
  if (receipt.state !== "SERVICE_STARTED") throw new Error("Agent Worker deployment rolled back");
  return Object.freeze({ applied: true, plan, receipt });
}

export function renderAgentWorkerSystemdUnit(artifactPath, environmentFile) {
  for (const value of [artifactPath, environmentFile]) if (!absolute(value) || /[\s%]/.test(value)) invalid();
  return [
    "[Unit]", "Description=DeviLudo isolated Agent execution Worker", "After=network-online.target",
    "Wants=network-online.target", "", "[Service]", "Type=simple", "User=root", "Group=root",
    `ExecStart=${artifactPath}`, `EnvironmentFile=${environmentFile}`, "Restart=on-failure", "RestartSec=5s",
    "UMask=0077", "NoNewPrivileges=true", "PrivateTmp=true", "ProtectHome=true", "ProtectSystem=strict",
    "ProtectKernelLogs=true", "ProtectClock=true", "RestrictSUIDSGID=true", "LockPersonality=true",
    "DevicePolicy=closed", "DeviceAllow=/dev/kvm rw", "ReadWritePaths=/var/lib/deviludo /run/netns /run/lock/deviludo-agent-microvms /sys/fs/cgroup",
    "CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_NET_ADMIN CAP_SETGID CAP_SETUID CAP_SYS_ADMIN CAP_SYS_CHROOT",
    "LimitNOFILE=65536", "", "[Install]", "WantedBy=multi-user.target", "",
  ].join("\n");
}

async function actuateAgentWorker(plan, unit, outputPath, host, now) {
  const existingReceipt = await optionalJson(outputPath);
  if (existingReceipt !== null) return validateReceipt(existingReceipt, plan);
  const journalPath = `${outputPath}.journal`;
  const interrupted = await optionalJson(journalPath);
  if (interrupted !== null) {
    const journal = validateJournal(interrupted, plan);
    await restore(host, journal.previousUnit);
    const receipt = createReceipt(plan, "ROLLED_BACK", "RECOVER_INTERRUPTED_DEPLOYMENT", now.toISOString());
    await createOnlyJson(outputPath, receipt); await rm(journalPath, { force: true }); return receipt;
  }
  const previous = await host.readUnit(UNIT_PATH);
  const previousUnit = previous === null ? null : Object.freeze({
    bodyBase64: previous.toString("base64"), digest: sha256(previous),
  });
  await createOnlyJson(journalPath, createJournal(plan, previousUnit, now.toISOString()));
  let failure = null;
  try {
    await host.writeUnit(UNIT_PATH, Buffer.from(unit)); await host.run("/usr/bin/systemctl", ["daemon-reload"]);
    await host.run("/usr/bin/systemctl", ["enable", SERVICE_ID]);
    await host.run("/usr/bin/systemctl", ["restart", SERVICE_ID]);
    const active = await host.run("/usr/bin/systemctl", ["is-active", "--quiet", SERVICE_ID], { allowFailure: true });
    if (active.exitCode !== 0) throw new Error("Agent Worker service did not become active");
  } catch {
    failure = "SERVICE_ACTIVATION_FAILED"; await restore(host, previousUnit);
  }
  const receipt = createReceipt(plan, failure === null ? "SERVICE_STARTED" : "ROLLED_BACK", failure, now.toISOString());
  await createOnlyJson(outputPath, receipt); await rm(journalPath, { force: true }); return receipt;
}

async function restore(host, previousUnit) {
  await host.run("/usr/bin/systemctl", ["stop", SERVICE_ID], { allowFailure: true });
  if (previousUnit === null) {
    await host.run("/usr/bin/systemctl", ["disable", SERVICE_ID], { allowFailure: true });
    if (await host.readUnit(UNIT_PATH) !== null) await host.removeUnit(UNIT_PATH);
  } else {
    const body = Buffer.from(previousUnit.bodyBase64, "base64");
    if (sha256(body) !== previousUnit.digest) invalid(); await host.writeUnit(UNIT_PATH, body);
  }
  await host.run("/usr/bin/systemctl", ["daemon-reload"]);
  if (previousUnit !== null) await host.run("/usr/bin/systemctl", ["restart", SERVICE_ID]);
}

export class NodeAgentWorkerSystemdHost {
  async preflight(env) {
    if (process.platform !== "linux" || typeof process.geteuid !== "function") invalid();
    const configPath = absolute(env.DEVILUDO_AGENT_MICROVM_CONFIG_FILE);
    const configBytes = await boundedFile(configPath, MAX_CONFIG_BYTES, false);
    let configValue; try { configValue = JSON.parse(configBytes.toString("utf8")); } catch { invalid(); }
    const config = parseNativeMicrovmLauncherConfig(configValue);
    const [kvm, cgroup, systemctl, chroot, namespaces, locks, ...namespaceHandles] = await Promise.all([
      lstat("/dev/kvm"), lstat("/sys/fs/cgroup/cgroup.controllers"), lstat("/usr/bin/systemctl"),
      lstat(config.chrootBaseDirectory), lstat(config.networkNamespaceDirectory), lstat(config.networkLockDirectory),
      ...config.networkNamespaceNames.map((name) => lstat(join(config.networkNamespaceDirectory, name))),
    ]);
    if (!kvm.isCharacterDevice() || !cgroup.isFile() || !systemctl.isFile() || systemctl.isSymbolicLink()) invalid();
    if (![chroot, namespaces, locks].every((metadata) => metadata.isDirectory() && !metadata.isSymbolicLink())
      || (locks.mode & 0o077) !== 0 || namespaceHandles.some((metadata) => !metadata.isFile() || metadata.isSymbolicLink())) invalid();
  }
  async readUnit(path) { try { const metadata = await lstat(path); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CONFIG_BYTES) invalid(); return readFile(path); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
  async writeUnit(path, body) { const parent = await lstat(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
    const temporary = `${path}.${process.pid}.tmp`; let created = false; try { const file = await open(temporary, "wx", 0o400); created = true;
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); } await chmod(temporary, 0o444); await rename(temporary, path); created = false;
    } finally { if (created) await rm(temporary, { force: true }); } }
  async removeUnit(path) { await unlink(path); }
  async run(command, args, { allowFailure = false } = {}) { const result = await fixedCommand(command, args); if (!allowFailure && result.exitCode !== 0) throw new Error("Agent Worker fixed host action failed"); return result; }
}

function createJournal(plan, previousUnit, preparedAt) { const core = Object.freeze({ schemaVersion: "deviludo.agent-worker-host-deployment-journal.v1",
  state: "PREPARED", unitDigest: plan.unitDigest, environmentFileDigest: plan.environmentFileDigest, previousUnit, preparedAt });
  return Object.freeze({ ...core, journalDigest: sha256Canonical(core) }); }
function validateJournal(value, plan) { if (!record(value) || value.schemaVersion !== "deviludo.agent-worker-host-deployment-journal.v1"
  || value.state !== "PREPARED" || value.unitDigest !== plan.unitDigest || value.environmentFileDigest !== plan.environmentFileDigest) invalid();
  const core = { ...value }; delete core.journalDigest; if (value.journalDigest !== sha256Canonical(core)) invalid(); return value; }
function createReceipt(plan, state, failureCode, completedAt) { const core = Object.freeze({ schemaVersion: "deviludo.agent-worker-host-deployment-receipt.v1",
  state, deploymentConfigDigest: plan.deploymentConfigDigest, unitDigest: plan.unitDigest,
  environmentFileDigest: plan.environmentFileDigest, artifactDigest: plan.artifactDigest,
  launcherReleaseId: plan.launcherReleaseId, guestReleaseId: plan.guestReleaseId, workerPool: plan.workerPool, failureCode, completedAt });
  return Object.freeze({ ...core, receiptDigest: sha256Canonical(core) }); }
function validateReceipt(value, plan) { if (!record(value) || value.schemaVersion !== "deviludo.agent-worker-host-deployment-receipt.v1"
  || !new Set(["SERVICE_STARTED", "ROLLED_BACK"]).has(value.state) || value.unitDigest !== plan.unitDigest
  || value.deploymentConfigDigest !== plan.deploymentConfigDigest || value.environmentFileDigest !== plan.environmentFileDigest
  || value.artifactDigest !== plan.artifactDigest
  || value.launcherReleaseId !== plan.launcherReleaseId || value.guestReleaseId !== plan.guestReleaseId || value.workerPool !== plan.workerPool) invalid();
  const core = { ...value }; delete core.receiptDigest; if (value.receiptDigest !== sha256Canonical(core)) invalid(); return Object.freeze({ ...value }); }
function fixedCommand(command, args) { if (command !== "/usr/bin/systemctl" || !Array.isArray(args)
  || args.some((value) => typeof value !== "string" || !value || /[\0\r\n]/.test(value))) invalid();
  return new Promise((accept, reject) => { const child = spawn(command, args, { shell: false, stdio: "ignore", env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000); child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); if (signal !== null || !Number.isInteger(code)) reject(new Error("Agent Worker host action failed"));
      else accept(Object.freeze({ exitCode: code })); }); }); }
async function boundedFile(path, maximum, privateFile) { const metadata = await lstat(path); if (!metadata.isFile() || metadata.isSymbolicLink()
  || metadata.size < 2 || metadata.size > maximum || (metadata.mode & (privateFile ? 0o077 : 0o022)) !== 0) invalid(); return readFile(path); }
async function optionalJson(path) { try { const bytes = await boundedFile(path, MAX_CONFIG_BYTES, false); return JSON.parse(bytes.toString("utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function createOnlyJson(path, value) { const parent = await lstat(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  try { const file = await open(path, "wx", 0o400); try { await file.writeFile(`${canonicalJson(value)}\n`); await file.sync(); } finally { await file.close(); } }
  catch (error) { if (error?.code !== "EEXIST") throw error; const existing = await optionalJson(path); if (canonicalJson(existing) !== canonicalJson(value)) invalid(); } }
function absolute(value) { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value)) invalid(); return value; }
function record(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function invalid() { throw new Error("Agent Worker host deployment input is invalid"); }

async function main() { if (process.env.NODE_ENV !== "production") invalid(); const options = parseAgentHostDeploymentArguments(process.argv.slice(2));
  if (options.apply && (typeof process.getuid !== "function" || process.getuid() !== 0)) throw new Error("Agent Worker apply requires root");
  const result = await deployAgentWorkerHost(options); process.stdout.write(`${JSON.stringify(result)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { main().catch((error) => {
  process.stderr.write(`[deploy:agent-host] ${error instanceof Error ? error.message : "deployment failed"}\n`); process.exitCode = 1; }); }
