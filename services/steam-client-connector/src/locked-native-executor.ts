import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import type { GodotCommandEvidence } from "../../godot-testkit/src/godot-driver";
import type {
  SteamClientNativeExecutionResult,
  SteamClientNativeExecutor,
} from "./connector";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const FORBIDDEN_OUTPUT = /config\.vdf|steam.?guard|branch.?password|account.?password|refresh.?token/i;

export interface NativeBridgeProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type NativeBridgeProcess = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
) => Promise<NativeBridgeProcessResult>;

/** Fixed argv/file adapter for one signed OS-specific Steam bridge artifact. */
export class LockedNativeSteamClientExecutor implements SteamClientNativeExecutor {
  readonly #executable: string;
  readonly #executableDigest: string;
  readonly #workRoot: string;
  readonly #timeoutMs: number;
  readonly #process: NativeBridgeProcess;

  constructor(options: Readonly<{
    executable: string;
    executableDigest: string;
    workRoot: string;
    timeoutMs?: number;
    process?: NativeBridgeProcess;
  }>) {
    this.#executable = absolutePath(options.executable, "executable");
    if (!SHA256.test(options.executableDigest)) throw new Error("Native Steam bridge digest is invalid");
    this.#executableDigest = options.executableDigest;
    this.#workRoot = absolutePath(options.workRoot, "work root");
    this.#timeoutMs = integer(options.timeoutMs ?? 50 * 60_000, 30_000, 60 * 60_000);
    this.#process = options.process ?? execNativeBridge;
  }

  async probe(): Promise<void> {
    await Promise.all([verifyExecutable(this.#executable, this.#executableDigest), verifyDirectory(this.#workRoot)]);
    const probeRoot = join(this.#workRoot, "probe");
    await mkdir(probeRoot, { recursive: true, mode: 0o700 });
    const result = await this.#process(this.#executable, ["probe", "--json"], {
      cwd: probeRoot,
      env: controlledEnvironment(probeRoot),
      timeoutMs: Math.min(this.#timeoutMs, 30_000),
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0 || result.stderr || FORBIDDEN_OUTPUT.test(result.stdout)) invalid("probe");
    let body: unknown;
    try { body = JSON.parse(result.stdout); }
    catch { invalid("probe"); }
    const value = record(body);
    exactKeys(value, ["schemaVersion", "status"]);
    if (value.schemaVersion !== "deviludo.native-steam-client-probe.v1" || value.status !== "READY") invalid("probe");
  }

  async execute(input: Parameters<SteamClientNativeExecutor["execute"]>[0]): Promise<SteamClientNativeExecutionResult> {
    if (!SHA256.test(input.executionId)) invalid("execution id");
    await Promise.all([verifyExecutable(this.#executable, this.#executableDigest), verifyDirectory(this.#workRoot)]);
    const runRoot = join(this.#workRoot, input.executionId);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const requestPath = join(runRoot, "request.json");
    const responsePath = join(runRoot, "response.json");
    await writeImmutable(requestPath, Buffer.from(canonicalJson(input)));
    const replay = await readResponseIfPresent(responsePath, runRoot);
    if (replay) return replay;
    const result = await this.#process(this.#executable, [
      "execute", "--request-file", requestPath, "--response-file", responsePath,
    ], {
      cwd: runRoot,
      env: controlledEnvironment(runRoot),
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0 || FORBIDDEN_OUTPUT.test(`${result.stdout}\n${result.stderr}`)) invalid("execution");
    const response = await readResponseIfPresent(responsePath, runRoot);
    if (!response) invalid("missing response");
    return response;
  }
}

export function execNativeBridge(
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
): Promise<NativeBridgeProcessResult> {
  return new Promise((resolve) => {
    execFile(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      shell: false,
    }, (error, stdout, stderr) => resolve(Object.freeze({
      exitCode: error ? 1 : 0,
      stdout: bounded(stdout),
      stderr: bounded(stderr),
    })));
  });
}

async function readResponseIfPresent(path: string, root: string): Promise<SteamClientNativeExecutionResult | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 8 * 1024 * 1024) invalid("response file");
    const [canonical, boundary] = await Promise.all([realpath(path), realpath(root)]);
    if (!canonical.startsWith(`${boundary}${sep}`)) invalid("response boundary");
    return parseResponse(JSON.parse(await readFile(canonical, "utf8")) as unknown);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseResponse(value: unknown): SteamClientNativeExecutionResult {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "installRoot", "appManifestPath", "harnessRoot", "harnessResultPath", "logsPath", "commands"]);
  if (body.schemaVersion !== "deviludo.native-steam-clean-install-result.v2") invalid("response");
  for (const key of ["installRoot", "appManifestPath", "harnessRoot", "harnessResultPath", "logsPath"] as const) {
    if (typeof body[key] !== "string" || !isAbsolute(body[key] as string) || resolve(body[key] as string) !== body[key]) invalid("response");
  }
  if (!Array.isArray(body.commands)) invalid("response");
  return Object.freeze({
    installRoot: body.installRoot as string,
    appManifestPath: body.appManifestPath as string,
    harnessRoot: body.harnessRoot as string,
    harnessResultPath: body.harnessResultPath as string,
    logsPath: body.logsPath as string,
    commands: Object.freeze(body.commands.map((command) => Object.freeze(record(command)) as unknown as GodotCommandEvidence)),
  });
}

async function verifyExecutable(path: string, expectedDigest: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 1024 * 1024 * 1024) invalid("executable");
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, metadata.size - position), position);
      if (bytesRead < 1) invalid("executable");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || hash.digest("hex") !== expectedDigest) invalid("executable digest");
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
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== value.byteLength) invalid("request replay");
    if (!(await readFile(path)).equals(value)) invalid("request replay");
  }
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

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) throw new Error(`Native Steam bridge ${label} is invalid`);
  return value;
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalid("timeout");
  return value;
}

function bounded(value: string): string {
  return value.length <= MAX_OUTPUT_BYTES ? value : value.slice(0, MAX_OUTPUT_BYTES);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("response");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid("response fields");
}

function invalid(label: string): never {
  throw new Error(`Native Steam bridge ${label} is invalid`);
}
