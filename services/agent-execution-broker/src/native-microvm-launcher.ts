import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../runner-control/src/canonical";
import { parseNativeMicrovmAgentRequest, type NativeMicrovmAgentRequest } from "./native-microvm-contracts";
import {
  verifyConfiguredAgentMicrovmGuestRelease,
  type AgentMicrovmGuestReleaseClaims,
} from "./native-microvm-guest-release";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_NAME = /^[a-z][a-z0-9-]{2,31}$/;
const TAP_NAME = /^[a-z][a-z0-9]{0,14}$/;
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 150 * 1024 * 1024;
const MAX_SOURCE_FILES = 200_000;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;

export interface NativeMicrovmLauncherConfig {
  readonly schemaVersion: "deviludo.agent-microvm-launcher-config.v2";
  readonly backend: "firecracker-jailer";
  readonly platformVersion: string;
  readonly firecrackerVersion: string;
  readonly firecrackerExecutable: string;
  readonly firecrackerDigest: string;
  readonly jailerExecutable: string;
  readonly jailerDigest: string;
  readonly kernelImage: string;
  readonly kernelDigest: string;
  readonly rootfsImage: string;
  readonly rootfsDigest: string;
  readonly rootfsReleaseFile: string;
  readonly rootfsReleaseDigest: string;
  readonly rootfsTrustPolicyFile: string;
  readonly rootfsTrustPolicyDigest: string;
  readonly mke2fsExecutable: string;
  readonly mke2fsDigest: string;
  readonly debugfsExecutable: string;
  readonly debugfsDigest: string;
  readonly chrootBaseDirectory: string;
  readonly networkNamespaceDirectory: string;
  readonly networkNamespaceNames: readonly string[];
  readonly networkLockDirectory: string;
  readonly tapDeviceName: string;
  readonly guestMacAddress: string;
  readonly jailerUid: number;
  readonly jailerGid: number;
  readonly parentCgroup: string;
  readonly vcpuCount: number;
  readonly memoryMib: number;
  readonly dataDriveSizeMib: number;
  readonly bootArgs: string;
  readonly maxRunSeconds: number;
}

export interface NativeMicrovmLauncherProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type NativeMicrovmLauncherProcess = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; timeoutMs: number; abortSignal?: AbortSignal }>,
) => Promise<NativeMicrovmLauncherProcessResult>;

export function parseNativeMicrovmLauncherArguments(argv: readonly string[]): Readonly<{
  command: "execute" | "probe";
  configFile: string;
  requestFile?: string;
  workspace?: string;
  responseFile?: string;
  credentialImage?: string;
}> {
  if (!Array.isArray(argv) || argv.length < 4 || (argv[0] !== "execute" && argv[0] !== "probe")) invalid();
  const command = argv[0];
  const values = new Map<string, string>();
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--json") {
      if (json) invalid();
      json = true;
      continue;
    }
    const value = argv[index + 1];
    if (!new Set(["--config-file", "--request-file", "--workspace", "--response-file", "--credential-image"]).has(name)
      || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
    index += 1;
  }
  const configFile = absolute(values.get("--config-file"));
  if (command === "probe") {
    if (!json || values.size !== 1) invalid();
    return Object.freeze({ command, configFile });
  }
  if (json || values.size !== 5) invalid();
  return Object.freeze({
    command,
    configFile,
    requestFile: absolute(values.get("--request-file")),
    workspace: absolute(values.get("--workspace")),
    responseFile: absolute(values.get("--response-file")),
    credentialImage: absolute(values.get("--credential-image")),
  });
}

