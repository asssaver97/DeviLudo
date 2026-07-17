import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { canonicalJson, sha256Canonical } from "./canonical";
import type { RunnerJobPayload } from "./contracts";
import {
  type PhysicalRunnerExecutionOutput,
  type PhysicalRunnerExecutor,
  validatePhysicalRunnerExecutionOutput,
} from "./physical-runner";

const SHA256 = /^[a-f0-9]{64}$/;
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){1,5}$/;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;

export interface TestKitProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TestKitProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type TestKitProcess = (
  executable: string,
  args: readonly string[],
  options: TestKitProcessOptions,
) => Promise<TestKitProcessResult>;

interface TestKitRunRequest {
  readonly schemaVersion: "deviludo.testkit-run-request.v1";
  readonly jobDigest: string;
  readonly testKitDigest: string;
  readonly godot: Readonly<{
    executable: string;
    binaryDigest: string;
    version: string;
  }>;
  readonly job: RunnerJobPayload;
}

/**
 * Executes one platform-owned TestKit controller with no shell and no
 * project-controlled argv. The controller owns artifact download/upload and
 * emits only content-addressed evidence metadata to this process.
 */
export class LockedTestKitExecutor implements PhysicalRunnerExecutor {
  readonly #testKitExecutable: string;
  readonly #testKitDigest: string;
  readonly #godotExecutable: string;
  readonly #godotBinaryDigest: string;
  readonly #godotVersion: string;
  readonly #workRoot: string;
  readonly #timeoutMs: number;
  readonly #process: TestKitProcess;
  readonly #hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #now: () => Date;

  constructor(options: {
    readonly testKitExecutable: string;
    readonly testKitDigest: string;
    readonly godotExecutable: string;
    readonly godotBinaryDigest: string;
    readonly godotVersion: string;
    readonly workRoot: string;
    readonly timeoutMs?: number;
    readonly process?: TestKitProcess;
    readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly now?: () => Date;
  }) {
    this.#testKitExecutable = absolutePath(options.testKitExecutable, "TestKit executable");
    this.#godotExecutable = absolutePath(options.godotExecutable, "Godot executable");
    this.#workRoot = absolutePath(options.workRoot, "TestKit work root");
    if (!SHA256.test(options.testKitDigest) || !SHA256.test(options.godotBinaryDigest)
      || !EXACT_VERSION.test(options.godotVersion)) {
      throw new Error("Physical Runner TestKit lock is invalid");
    }
    this.#testKitDigest = options.testKitDigest;
    this.#godotBinaryDigest = options.godotBinaryDigest;
    this.#godotVersion = options.godotVersion;
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 30 * 60_000, 1_000, 4 * 60 * 60_000);
    this.#process = options.process ?? execTestKitProcess;
    this.#hostEnvironment = options.hostEnvironment ?? process.env;
    this.#now = options.now ?? (() => new Date());
  }

  async execute(job: RunnerJobPayload): Promise<PhysicalRunnerExecutionOutput> {
    if (job.godotTestKitDigest !== this.#testKitDigest
      || job.requiredGodotVersion !== this.#godotVersion) {
      throw new Error("Physical Runner job does not match the installed TestKit lock");
    }
    const [observedTestKit, observedGodot] = await Promise.all([
      digestRegularFile(this.#testKitExecutable),
      digestRegularFile(this.#godotExecutable),
    ]);
    if (observedTestKit !== this.#testKitDigest || observedGodot !== this.#godotBinaryDigest) {
      throw new Error("Physical Runner executable integrity check failed");
    }

    const root = await prepareDirectory(this.#workRoot);
    const runDirectory = await prepareDirectory(join(root, job.attemptId, String(job.fencingToken)), root);
    const home = await prepareDirectory(join(runDirectory, "home"), root);
    const temporary = await prepareDirectory(join(runDirectory, "tmp"), root);
    const requestPath = join(runDirectory, "request.json");
    const outputPath = join(runDirectory, "result.json");
    const jobDigest = sha256Canonical(job);
    const request: TestKitRunRequest = Object.freeze({
      schemaVersion: "deviludo.testkit-run-request.v1",
      jobDigest,
      testKitDigest: this.#testKitDigest,
      godot: Object.freeze({
        executable: this.#godotExecutable,
        binaryDigest: this.#godotBinaryDigest,
        version: this.#godotVersion,
      }),
      job,
    });
    await materializeImmutableJson(requestPath, request);
    const cached = await readOptionalJson(outputPath);
    if (cached !== null) return parseResult(cached, request, this.#now());

    const result = await this.#process(this.#testKitExecutable, [
      "run",
      "--request-file", requestPath,
      "--output-file", outputPath,
    ], {
      cwd: runDirectory,
      env: minimalEnvironment(this.#hostEnvironment, home, temporary),
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0
      || Buffer.byteLength(result.stdout) > MAX_PROCESS_OUTPUT_BYTES
      || Buffer.byteLength(result.stderr) > MAX_PROCESS_OUTPUT_BYTES) {
      throw new Error("Physical Runner TestKit controller failed");
    }
    const output = await readOptionalJson(outputPath);
    if (output === null) throw new Error("Physical Runner TestKit controller did not produce a result");
    return parseResult(output, request, this.#now());
  }

  async probe(): Promise<void> {
    const [observedTestKit, observedGodot] = await Promise.all([
      digestRegularFile(this.#testKitExecutable),
      digestRegularFile(this.#godotExecutable),
    ]);
    if (observedTestKit !== this.#testKitDigest || observedGodot !== this.#godotBinaryDigest) {
      throw new Error("Physical Runner executable integrity check failed");
    }
    await prepareDirectory(this.#workRoot);
  }
}

export function execTestKitProcess(
  executable: string,
  args: readonly string[],
  options: TestKitProcessOptions,
): Promise<TestKitProcessResult> {
  return new Promise((resolve) => {
    execFile(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      shell: false,
    }, (error, stdout, stderr) => {
      resolve(Object.freeze({
        exitCode: error ? (typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
          ? (error as NodeJS.ErrnoException & { code: number }).code : 1) : 0,
        stdout,
        stderr,
      }));
    });
  });
}

async function digestRegularFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_EXECUTABLE_BYTES) {
    throw new Error("Physical Runner executable is invalid");
  }
  const file = await open(path, "r");
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size !== metadata.size) throw new Error("Physical Runner executable changed during verification");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, opened.size - position), position);
      if (bytesRead < 1) throw new Error("Physical Runner executable changed during verification");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error("Physical Runner executable changed during verification");
    }
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

async function prepareDirectory(path: string, boundary?: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Physical Runner TestKit directory is invalid");
  if (boundary && canonical !== boundary && !canonical.startsWith(`${boundary}${sep}`)) {
    throw new Error("Physical Runner TestKit directory escaped its root");
  }
  if (process.platform !== "win32") await chmod(canonical, 0o700);
  return canonical;
}

async function materializeImmutableJson(path: string, value: unknown): Promise<void> {
  const encoded = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(encoded) > MAX_CONTROL_FILE_BYTES) throw new Error("Physical Runner TestKit request is too large");
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(encoded, { encoding: "utf8" });
      await file.sync();
    } finally {
      await file.close();
    }
    if (process.platform !== "win32") await chmod(path, 0o400);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readRequiredJson(path);
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error("Physical Runner TestKit request conflicts with an existing attempt");
    }
  }
}

