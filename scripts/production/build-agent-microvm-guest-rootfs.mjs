#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_DATE_EPOCH_MIN = 1_577_836_800;
const OCI_REPOSITORY = "[a-z0-9][a-z0-9.-]*(?::[0-9]{2,5})?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+";
const WORKER_IMAGE = new RegExp(`^(?<repository>${OCI_REPOSITORY}):(?<tag>[A-Za-z0-9_][A-Za-z0-9._-]{0,127})@sha256:(?<digest>[a-f0-9]{64})$`);
const NODE_BASE = new RegExp(`^(?<repository>${OCI_REPOSITORY}):22\\.(?<minor>\\d+)\\.(?<patch>\\d+)-(?:bookworm|trixie)-slim@sha256:(?<digest>[a-f0-9]{64})$`);
const ROOTFS_FILE = "agent-microvm-guest.squashfs";
const RECEIPT_FILE = "agent-microvm-guest-build-receipt.json";

export function parseAgentMicrovmGuestRootfsBuildArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 20) invalid();
  const allowed = new Set(["--agent", "--exact-agent-version", "--adapter-version", "--worker-image", "--node-base-image",
    "--source-revision", "--source-date-epoch", "--mksquashfs", "--mksquashfs-digest", "--output-directory"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (values.size !== allowed.size) invalid();
  return validateAgentMicrovmGuestRootfsBuildSpec({
    agent: values.get("--agent"), exactAgentVersion: values.get("--exact-agent-version"),
    adapterVersion: values.get("--adapter-version"), workerImage: values.get("--worker-image"),
    nodeBaseImage: values.get("--node-base-image"), sourceRevision: values.get("--source-revision"),
    sourceDateEpoch: Number(values.get("--source-date-epoch")), mksquashfsExecutable: values.get("--mksquashfs"),
    mksquashfsDigest: values.get("--mksquashfs-digest"), outputDirectory: values.get("--output-directory"),
  });
}

export function validateAgentMicrovmGuestRootfsBuildSpec(input) {
  if (!plainRecord(input) || (input.agent !== "claude-code" && input.agent !== "codex-cli")
    || !fixedVersion(input.exactAgentVersion) || !fixedVersion(input.adapterVersion)
    || !SOURCE_REVISION.test(input.sourceRevision) || !absoluteValue(input.outputDirectory)
    || !absoluteValue(input.mksquashfsExecutable) || !SHA256.test(input.mksquashfsDigest)
    || !Number.isSafeInteger(input.sourceDateEpoch) || input.sourceDateEpoch < SOURCE_DATE_EPOCH_MIN
    || input.sourceDateEpoch > 4_102_444_800) invalid();
  const worker = WORKER_IMAGE.exec(input.workerImage); const node = NODE_BASE.exec(input.nodeBaseImage);
  if (!worker || !worker.groups?.repository.endsWith(`/${input.agent}`) || worker.groups.tag === "latest"
    || !node || !node.groups?.repository.endsWith("/node") || Number(node.groups.minor) < 13) invalid();
  return Object.freeze({ ...input, workerImageDigest: `sha256:${worker.groups.digest}` });
}

export function validateAgentMicrovmGuestRootfsBuildReceipt(value) {
  if (!plainRecord(value) || !exactKeys(value, [
    "schemaVersion", "status", "platformVersion", "sourceRevision", "sourceDateEpoch", "agent",
    "exactAgentVersion", "adapterVersion", "workerImage", "workerImageDigest", "nodeBaseImage",
    "rootfsFormat", "rootfsFileName", "rootfsDigest", "rootfsSizeBytes", "mksquashfsDigest",
    "mksquashfsVersion", "dockerfileDigest", "packageLockDigest", "embeddedSecrets", "selfUpdateDisabled", "completedAt",
  ]) || value.schemaVersion !== "deviludo.agent-microvm-guest-build-receipt.v1" || value.status !== "CANDIDATE"
    || !fixedVersion(value.platformVersion) || !SOURCE_REVISION.test(value.sourceRevision)
    || !Number.isSafeInteger(value.sourceDateEpoch) || value.sourceDateEpoch < SOURCE_DATE_EPOCH_MIN
    || (value.agent !== "claude-code" && value.agent !== "codex-cli") || !fixedVersion(value.exactAgentVersion)
    || !fixedVersion(value.adapterVersion) || WORKER_IMAGE.exec(value.workerImage)?.groups?.digest !== value.workerImageDigest?.slice(7)
    || !/^sha256:[a-f0-9]{64}$/.test(value.workerImageDigest) || !NODE_BASE.test(value.nodeBaseImage)
    || value.rootfsFormat !== "squashfs" || value.rootfsFileName !== ROOTFS_FILE || !SHA256.test(value.rootfsDigest)
    || !Number.isSafeInteger(value.rootfsSizeBytes) || value.rootfsSizeBytes < 1024 || value.rootfsSizeBytes > 64 * 1024 * 1024 * 1024
    || !SHA256.test(value.mksquashfsDigest) || !fixedVersion(value.mksquashfsVersion)
    || !SHA256.test(value.dockerfileDigest) || !SHA256.test(value.packageLockDigest)
    || value.embeddedSecrets !== false || value.selfUpdateDisabled !== true || !canonicalTimestamp(value.completedAt)) invalidReceipt();
  return Object.freeze({ ...value });
}

export async function buildAgentMicrovmGuestRootfs(options, {
  root = resolve("."), process = execute, now = () => new Date(), verifySource = verifyGitSource, uuid = randomUUID,
} = {}) {
  const spec = validateAgentMicrovmGuestRootfsBuildSpec(options);
  if (!absoluteValue(root) || typeof process !== "function" || typeof verifySource !== "function" || typeof uuid !== "function") invalid();
  await verifySource(root, spec.sourceRevision);
  const parent = await lstat(dirname(spec.outputDirectory));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  try { await lstat(spec.outputDirectory); invalid(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await verifyExecutable(spec.mksquashfsExecutable, spec.mksquashfsDigest);
  const [packageJsonBytes, packageLockBytes, dockerfileBytes] = await Promise.all([
    readFile(join(root, "package.json")), readFile(join(root, "package-lock.json")), readFile(join(root, "Dockerfile.agent-microvm-guest")),
  ]);
  let packageJson;
  try { packageJson = JSON.parse(packageJsonBytes); } catch { invalid(); }
  if (!fixedVersion(packageJson?.version)) invalid();
  const attempt = await mkdtemp(join(dirname(spec.outputDirectory), `.agent-microvm-guest-${uuid()}-`));
  const rootfsTree = join(attempt, "rootfs-tree"); const artifactRoot = join(attempt, "release");
  try {
    await Promise.all([mkdir(rootfsTree, { mode: 0o700 }), mkdir(artifactRoot, { mode: 0o700 })]);
    const build = await process("docker", ["buildx", "build", "--file", "Dockerfile.agent-microvm-guest",
      "--platform", "linux/amd64", "--build-arg", `NODE_BASE_IMAGE=${spec.nodeBaseImage}`,
      "--build-arg", `GUEST_BASE_IMAGE=${spec.workerImage}`, "--build-arg", `DEVILUDO_PLATFORM_VERSION=${packageJson.version}`,
      "--build-arg", `DEVILUDO_SOURCE_REVISION=${spec.sourceRevision}`, "--build-arg", `DEVILUDO_AGENT=${spec.agent}`,
      "--build-arg", `DEVILUDO_EXACT_AGENT_VERSION=${spec.exactAgentVersion}`,
      "--build-arg", `DEVILUDO_ADAPTER_VERSION=${spec.adapterVersion}`,
      "--build-arg", `SOURCE_DATE_EPOCH=${spec.sourceDateEpoch}`, "--output", `type=local,dest=${rootfsTree}`, root],
    { cwd: root, timeoutMs: 20 * 60_000, env: controlledEnvironment(root, spec.sourceDateEpoch) });
    if (build.exitCode !== 0) invalid();
    await validateExportedRootfs(rootfsTree, spec.agent);
    const version = await process(spec.mksquashfsExecutable, ["-version"], {
      cwd: attempt, timeoutMs: 30_000, env: controlledEnvironment(attempt, spec.sourceDateEpoch), allowOutput: true,
    });
    const mksquashfsVersion = parseMksquashfsVersion(`${version.stdout}\n${version.stderr}`);
    const rootfsPath = join(artifactRoot, ROOTFS_FILE);
    const squash = await process(spec.mksquashfsExecutable, [rootfsTree, rootfsPath, "-noappend", "-all-root", "-no-xattrs",
      "-no-progress", "-comp", "zstd", "-mkfs-time", String(spec.sourceDateEpoch), "-all-time", String(spec.sourceDateEpoch),
      "-root-mode", "0755"], { cwd: attempt, timeoutMs: 20 * 60_000, env: controlledEnvironment(attempt, spec.sourceDateEpoch) });
    if (squash.exitCode !== 0) invalid();
    await chmod(rootfsPath, 0o400);
    const rootfs = await hashFile(rootfsPath, 64 * 1024 * 1024 * 1024); const completedAt = now();
    if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) invalid();
    const receipt = validateAgentMicrovmGuestRootfsBuildReceipt({
      schemaVersion: "deviludo.agent-microvm-guest-build-receipt.v1", status: "CANDIDATE",
      platformVersion: packageJson.version, sourceRevision: spec.sourceRevision, sourceDateEpoch: spec.sourceDateEpoch,
      agent: spec.agent, exactAgentVersion: spec.exactAgentVersion, adapterVersion: spec.adapterVersion,
      workerImage: spec.workerImage, workerImageDigest: spec.workerImageDigest, nodeBaseImage: spec.nodeBaseImage,
      rootfsFormat: "squashfs", rootfsFileName: ROOTFS_FILE, rootfsDigest: rootfs.digest, rootfsSizeBytes: rootfs.sizeBytes,
      mksquashfsDigest: spec.mksquashfsDigest, mksquashfsVersion, dockerfileDigest: hash(dockerfileBytes),
      packageLockDigest: hash(packageLockBytes), embeddedSecrets: false, selfUpdateDisabled: true,
      completedAt: completedAt.toISOString(),
    });
    await writeFile(join(artifactRoot, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o400 });
    await rm(rootfsTree, { recursive: true, force: true });
    await rename(artifactRoot, spec.outputDirectory);
    return Object.freeze({ ...receipt, outputDirectory: spec.outputDirectory });
  } finally { await rm(attempt, { recursive: true, force: true }); }
}

async function validateExportedRootfs(root, agent) {
  const canonicalRoot = await realpath(root);
  const required = ["usr/bin/node", "bin/mount", "bin/umount", "sbin/poweroff", "sbin/deviludo-init",
    "opt/deviludo/agent-microvm-guest-service.mjs"];
  for (const relative of required) await safeExecutable(canonicalRoot, relative);
  await oneExecutable(canonicalRoot, agent === "claude-code" ? "claude" : "codex");
  const forbidden = ["root/.claude", "root/.codex", "workspace/.env", "run/deviludo-credentials/guest-runtime.json"];
  for (const relative of forbidden) { try { await lstat(join(canonicalRoot, relative)); invalid(); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
  await scanNames(canonicalRoot, canonicalRoot, 0);
}
async function oneExecutable(root, name) { for (const relative of [`usr/local/bin/${name}`, `usr/bin/${name}`]) {
  try { await safeExecutable(root, relative); return; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
} invalid(); }
async function safeExecutable(root, relative) { const canonical = await realpath(join(root, relative));
  if (!canonical.startsWith(`${root}${sep}`)) invalid(); const metadata = await stat(canonical);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) invalid(); }
async function scanNames(root, path, depth) {
  if (depth > 64) invalid();
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (/^(?:\.env|config\.vdf)$/.test(entry.name) || /(?:api[-_]?key|private[-_]?key|credentials?)\.(?:json|pem|key)$/i.test(entry.name)) invalid();
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) { const canonical = await realpath(child);
      if (!canonical.startsWith(`${root}${sep}`)) invalid(); }
    else if (entry.isDirectory()) await scanNames(root, child, depth + 1);
  }
}
async function verifyExecutable(path, expected) { const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0 || (await hashFile(path, 1024 * 1024 * 1024)).digest !== expected) invalid(); }
async function hashFile(path, maximum) { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = await file.stat(); if (!before.isFile() || before.size < 1 || before.size > maximum) invalid();
    const digest = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < before.size) { const read = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (read.bytesRead < 1) invalid(); digest.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead; }
    const after = await file.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return Object.freeze({ digest: digest.digest("hex"), sizeBytes: before.size }); } finally { await file.close(); } }