export function parseNativeMicrovmLauncherConfig(value: unknown): NativeMicrovmLauncherConfig {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "backend", "platformVersion", "firecrackerVersion", "firecrackerExecutable",
    "firecrackerDigest", "jailerExecutable", "jailerDigest", "kernelImage", "kernelDigest", "rootfsImage",
    "rootfsDigest", "rootfsReleaseFile", "rootfsReleaseDigest", "rootfsTrustPolicyFile",
    "rootfsTrustPolicyDigest", "mke2fsExecutable", "mke2fsDigest", "debugfsExecutable", "debugfsDigest",
    "chrootBaseDirectory", "networkNamespaceDirectory", "networkNamespaceNames", "networkLockDirectory",
    "tapDeviceName", "guestMacAddress", "jailerUid", "jailerGid", "parentCgroup", "vcpuCount",
    "memoryMib", "dataDriveSizeMib", "bootArgs", "maxRunSeconds",
  ]);
  if (body.schemaVersion !== "deviludo.agent-microvm-launcher-config.v2" || body.backend !== "firecracker-jailer"
    || !fixedVersion(body.platformVersion) || !fixedVersion(body.firecrackerVersion)
    || basename(absolute(body.firecrackerExecutable)) !== "firecracker"
    || basename(absolute(body.jailerExecutable)) !== "jailer"
    || basename(absolute(body.mke2fsExecutable)) !== "mke2fs"
    || basename(absolute(body.debugfsExecutable)) !== "debugfs") invalid();
  const digestNames = ["firecrackerDigest", "jailerDigest", "kernelDigest", "rootfsDigest", "rootfsReleaseDigest",
    "rootfsTrustPolicyDigest", "mke2fsDigest", "debugfsDigest"];
  if (digestNames.some((name) => typeof body[name] !== "string" || !SHA256.test(body[name] as string))) invalid();
  const namespaces = body.networkNamespaceNames;
  if (!Array.isArray(namespaces) || namespaces.length < 1 || namespaces.length > 256
    || namespaces.some((name) => typeof name !== "string" || !SAFE_NAME.test(name))
    || new Set(namespaces).size !== namespaces.length
    || JSON.stringify(namespaces) !== JSON.stringify([...namespaces].sort())) invalid();
  if (typeof body.tapDeviceName !== "string" || !TAP_NAME.test(body.tapDeviceName)
    || typeof body.guestMacAddress !== "string" || !MAC.test(body.guestMacAddress)
    || typeof body.parentCgroup !== "string" || !SAFE_NAME.test(body.parentCgroup)
    || typeof body.bootArgs !== "string" || !validBootArgs(body.bootArgs)) invalid();
  const config = {
    ...body,
    firecrackerExecutable: absolute(body.firecrackerExecutable),
    jailerExecutable: absolute(body.jailerExecutable),
    kernelImage: absolute(body.kernelImage),
    rootfsImage: absolute(body.rootfsImage),
    rootfsReleaseFile: absolute(body.rootfsReleaseFile),
    rootfsTrustPolicyFile: absolute(body.rootfsTrustPolicyFile),
    mke2fsExecutable: absolute(body.mke2fsExecutable),
    debugfsExecutable: absolute(body.debugfsExecutable),
    chrootBaseDirectory: runtimeDirectory(body.chrootBaseDirectory, "/var/lib/deviludo/"),
    networkNamespaceDirectory: exactPath(body.networkNamespaceDirectory, "/run/netns"),
    networkNamespaceNames: Object.freeze([...(namespaces as string[])]),
    networkLockDirectory: runtimeDirectory(body.networkLockDirectory, "/run/lock/deviludo-"),
    jailerUid: integer(body.jailerUid, 1, 65_535),
    jailerGid: integer(body.jailerGid, 1, 65_535),
    vcpuCount: integer(body.vcpuCount, 1, 32),
    memoryMib: integer(body.memoryMib, 512, 65_536),
    dataDriveSizeMib: integer(body.dataDriveSizeMib, 512, 65_536),
    maxRunSeconds: integer(body.maxRunSeconds, 60, 86_400),
  } as unknown as NativeMicrovmLauncherConfig;
  const firstMacOctet = Number.parseInt(config.guestMacAddress.slice(0, 2), 16);
  if (config.jailerUid === 0 || config.jailerGid === 0 || (firstMacOctet & 1) !== 0) invalid();
  return deepFreeze(config);
}

