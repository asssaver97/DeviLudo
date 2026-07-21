import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import {
  STEAM_DEPOT_SIGNING_SCHEMES,
  validateSteamDepotFinalizationReceipt,
} from "./contract";
import type {
  SteamDepotFinalizationReceipt,
  SteamDepotFinalizationRequest,
  SteamDepotNativeFinalizer,
} from "./contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const FORBIDDEN_OUTPUT = /api.?key|authorization|bearer|password|secret|token|config\.vdf|certificate.?bytes|private.?key/i;

export interface NativeSteamDepotProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type NativeSteamDepotProcess = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
) => Promise<NativeSteamDepotProcessResult>;

/**
 * Executes only one digest-pinned native signing controller. Signing keys stay
 * in the host keystore/HSM selected by the immutable policy file.
 */
export class LockedNativeSteamDepotFinalizer implements SteamDepotNativeFinalizer {
  readonly #executable: string;
  readonly #executableDigest: string;
  readonly #policyFile: string;
  readonly #policyDigest: string;
  readonly #workRoot: string;
  readonly #timeoutMs: number;
  readonly #process: NativeSteamDepotProcess;

  constructor(options: Readonly<{
    executable: string;
    executableDigest: string;
    policyFile: string;
    policyDigest: string;
    workRoot: string;
    timeoutMs?: number;
    process?: NativeSteamDepotProcess;
  }>) {
    this.#executable = absolutePath(options.executable, "executable");
    this.#policyFile = absolutePath(options.policyFile, "policy file");
    this.#workRoot = absolutePath(options.workRoot, "work root");
    if (!SHA256.test(options.executableDigest) || !SHA256.test(options.policyDigest)) invalid("artifact digest");
    this.#executableDigest = options.executableDigest;
    this.#policyDigest = options.policyDigest;
    this.#timeoutMs = integer(options.timeoutMs ?? 50 * 60_000, 60_000, 55 * 60_000);
    this.#process = options.process ?? executeNativeSteamDepotFinalizer;
  }

  async probe(): Promise<void> {
    await this.#verifyRuntime();
    const probeRoot = join(this.#workRoot, "probe");
    await mkdir(probeRoot, { recursive: true, mode: 0o700 });
    const result = await this.#process(this.#executable, [
      "probe", "--policy-file", this.#policyFile, "--json",
    ], processOptions(probeRoot, Math.min(this.#timeoutMs, 30_000)));
    if (result.exitCode !== 0 || result.stderr || FORBIDDEN_OUTPUT.test(result.stdout)) invalid("probe output");
    const body = record(parseJson(result.stdout));
    exactKeys(body, ["schemaVersion", "status", "policyDigest", "supportedSchemes"]);
    if (body.schemaVersion !== "deviludo.native-steam-depot-finalizer-probe.v1"
      || body.status !== "READY" || body.policyDigest !== this.#policyDigest
      || JSON.stringify(body.supportedSchemes) !== JSON.stringify(STEAM_DEPOT_SIGNING_SCHEMES)) invalid("probe");
  }

  async finalize(request: SteamDepotFinalizationRequest): Promise<SteamDepotFinalizationReceipt> {
    await this.#verifyRuntime();
    const runRoot = join(this.#workRoot, request.releaseId, request.platform);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const requestPath = join(runRoot, "request.json");
    const receiptPath = join(runRoot, "receipt.json");
    await writeImmutable(requestPath, Buffer.from(canonicalJson(request)));
    const replay = await readReceiptIfPresent(receiptPath, runRoot, request);
    if (replay) return replay;
    const result = await this.#process(this.#executable, [
      "finalize", "--policy-file", this.#policyFile,
      "--request-file", requestPath, "--receipt-file", receiptPath,
    ], processOptions(runRoot, this.#timeoutMs));
    if (result.exitCode !== 0 || result.stdout || result.stderr
      || FORBIDDEN_OUTPUT.test(`${result.stdout}\n${result.stderr}`)) invalid("execution");
    const receipt = await readReceiptIfPresent(receiptPath, runRoot, request);
    if (!receipt) invalid("receipt");
    return receipt;
  }

  async #verifyRuntime(): Promise<void> {
    await Promise.all([
      verifyFile(this.#executable, this.#executableDigest, 1024 * 1024 * 1024, true),
      verifyFile(this.#policyFile, this.#policyDigest, 1024 * 1024),
      verifyDirectory(this.#workRoot),
    ]);
  }
}

export function executeNativeSteamDepotFinalizer(
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
): Promise<NativeSteamDepotProcessResult> {
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

async function readReceiptIfPresent(
  path: string,
  root: string,
  request: SteamDepotFinalizationRequest,
): Promise<SteamDepotFinalizationReceipt | null> {
  try {
    const [canonical, boundary] = await Promise.all([realpath(path), realpath(root)]);
    if (!canonical.startsWith(`${boundary}${sep}`)) invalid("receipt boundary");
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size < 2 || before.size > MAX_RECEIPT_BYTES) invalid("receipt file");
      const contents = await file.readFile({ encoding: "utf8" });
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid("receipt mutation");
      return validateSteamDepotFinalizationReceipt(parseJson(contents), request);
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
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs
      || hash.digest("hex") !== expectedDigest) invalid("runtime digest");
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
  });
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4096 || /\0/.test(value)) invalid(label);
  return value;
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("timeout");
  return value;
}

function bounded(value: string): string { return value.length <= MAX_OUTPUT_BYTES ? value : value.slice(0, MAX_OUTPUT_BYTES); }
function nativeExitCode(error: Error | null): number {
  if (!error) return 0;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) && code > 0 && code <= 255 ? code : 1;
}
function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { invalid("JSON"); } }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid("response"); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("response fields"); }
function invalid(label: string): never { throw new Error(`Native Steam depot finalizer ${label} is invalid`); }