async function readOptionalJson(path: string): Promise<unknown | null> {
  try {
    return await readRequiredJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readRequiredJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_CONTROL_FILE_BYTES) {
    throw new Error("Physical Runner TestKit control file is invalid");
  }
  const file = await open(path, "r");
  try {
    return JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown;
  } finally {
    await file.close();
  }
}

function parseResult(value: unknown, request: TestKitRunRequest, now: Date): PhysicalRunnerExecutionOutput {
  const body = object(value);
  exactKeys(body, ["schemaVersion", "jobDigest", "testKitDigest", "godotBinaryDigest", "evidence"]);
  if (body.schemaVersion !== "deviludo.testkit-run-result.v1"
    || body.jobDigest !== request.jobDigest || body.testKitDigest !== request.testKitDigest
    || body.godotBinaryDigest !== request.godot.binaryDigest) {
    throw new Error("Physical Runner TestKit result binding is invalid");
  }
  const evidence = object(body.evidence) as unknown as PhysicalRunnerExecutionOutput;
  validatePhysicalRunnerExecutionOutput(evidence);
  const observed = now.getTime();
  const created = Date.parse(evidence.createdAt);
  if (!Number.isFinite(observed) || created > observed + 5 * 60_000) {
    throw new Error("Physical Runner TestKit result timestamp is invalid");
  }
  return Object.freeze({ ...evidence });
}

function minimalEnvironment(
  host: Readonly<Record<string, string | undefined>>,
  home: string,
  temporary: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  };
  for (const name of ["LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"] as const) {
    const value = host[name];
    if (value !== undefined && !value.includes("\0")) result[name] = value;
  }
  return result;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error("Physical Runner TestKit result fields are invalid");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Physical Runner TestKit returned invalid JSON");
  }
  return value as Record<string, unknown>;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) {
    throw new Error(`Physical Runner ${label} path is invalid`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("Physical Runner TestKit timeout is invalid");
  }
  return value;
}