export function compileFirecrackerConfiguration(
  config: NativeMicrovmLauncherConfig,
): Readonly<Record<string, unknown>> {
  return deepFreeze({
    "boot-source": { kernel_image_path: "/kernel", boot_args: config.bootArgs },
    drives: [
      { drive_id: "rootfs", path_on_host: "/rootfs.squashfs", is_root_device: true, is_read_only: true },
      { drive_id: "deviludo-data", path_on_host: "/data.ext4", is_root_device: false, is_read_only: false },
      { drive_id: "deviludo-credentials", path_on_host: "/credentials.ext4", is_root_device: false, is_read_only: true },
    ],
    "machine-config": { vcpu_count: config.vcpuCount, mem_size_mib: config.memoryMib, smt: false, track_dirty_pages: false },
    "network-interfaces": [{ iface_id: "agent-egress", guest_mac: config.guestMacAddress, host_dev_name: config.tapDeviceName }],
  });
}

export function compileJailerArguments(config: NativeMicrovmLauncherConfig, id: string, namespacePath: string): readonly string[] {
  if (!/^[a-z0-9-]{8,64}$/.test(id) || !namespacePath.startsWith(`${config.networkNamespaceDirectory}${sep}`)) invalid();
  return Object.freeze([
    "--id", id,
    "--exec-file", config.firecrackerExecutable,
    "--uid", String(config.jailerUid),
    "--gid", String(config.jailerGid),
    "--chroot-base-dir", config.chrootBaseDirectory,
    "--netns", namespacePath,
    "--cgroup-version", "2",
    "--parent-cgroup", config.parentCgroup,
    "--resource-limit", `fsize=${config.dataDriveSizeMib * 1024 * 1024}`,
    "--resource-limit", "no-file=1024",
    "--new-pid-ns",
    "--",
    "--config-file", "/machine-config.json",
  ]);
}

export class FirecrackerNativeMicrovmLauncher {
  readonly #configFile: string;
  readonly #process: NativeMicrovmLauncherProcess;
  readonly #uuid: () => string;

  constructor(options: Readonly<{
    configFile: string;
    process?: NativeMicrovmLauncherProcess;
    uuid?: () => string;
  }>) {
    this.#configFile = absolute(options.configFile);
    this.#process = options.process ?? executeLockedProcess;
    this.#uuid = options.uuid ?? randomUUID;
  }

  async probe(): Promise<Readonly<{ schemaVersion: string; status: "READY"; configDigest: string }>> {
    linuxRoot();
    const { config, digest } = await this.#verifiedConfiguration();
    await Promise.all([
      privateDirectory(config.chrootBaseDirectory, false),
      privateDirectory(config.networkLockDirectory, true),
      directory(config.networkNamespaceDirectory),
      device("/dev/kvm"),
      ...config.networkNamespaceNames.map((name) => namespace(join(config.networkNamespaceDirectory, name))),
    ]);
    return Object.freeze({ schemaVersion: "deviludo.native-agent-microvm-probe.v1", status: "READY", configDigest: digest });
  }

