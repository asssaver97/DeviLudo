import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import type {
  AgentSupplyChainNativeExecutor,
  AgentSupplyChainOperationResult,
  AgentSupplyChainRequest,
  AgentSupplyChainResponse,
} from "./contracts";
import { AgentSupplyChainTerminalError } from "./broker-service";
import { isAgentSupplyChainTerminalFailure, validateAgentSupplyChainOperationResult } from "./request-contract";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_OUTPUT = /api.?key|authorization|bearer|password|secret|token|vault:\/\/|registry.?credential/i;
const TERMINAL_POLICY_EXIT_CODE = 42;

export interface NativeAgentSupplyChainProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type NativeAgentSupplyChainProcess = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
) => Promise<NativeAgentSupplyChainProcessResult>;

/** Fixed argv/file boundary for the signed OCI builder, scanner and deployer artifact. */
export class LockedNativeAgentSupplyChainExecutor implements AgentSupplyChainNativeExecutor {
  readonly #executable: string;
  readonly #executableDigest: string;
  readonly #configFile: string;
  readonly #configDigest: string;
  readonly #workRoot: string;
  readonly #timeoutMs: number;
  readonly #process: NativeAgentSupplyChainProcess;

  constructor(options: Readonly<{
    executable: string;
    executableDigest: string;
    configFile: string;
    configDigest: string;
    workRoot: string;
    timeoutMs?: number;
    process?: NativeAgentSupplyChainProcess;
  }>) {
    this.#executable = absolutePath(options.executable, "executable");
    this.#configFile = absolutePath(options.configFile, "configuration file");
    this.#workRoot = absolutePath(options.workRoot, "work root");
    if (!SHA256.test(options.executableDigest) || !SHA256.test(options.configDigest)) invalid("artifact digest");
    this.#executableDigest = options.executableDigest;
    this.#configDigest = options.configDigest;
    this.#timeoutMs = integer(options.timeoutMs ?? 8 * 60_000, 30_000, 9 * 60_000);
    this.#process = options.process ?? executeNativeAgentSupplyChain;
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
    if (body.schemaVersion !== "deviludo.native-agent-supply-chain-probe.v1"
      || body.status !== "READY" || body.configDigest !== this.#configDigest) invalid("probe");
  }

  async execute(request: AgentSupplyChainRequest): Promise<AgentSupplyChainResponse> {
    await this.#verifyRuntime();
    const runRoot = join(this.#workRoot, request.operationKey);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const requestPath = join(runRoot, "request.json");
    const responsePath = join(runRoot, "response.json");
    await writeImmutable(requestPath, Buffer.from(canonicalJson(request)));
    const replay = await readResultIfPresent(responsePath, runRoot, request);
    if (replay) {
      if (isAgentSupplyChainTerminalFailure(replay)) throw new AgentSupplyChainTerminalError(replay);
      return replay;
    }
    const result = await this.#process(this.#executable, [
      command(request), "--config-file", this.#configFile,
      "--request-file", requestPath, "--response-file", responsePath,
    ], processOptions(runRoot, this.#timeoutMs));
    if (result.stdout || result.stderr || FORBIDDEN_OUTPUT.test(`${result.stdout}\n${result.stderr}`)) invalid("execution output");
    const response = await readResultIfPresent(responsePath, runRoot, request);
    if (result.exitCode === TERMINAL_POLICY_EXIT_CODE) {
      if (!response || !isAgentSupplyChainTerminalFailure(response)) invalid("terminal failure");
      throw new AgentSupplyChainTerminalError(response);
    }
    if (result.exitCode !== 0 || !response || isAgentSupplyChainTerminalFailure(response)) invalid("execution");
    return response;
  }

  async #verifyRuntime(): Promise<void> {
    await Promise.all([
      verifyFile(this.#executable, this.#executableDigest, 1024 * 1024 * 1024, true),
      verifyFile(this.#configFile, this.#configDigest, 1024 * 1024),
      verifyDirectory(this.#workRoot),
    ]);
  }
}

export function executeNativeAgentSupplyChain(
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
): Promise<NativeAgentSupplyChainProcessResult> {
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
      exitCode: nativeExitCode(error),
      stdout: bounded(stdout),
      stderr: bounded(stderr),
    })));
  });
}

function command(request: AgentSupplyChainRequest): string {
  switch (request.schemaVersion) {
    case "deviludo.agent-version-discovery-request.v1": return "discover-version";
    case "deviludo.agent-version-validation-request.v1": return "validate-version";
    case "deviludo.agent-installation-build-request.v1": return "build-installation";
    case "deviludo.agent-installation-rollout-request.v1": return "rollout-installation";
  }
}

async function readResultIfPresent(
  path: string,
  root: string,
  request: AgentSupplyChainRequest,
): Promise<AgentSupplyChainOperationResult | null> {
  try {
    const [canonical, boundary] = await Promise.all([realpath(path), realpath(root)]);
    if (!canonical.startsWith(`${boundary}${sep}`)) invalid("response boundary");
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size < 2 || before.size > MAX_RESPONSE_BYTES) invalid("response file");
      const contents = await file.readFile({ encoding: "utf8" });
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid("response mutation");
      return validateAgentSupplyChainOperationResult(JSON.parse(contents) as unknown, request);
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function verifyFile(path: string, expectedDigest: string, maximumBytes: number, executable = false): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes
    || executable && (metadata.mode & 0o111) === 0) invalid("runtime file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || hash.digest("hex") !== expectedDigest) invalid("runtime digest");
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

function processOptions(root: string, timeoutMs: number) {
  return Object.freeze({ cwd: root, env: controlledEnvironment(root), timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES });
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
    DISABLE_UPDATES: "1",
  });
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4096 || /\0/.test(value)) invalid(label);
  return value;
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalid("timeout");
  return value;
}

function bounded(value: string): string { return value.length <= MAX_OUTPUT_BYTES ? value : value.slice(0, MAX_OUTPUT_BYTES); }
function nativeExitCode(error: Error | null): number {
  if (!error) return 0;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) && code > 0 && code <= 255 ? code : 1;
}
function parseJson(value: string): Record<string, unknown> { try { return record(JSON.parse(value) as unknown); } catch { invalid("JSON"); } }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid("response"); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid("response fields"); }
function invalid(label: string): never { throw new Error(`Native Agent supply-chain ${label} is invalid`); }
