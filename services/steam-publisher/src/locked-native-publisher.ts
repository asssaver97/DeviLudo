import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import type { SteamPipeConnector, SteamPipeUploadReceipt } from "./contracts";
import type { SteamDefaultBranchConnector } from "./workflow-broker-executor";

const SHA256 = /^[a-f0-9]{64}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const MAX_OUTPUT_BYTES = 256 * 1024;
const FORBIDDEN_OUTPUT = /config\.vdf|steam.?guard|branch.?password|account.?password|refresh.?token|vault:\/\//i;

export interface NativeSteamPublisherProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type NativeSteamPublisherProcess = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
) => Promise<NativeSteamPublisherProcessResult>;

type UploadInput = Parameters<SteamPipeConnector["uploadPrivateBeta"]>[0];
type PromotionInput = Parameters<SteamDefaultBranchConnector["promote"]>[0];
type PromotionReceipt = Awaited<ReturnType<SteamDefaultBranchConnector["promote"]>>;

/** Fixed argv/file adapter for the audited native SteamPipe publisher artifact. */
export class LockedNativeSteamPublisherConnector implements SteamPipeConnector, SteamDefaultBranchConnector {
  readonly #executable: string;
  readonly #executableDigest: string;
  readonly #configFile: string;
  readonly #configDigest: string;
  readonly #workRoot: string;
  readonly #timeoutMs: number;
  readonly #process: NativeSteamPublisherProcess;

  constructor(options: Readonly<{
    executable: string;
    executableDigest: string;
    configFile: string;
    configDigest: string;
    workRoot: string;
    timeoutMs?: number;
    process?: NativeSteamPublisherProcess;
  }>) {
    this.#executable = absolutePath(options.executable, "executable");
    this.#configFile = absolutePath(options.configFile, "configuration file");
    this.#workRoot = absolutePath(options.workRoot, "work root");
    if (!SHA256.test(options.executableDigest) || !SHA256.test(options.configDigest)) invalid("artifact digest");
    this.#executableDigest = options.executableDigest;
    this.#configDigest = options.configDigest;
    this.#timeoutMs = integer(options.timeoutMs ?? 55 * 60_000, 30_000, 60 * 60_000);
    this.#process = options.process ?? executeNativePublisher;
  }

  async probe(): Promise<void> {
    await this.#verifyRuntime();
    const probeRoot = join(this.#workRoot, "probe");
    await mkdir(probeRoot, { recursive: true, mode: 0o700 });
    const result = await this.#process(this.#executable, [
      "probe", "--config-file", this.#configFile, "--json",
    ], processOptions(probeRoot, Math.min(this.#timeoutMs, 30_000)));
    if (result.exitCode !== 0 || result.stderr || FORBIDDEN_OUTPUT.test(result.stdout)) invalid("probe");
    const body = parseJson(result.stdout);
    exactKeys(body, ["schemaVersion", "status", "configDigest"]);
    if (body.schemaVersion !== "deviludo.native-steam-publisher-probe.v1" || body.status !== "READY"
      || body.configDigest !== this.#configDigest) invalid("probe");
  }

  async uploadPrivateBeta(input: UploadInput): Promise<SteamPipeUploadReceipt> {
    validateUploadInput(input);
    const response = await this.#execute("upload", input.requestDigest, {
      schemaVersion: "deviludo.native-steam-private-beta-request.v1",
      ...input,
    });
    return parseUploadReceipt(response, input);
  }

  async promote(input: PromotionInput): Promise<PromotionReceipt> {
    validatePromotionInput(input);
    const response = await this.#execute("publish", input.requestDigest, {
      schemaVersion: "deviludo.native-steam-default-branch-request.v1",
      ...input,
    });
    return parsePromotionReceipt(response, input);
  }

  async #execute(kind: "upload" | "publish", requestDigest: string, request: Readonly<Record<string, unknown>>) {
    await this.#verifyRuntime();
    const runRoot = join(this.#workRoot, `${kind}-${requestDigest}`);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const requestPath = join(runRoot, "request.json");
    const responsePath = join(runRoot, "response.json");
    await writeImmutable(requestPath, Buffer.from(canonicalJson(request)));
    const replay = await readJsonIfPresent(responsePath, runRoot);
    if (replay) return replay;
    const command = kind === "upload" ? "upload-private-beta" : "publish-default-branch";
    const result = await this.#process(this.#executable, [
      command,
      "--config-file", this.#configFile,
      "--request-file", requestPath,
      "--response-file", responsePath,
    ], processOptions(runRoot, this.#timeoutMs));
    if (result.exitCode !== 0 || result.stdout || result.stderr
      || FORBIDDEN_OUTPUT.test(`${result.stdout}\n${result.stderr}`)) invalid("execution");
    const response = await readJsonIfPresent(responsePath, runRoot);
    if (!response) invalid("missing response");
    return response;
  }

  async #verifyRuntime(): Promise<void> {
    await Promise.all([
      verifyFile(this.#executable, this.#executableDigest, 1024 * 1024 * 1024),
      verifyFile(this.#configFile, this.#configDigest, 1024 * 1024),
      verifyDirectory(this.#workRoot),
    ]);
  }
}

export function executeNativePublisher(
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
): Promise<NativeSteamPublisherProcessResult> {
  return new Promise((accept) => {
    execFile(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      shell: false,
    }, (error, stdout, stderr) => accept(Object.freeze({
      exitCode: error ? 1 : 0,
      stdout: bounded(stdout),
      stderr: bounded(stderr),
    })));
  });
}