  async execute(input: Readonly<{
    requestFile: string;
    workspace: string;
    responseFile: string;
    credentialImage: string;
    abortSignal?: AbortSignal;
  }>): Promise<void> {
    linuxRoot();
    const requestFile = absolute(input.requestFile);
    const workspace = absolute(input.workspace);
    const responseFile = absolute(input.responseFile);
    const credentialImage = absolute(input.credentialImage);
    const runRoot = dirname(dirname(requestFile));
    if (requestFile !== join(runRoot, "control", "request.json") || workspace !== join(runRoot, "workspace")
      || responseFile !== join(runRoot, "control", "response.json") || dirname(responseFile) !== dirname(requestFile)
      || credentialImage !== join(runRoot, "control", "credentials.ext4")) invalid();
    if (await realpath(runRoot) !== runRoot || await realpath(dirname(requestFile)) !== dirname(requestFile)) invalid();
    const request = await readRequest(requestFile);
    await verifyCredentialImage(credentialImage);
    await assertWorkspace(workspace);
    await absent(responseFile);
    const { config, guestRelease } = await this.#verifiedConfiguration();
    assertAgentMicrovmGuestIdentity(guestRelease, request);
    const lease = await acquireNamespace(config);
    const id = launcherId(request, this.#uuid());
    const jailRoot = join(config.chrootBaseDirectory, "firecracker", id, "root");
    const staging = await mkdtemp(join(runRoot, ".microvm-stage-"));
    try {
      await prepareDataRoot(staging, requestFile, workspace);
      const dataImage = join(staging, "data.ext4");
      await createDataImage(config, staging, dataImage, this.#process, input.abortSignal);
      await stageJail(config, jailRoot, dataImage, credentialImage);
      const result = await this.#process(config.jailerExecutable, compileJailerArguments(config, id, lease.namespacePath), {
        cwd: runRoot,
        timeoutMs: config.maxRunSeconds * 1_000,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      if (result.exitCode !== 0) invalid();
      const extracted = join(staging, "response.json");
      commandSafePath(extracted);
      const extraction = await this.#process(config.debugfsExecutable,
        ["-R", `dump /control/response.json ${extracted}`, join(jailRoot, "data.ext4")],
        { cwd: staging, timeoutMs: 60_000, ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}) });
      if (extraction.exitCode !== 0) invalid();
      const response = await boundedJsonFile(extracted, MAX_RESPONSE_BYTES);
      assertResponseIdentity(response, request);
      await publishResponse(extracted, responseFile);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(dirname(jailRoot), { recursive: true, force: true });
      await lease.release();
    }
  }

  async #verifiedConfiguration(): Promise<Readonly<{ config: NativeMicrovmLauncherConfig; digest: string;
    guestRelease: AgentMicrovmGuestReleaseClaims }>> {
    const bytes = await boundedFile(this.#configFile, MAX_JSON_BYTES);
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
    const config = parseNativeMicrovmLauncherConfig(value);
    await Promise.all([
      verifyFile(config.firecrackerExecutable, config.firecrackerDigest, 1024 * 1024 * 1024, true),
      verifyFile(config.jailerExecutable, config.jailerDigest, 1024 * 1024 * 1024, true),
      verifyFile(config.kernelImage, config.kernelDigest, 1024 * 1024 * 1024, false),
      verifyFile(config.rootfsImage, config.rootfsDigest, 64 * 1024 * 1024 * 1024, false),
      verifyFile(config.mke2fsExecutable, config.mke2fsDigest, 1024 * 1024 * 1024, true),
      verifyFile(config.debugfsExecutable, config.debugfsDigest, 1024 * 1024 * 1024, true),
    ]);
    const guestRelease = await verifyConfiguredAgentMicrovmGuestRelease({
      releaseFile: config.rootfsReleaseFile, releaseDigest: config.rootfsReleaseDigest,
      trustPolicyFile: config.rootfsTrustPolicyFile, trustPolicyDigest: config.rootfsTrustPolicyDigest,
      platformVersion: config.platformVersion, rootfsDigest: config.rootfsDigest,
    });
    return Object.freeze({ config, digest: createHash("sha256").update(bytes).digest("hex"), guestRelease });
  }
}

async function createDataImage(config: NativeMicrovmLauncherConfig, staging: string, path: string,
  process: NativeMicrovmLauncherProcess, abortSignal?: AbortSignal): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.truncate(config.dataDriveSizeMib * 1024 * 1024); await file.sync(); }
  finally { await file.close(); }
  const result = await process(config.mke2fsExecutable,
    ["-q", "-t", "ext4", "-F", "-d", join(staging, "payload"), "-L", "deviludo-data", path],
    { cwd: staging, timeoutMs: 5 * 60_000, ...(abortSignal ? { abortSignal } : {}) });
  if (result.exitCode !== 0) invalid();
}

async function stageJail(config: NativeMicrovmLauncherConfig, root: string, dataImage: string, credentialImage: string): Promise<void> {
  await absent(dirname(root));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all([
    lockedCopy(config.kernelImage, join(root, "kernel"), 0o444),
    lockedCopy(config.rootfsImage, join(root, "rootfs.squashfs"), 0o444),
    lockedCopy(dataImage, join(root, "data.ext4"), 0o600),
    lockedCopy(credentialImage, join(root, "credentials.ext4"), 0o400),
    writeFile(join(root, "machine-config.json"), `${canonicalJson(compileFirecrackerConfiguration(config))}\n`, { flag: "wx", mode: 0o444 }),
  ]);
  await chown(join(root, "data.ext4"), config.jailerUid, config.jailerGid);
  await chown(join(root, "credentials.ext4"), config.jailerUid, config.jailerGid);
}