function execute(command, args, options) { return new Promise((accept) => execFile(command, args, { cwd: options.cwd, env: options.env,
  encoding: "utf8", shell: false, windowsHide: true, timeout: options.timeoutMs, maxBuffer: 2 * 1024 * 1024 },
  (error, stdout, stderr) => accept(Object.freeze({ exitCode: error ? 1 : 0, stdout, stderr })))); }
function controlledEnvironment(root, epoch) { return Object.freeze({ HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", SOURCE_DATE_EPOCH: String(epoch),
  DOCKER_BUILDKIT: "1", BUILDKIT_PROGRESS: "plain" }); }
function parseMksquashfsVersion(value) { const matched = /mksquashfs version (\d+\.\d+\.\d+)/i.exec(value);
  if (!matched || !fixedVersion(matched[1])) invalid(); return matched[1]; }
async function verifyGitSource(root, sourceRevision) { const [head, status] = await Promise.all([capture("git", ["-C", root, "rev-parse", "HEAD"]),
  capture("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"])]); if (head.trim() !== sourceRevision || status.trim()) invalid(); }
function capture(command, args) { return new Promise((accept, reject) => execFile(command, args, { encoding: "utf8", shell: false,
  windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : accept(stdout))); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function fixedVersion(value) { return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value); }
function absoluteValue(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4096 && !/[\0\r\n]/.test(value); }
function exactKeys(value, expected) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalid() { throw new Error("Agent microVM guest rootfs build input is invalid"); }
function invalidReceipt() { throw new Error("Agent microVM guest rootfs build receipt is invalid"); }

async function main() { const result = await buildAgentMicrovmGuestRootfs(parseAgentMicrovmGuestRootfsBuildArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[build:agent-microvm-guest-rootfs] build failed\n"); process.exitCode = 1; });
}