function validateUploadInput(input: UploadInput): void {
  if (!SHA256.test(input.requestDigest) || !input.operationKey || !BRANCH.test(input.betaBranch)
    || input.betaBranch === "default" || input.betaBranch === "public"
    || !/^vault:\/\/[A-Za-z0-9._~:/-]{2,500}$/.test(input.branchPasswordSecretRef)
    || !/^vault:\/\/[A-Za-z0-9._~:/-]{2,500}$/.test(input.session.configVdfSecretRef)) invalid("upload request");
}

function validatePromotionInput(input: PromotionInput): void {
  if (!SHA256.test(input.requestDigest) || !input.operationKey || !NUMERIC_ID.test(input.steamAppId)
    || !NUMERIC_ID.test(input.betaBuildId) || !SHA256.test(input.steamInstallEvidenceBundleDigest)
    || input.externalApprovalIds.length !== 3 || new Set(input.externalApprovalIds).size !== 3
    || !/^vault:\/\/[A-Za-z0-9._~:/-]{2,500}$/.test(input.session.configVdfSecretRef)) invalid("publication request");
}

function parseUploadReceipt(value: unknown, input: UploadInput): SteamPipeUploadReceipt {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "steamAppId", "buildId", "betaBranch", "passwordProtected", "depotManifestIds", "uploadedAt"]);
  if (body.schemaVersion !== "deviludo.native-steam-private-beta-receipt.v1"
    || body.steamAppId !== input.rc.steamAppId || typeof body.buildId !== "string" || !NUMERIC_ID.test(body.buildId)
    || body.betaBranch !== input.betaBranch || body.passwordProtected !== true
    || typeof body.uploadedAt !== "string" || !Number.isFinite(Date.parse(body.uploadedAt))) invalid("upload receipt");
  const depots = numericMap(body.depotManifestIds);
  const expected = input.rc.depots.map((depot) => depot.depotId).sort();
  if (JSON.stringify(Object.keys(depots).sort()) !== JSON.stringify(expected)) invalid("upload receipt depots");
  return Object.freeze({
    steamAppId: body.steamAppId,
    buildId: body.buildId,
    betaBranch: body.betaBranch,
    passwordProtected: true,
    depotManifestIds: depots,
    uploadedAt: body.uploadedAt,
  });
}

function parsePromotionReceipt(value: unknown, input: PromotionInput): PromotionReceipt {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "releaseId", "steamAppId", "betaBuildId", "defaultBranchBuildId", "publishedAt"]);
  if (body.schemaVersion !== "deviludo.native-steam-default-branch-receipt.v1"
    || body.releaseId !== input.releaseId || body.steamAppId !== input.steamAppId
    || body.betaBuildId !== input.betaBuildId || body.defaultBranchBuildId !== input.betaBuildId
    || typeof body.publishedAt !== "string" || !Number.isFinite(Date.parse(body.publishedAt))) invalid("publication receipt");
  return Object.freeze({
    releaseId: body.releaseId,
    steamAppId: body.steamAppId,
    betaBuildId: body.betaBuildId,
    defaultBranchBuildId: body.defaultBranchBuildId,
    publishedAt: body.publishedAt,
  });
}

async function verifyFile(path: string, expectedDigest: string, maximumBytes: number): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes) invalid("runtime file");
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, metadata.size - position), position);
      if (bytesRead < 1) invalid("runtime file");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || hash.digest("hex") !== expectedDigest) {
      invalid("runtime file digest");
    }
  } finally { await file.close(); }
}

async function verifyDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("work root");
}

async function writeImmutable(path: string, value: Buffer): Promise<void> {
  try { await writeFile(path, value, { flag: "wx", mode: 0o400 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== value.byteLength
      || !(await readFile(path)).equals(value)) invalid("request replay");
  }
}

async function readJsonIfPresent(path: string, root: string): Promise<Record<string, unknown> | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 1024 * 1024) invalid("response file");
    const [canonical, boundary] = await Promise.all([realpath(path), realpath(root)]);
    if (!canonical.startsWith(`${boundary}${sep}`)) invalid("response boundary");
    return parseJson(await readFile(canonical, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function numericMap(value: unknown): Readonly<Record<string, string>> {
  const body = record(value);
  const entries = Object.entries(body);
  if (!entries.length || entries.length > 3) invalid("manifest map");
  const result: Record<string, string> = {};
  for (const [depotId, manifestId] of entries) {
    if (!NUMERIC_ID.test(depotId) || typeof manifestId !== "string" || !NUMERIC_ID.test(manifestId)) invalid("manifest map");
    result[depotId] = manifestId;
  }
  return Object.freeze(result);
}

function processOptions(root: string, timeoutMs: number) {
  return Object.freeze({
    cwd: root,
    env: controlledEnvironment(root),
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
}

function controlledEnvironment(root: string): NodeJS.ProcessEnv {
  return Object.freeze({
    NODE_ENV: "production",
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    LANG: "C.UTF-8",
  });
}

function parseJson(value: string): Record<string, unknown> {
  try { return record(JSON.parse(value) as unknown); }
  catch { invalid("JSON"); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("fields");
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) {
    throw new Error(`Native Steam publisher ${label} is invalid`);
  }
  return value;
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalid("timeout");
  return value;
}

function bounded(value: string): string {
  return value.length <= MAX_OUTPUT_BYTES ? value : value.slice(0, MAX_OUTPUT_BYTES);
}

function invalid(label: string): never {
  throw new Error(`Native Steam publisher ${label} is invalid`);
}