async function prepareDataRoot(staging: string, requestFile: string, workspace: string): Promise<void> {
  const payload = join(staging, "payload");
  await mkdir(join(payload, "control"), { recursive: true, mode: 0o700 });
  await lockedCopy(requestFile, join(payload, "control", "request.json"), 0o400);
  await copyTree(workspace, join(payload, "workspace"));
}

async function copyTree(source: string, destination: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const visit = async (from: string, to: string): Promise<void> => {
    const metadata = await lstat(from);
    if (metadata.isSymbolicLink()) invalid();
    if (metadata.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      const entries = await readdir(from, { withFileTypes: true });
      entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
      for (const entry of entries) {
        if (!entry.name || entry.name === "." || entry.name === ".." || entry.name.includes("\0")) invalid();
        await visit(join(from, entry.name), join(to, entry.name));
      }
      return;
    }
    if (!metadata.isFile() || ++files > MAX_SOURCE_FILES || (bytes += metadata.size) > MAX_SOURCE_BYTES) invalid();
    await lockedCopy(from, to, metadata.mode & 0o111 ? 0o500 : 0o400);
  };
  await visit(source, destination);
}

async function acquireNamespace(config: NativeMicrovmLauncherConfig): Promise<Readonly<{
  namespacePath: string;
  release(): Promise<void>;
}>> {
  await privateDirectory(config.networkLockDirectory, true);
  for (const name of config.networkNamespaceNames) {
    const namespacePath = join(config.networkNamespaceDirectory, name);
    await namespace(namespacePath);
    const lockPath = join(config.networkLockDirectory, `${name}.lock`);
    try {
      const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await lock.writeFile(`${process.pid}\n`, "utf8"); await lock.sync(); }
      finally { await lock.close(); }
      return Object.freeze({ namespacePath, async release() { await rm(lockPath); } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  invalid();
}

function launcherId(request: NativeMicrovmAgentRequest, entropy: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(entropy)) invalid();
  return `dl-${request.attemptId.replaceAll("-", "").slice(0, 12)}-${entropy.replaceAll("-", "").slice(0, 12)}`;
}

async function readRequest(path: string): Promise<NativeMicrovmAgentRequest> {
  const value = await boundedJsonFile(path, MAX_JSON_BYTES);
  return parseNativeMicrovmAgentRequest(value);
}

async function boundedJsonFile(path: string, maximum: number): Promise<unknown> {
  const bytes = await boundedFile(path, maximum);
  try { return JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
}

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > maximum || (before.mode & 0o022) !== 0) invalid();
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return bytes;
  } finally { await file.close(); }
}

async function verifyFile(path: string, digest: string, maximum: number, executable: boolean): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum || (before.mode & 0o022) !== 0
      || (executable && (before.mode & 0o111) === 0)) invalid();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, before.size - offset), offset);
      if (bytesRead < 1) invalid();
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || hash.digest("hex") !== digest) invalid();
  } finally { await file.close(); }
}

async function verifyCredentialImage(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 128 * 1024 || metadata.size > 64 * 1024 * 1024
      || (metadata.mode & 0o377) !== 0) invalid();
    const magic = Buffer.alloc(2); const read = await file.read(magic, 0, 2, 1024 + 56);
    if (read.bytesRead !== 2 || magic.readUInt16LE(0) !== 0xef53) invalid();
  } finally { await file.close(); }
}

async function lockedCopy(source: string, destination: string, mode: number): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, mode);
}

async function publishResponse(source: string, destination: string): Promise<void> {
  const bytes = await boundedFile(source, MAX_RESPONSE_BYTES);
  const file = await open(destination, "wx", 0o400);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
}

function assertResponseIdentity(value: unknown, request: NativeMicrovmAgentRequest): void {
  const body = record(value);
  if (body.runId !== request.runId || body.attemptId !== request.attemptId
    || (body.status !== "COMPLETED" && body.status !== "FAILED")) invalid();
}

export function assertAgentMicrovmGuestIdentity(release: AgentMicrovmGuestReleaseClaims,
  request: Pick<NativeMicrovmAgentRequest, "agent" | "exactAgentVersion" | "adapterVersion" | "imageDigest">): void {
  if (release.agent !== request.agent || release.exactAgentVersion !== request.exactAgentVersion
    || release.adapterVersion !== request.adapterVersion || release.workerImageDigest !== request.imageDigest) invalid();
}

async function assertWorkspace(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(path) !== path) invalid();
}

async function absent(path: string): Promise<void> {
  try { await lstat(path); invalid(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function directory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(path) !== path) invalid();
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  await directory(path);
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) invalid();
}

async function namespace(path: string): Promise<void> {
  const metadata = await lstat(path);
  if ((!metadata.isFile() && !metadata.isSocket()) || metadata.isSymbolicLink()) invalid();
}

async function device(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isCharacterDevice() || metadata.isSymbolicLink()) invalid();
}

export function executeLockedProcess(executable: string, args: readonly string[], options: Readonly<{
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}>): Promise<NativeMicrovmLauncherProcessResult> {
  return new Promise((accept) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: { NODE_ENV: "production", LANG: "C.UTF-8", PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as ChildProcess;
    let stdout = "";
    let stderr = "";
    let finished = false;
    const append = (current: string, chunk: Buffer): string => {
      const next = `${current}${chunk.toString("utf8")}`;
      return next.slice(0, 256 * 1024);
    };
    if (!child.stdout || !child.stderr) {
      child.kill("SIGKILL");
      accept(Object.freeze({ exitCode: 1, stdout: "", stderr: "" }));
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const terminate = () => {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
    };
    const timer = setTimeout(terminate, options.timeoutMs);
    const abort = () => terminate();
    options.abortSignal?.addEventListener("abort", abort, { once: true });
    if (options.abortSignal?.aborted) terminate();
    const finish = (exitCode: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.abortSignal?.removeEventListener("abort", abort);
      accept(Object.freeze({ exitCode, stdout, stderr }));
    };
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code === 0 ? 0 : 1));
  });
}

function validBootArgs(value: string): boolean {
  if (value.length < 1 || value.length > 2048 || /[\0\r\n'"`$;&|<>]/.test(value)) return false;
  const tokens = value.split(" ");
  if (tokens.some((token) => !token || !/^[A-Za-z0-9._=,:/-]+$/.test(token))) return false;
  const required = ["reboot=k", "panic=1", "pci=off", "8250.nr_uarts=0", "root=/dev/vda", "rootfstype=squashfs", "ro"];
  return required.every((token) => tokens.includes(token))
    && tokens.some((token) => token.startsWith("ip="))
    && !tokens.some((token) => token.startsWith("init=") || token.startsWith("rdinit=") || token.startsWith("metadata=")
      || token === "rw" || token.startsWith("rootflags="));
}

function linuxRoot(): void {
  if (process.platform !== "linux" || typeof process.geteuid !== "function" || process.geteuid() !== 0) invalid();
}

function commandSafePath(value: string): string {
  if (!/^[A-Za-z0-9/._-]+$/.test(value)) invalid();
  return value;
}

function fixedVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value);
}

function absolute(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.length > 4096 || /[\0\r\n]/.test(value)) invalid();
  return value;
}

function runtimeDirectory(value: unknown, prefix: string): string {
  const path = absolute(value);
  if (!path.startsWith(prefix) || path === prefix.slice(0, -1)) invalid();
  return path;
}

function exactPath(value: unknown, expected: string): string {
  const path = absolute(value);
  if (path !== expected) invalid();
  return path;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(): never { throw new Error("Native Agent microVM launcher input is invalid"); }

async function main(): Promise<void> {
  const args = parseNativeMicrovmLauncherArguments(process.argv.slice(2));
  const launcher = new FirecrackerNativeMicrovmLauncher({ configFile: args.configFile });
  if (args.command === "probe") {
    process.stdout.write(`${canonicalJson(await launcher.probe())}\n`);
    return;
  }
  await launcher.execute({ requestFile: args.requestFile as string, workspace: args.workspace as string,
    responseFile: args.responseFile as string, credentialImage: args.credentialImage as string });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[agent-microvm-launcher] execution failed\n");
    process.exitCode = 1;
  });
}
