import { createPublicKey, type KeyObject } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunnerCapabilities } from "./contracts";
import { validateRunnerCapabilities } from "./coordinator";
import { PhysicalRunnerAgent, type PhysicalRunnerCycleResult } from "./physical-runner";
import { FilePhysicalRunnerJournal } from "./physical-runner-journal";
import { physicalRunnerIngressClientFromEnv } from "./runner-ingress-client";
import { testKitArtifactProcessEnvironmentFromEnv } from "./testkit-artifact-client";
import { LockedTestKitExecutor } from "./testkit-executor";
import { testKitSteamProcessEnvironmentFromEnv } from "../../godot-testkit/src/steam-installed-game-driver";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CONFIG_BYTES = 256 * 1024;

export interface PhysicalRunnerMachineConfig {
  readonly schemaVersion: "deviludo.physical-runner-config.v1";
  readonly capabilities: RunnerCapabilities;
  readonly tenantIds: readonly string[];
}

export type PhysicalRunnerDiagnosticCode =
  | "READY"
  | "IDLE"
  | "DRAINING"
  | "COMPLETED"
  | "CYCLE_FAILED"
  | "STOPPED";

export class PhysicalRunnerDaemon {
  readonly #agent: Pick<PhysicalRunnerAgent, "runOnce">;
  readonly #pollIntervalMs: number;
  readonly #maxBackoffMs: number;
  readonly #pause: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly #diagnostic: (code: PhysicalRunnerDiagnosticCode) => void;
  #running = false;

  constructor(options: {
    readonly agent: Pick<PhysicalRunnerAgent, "runOnce">;
    readonly pollIntervalMs?: number;
    readonly maxBackoffMs?: number;
    readonly pause?: (delayMs: number, signal: AbortSignal) => Promise<void>;
    readonly diagnostic?: (code: PhysicalRunnerDiagnosticCode) => void;
  }) {
    this.#agent = options.agent;
    this.#pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 5_000, 250, 5 * 60_000, "poll interval");
    this.#maxBackoffMs = boundedInteger(options.maxBackoffMs ?? 60_000, this.#pollIntervalMs, 15 * 60_000, "backoff");
    this.#pause = options.pause ?? abortablePause;
    this.#diagnostic = options.diagnostic ?? (() => undefined);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) throw new Error("Physical Runner daemon is already running");
    this.#running = true;
    let failures = 0;
    try {
      while (!signal.aborted) {
        let delay = this.#pollIntervalMs;
        try {
          const result = await this.#agent.runOnce();
          failures = 0;
          this.#diagnostic(diagnosticFor(result));
          if (result.status === "COMPLETED") delay = Math.min(250, this.#pollIntervalMs);
        } catch {
          failures += 1;
          this.#diagnostic("CYCLE_FAILED");
          delay = Math.min(this.#maxBackoffMs, this.#pollIntervalMs * (2 ** Math.min(failures - 1, 10)));
        }
        if (!signal.aborted) await this.#pause(delay, signal);
      }
    } finally {
      this.#running = false;
      this.#diagnostic("STOPPED");
    }
  }
}

export async function runPhysicalRunnerService(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
} = {}): Promise<void> {
  const env = options.env ?? process.env;
  const service = await physicalRunnerServiceFromEnv(env);
  await Promise.all([service.ingress.probe(), service.executor.probe()]);
  diagnostic("READY");
  const shutdown = new AbortController();
  const requestShutdown = () => shutdown.abort();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  try {
    await service.daemon.run(shutdown.signal);
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
  }
}

export async function physicalRunnerServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtime: Readonly<{ platform: NodeJS.Platform; arch: string }> = process,
): Promise<{
  readonly config: PhysicalRunnerMachineConfig;
  readonly jobPublicKey: KeyObject;
  readonly ingress: Awaited<ReturnType<typeof physicalRunnerIngressClientFromEnv>>;
  readonly executor: LockedTestKitExecutor;
  readonly daemon: PhysicalRunnerDaemon;
}> {
  const config = await loadMachineConfig(requiredEnv(env, "DEVILUDO_PHYSICAL_RUNNER_CONFIG_FILE"), runtime);
  const [jobKeyPem, journalHmacKey, ingress] = await Promise.all([
    readRequiredFile(env, "DEVILUDO_RUNNER_JOB_VERIFY_PUBLIC_KEY_FILE", 32, 1024 * 1024),
    readRequiredFile(env, "DEVILUDO_PHYSICAL_RUNNER_JOURNAL_HMAC_KEY_FILE", 32, 64),
    physicalRunnerIngressClientFromEnv(env),
  ]);
  const jobPublicKey = createPublicKey(jobKeyPem);
  if (jobPublicKey.asymmetricKeyType !== "ed25519") throw new Error("Physical Runner job verification key must be Ed25519");
  const journal = new FilePhysicalRunnerJournal({
    root: requiredAbsolutePath(env, "DEVILUDO_PHYSICAL_RUNNER_JOURNAL_ROOT"),
    hmacKey: journalHmacKey,
  });
  journalHmacKey.fill(0);
  const testKitEnvironment = Object.freeze({
    ...testKitArtifactProcessEnvironmentFromEnv(env),
    ...testKitSteamProcessEnvironmentFromEnv(env),
  });
  const executor = new LockedTestKitExecutor({
    testKitExecutable: requiredAbsolutePath(env, "DEVILUDO_PHYSICAL_RUNNER_TESTKIT_EXECUTABLE"),
    testKitDigest: requiredDigest(env, "DEVILUDO_PHYSICAL_RUNNER_TESTKIT_DIGEST"),
    godotExecutable: requiredAbsolutePath(env, "DEVILUDO_PHYSICAL_RUNNER_GODOT_EXECUTABLE"),
    godotBinaryDigest: config.capabilities.godotBinaryDigest,
    godotVersion: config.capabilities.godotVersion,
    workRoot: requiredAbsolutePath(env, "DEVILUDO_PHYSICAL_RUNNER_WORK_ROOT"),
    timeoutMs: seconds(env.DEVILUDO_PHYSICAL_RUNNER_TESTKIT_TIMEOUT_SECONDS, 3_600, 1, 14_400) * 1_000,
    testKitEnvironment,
  });
  const agent = new PhysicalRunnerAgent({
    capabilities: config.capabilities,
    tenantIds: config.tenantIds,
    jobKeyId: requiredSafeId(env, "DEVILUDO_RUNNER_JOB_VERIFY_KEY_ID"),
    jobPublicKey,
    ingress,
    executor,
    journal,
  });
  const daemon = new PhysicalRunnerDaemon({
    agent,
    pollIntervalMs: seconds(env.DEVILUDO_PHYSICAL_RUNNER_POLL_SECONDS, 5, 1, 300) * 1_000,
    maxBackoffMs: seconds(env.DEVILUDO_PHYSICAL_RUNNER_MAX_BACKOFF_SECONDS, 60, 1, 900) * 1_000,
    diagnostic,
  });
  return Object.freeze({ config, jobPublicKey, ingress, executor, daemon });
}

export async function loadMachineConfig(
  path: string,
  runtime: Readonly<{ platform: NodeJS.Platform; arch: string }> = process,
): Promise<PhysicalRunnerMachineConfig> {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) {
    throw new Error("Physical Runner config path is invalid");
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_CONFIG_BYTES) {
    throw new Error("Physical Runner config file is invalid");
  }
  const file = await open(path, "r");
  let parsed: unknown;
  try { parsed = JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown; }
  finally { await file.close(); }
  const body = object(parsed);
  exactKeys(body, ["schemaVersion", "capabilities", "tenantIds"]);
  const config = body as unknown as PhysicalRunnerMachineConfig;
  if (config.schemaVersion !== "deviludo.physical-runner-config.v1") invalidConfig();
  validateRunnerCapabilities(config.capabilities);
  const expectedPlatform = runtimeTargetPlatform(runtime.platform);
  const expectedArchitecture = runtimeArchitecture(runtime.arch);
  if (config.capabilities.platform !== expectedPlatform || config.capabilities.architecture !== expectedArchitecture) {
    throw new Error("Physical Runner config does not match this operating system");
  }
  const tenants = validateTenants(config.tenantIds);
  return deepFreeze({ ...config, tenantIds: tenants });
}

function runtimeTargetPlatform(value: NodeJS.Platform): RunnerCapabilities["platform"] {
  if (value === "win32") return "windows";
  if (value === "linux") return "linux";
  if (value === "darwin") return "macos";
  throw new Error("Physical Runner operating system is unsupported");
}

function runtimeArchitecture(value: string): RunnerCapabilities["architecture"] {
  if (value === "x64") return "x86_64";
  if (value === "arm64") return "arm64";
  throw new Error("Physical Runner architecture is unsupported");
}

function validateTenants(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 10_000) invalidConfig();
  let previous = "";
  for (const value of values) {
    if (typeof value !== "string" || value !== value.toLowerCase() || !UUID.test(value) || value <= previous) invalidConfig();
    previous = value;
  }
  return Object.freeze([...values]);
}

async function readRequiredFile(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): Promise<Buffer> {
  const path = requiredAbsolutePath(env, name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < minimum || metadata.size > maximum) {
    throw new Error(`${name} file is invalid`);
  }
  const file = await open(path, "r");
  try { return await file.readFile(); }
  finally { await file.close(); }
}

function diagnostic(code: PhysicalRunnerDiagnosticCode | "FAILED"): void {
  process.stderr.write(`${JSON.stringify({ service: "deviludo-physical-runner", code })}\n`);
}

function diagnosticFor(result: PhysicalRunnerCycleResult): PhysicalRunnerDiagnosticCode {
  if (result.status === "COMPLETED") return "COMPLETED";
  return result.status;
}

function abortablePause(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function requiredAbsolutePath(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = requiredEnv(env, name);
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) {
    throw new Error(`${name} path is invalid`);
  }
  return value;
}

function requiredDigest(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = requiredEnv(env, name);
  if (!SHA256.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredSafeId(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = requiredEnv(env, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Physical Runner duration is invalid");
  }
  return parsed;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Physical Runner ${label} is invalid`);
  }
  return value;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalidConfig();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidConfig();
  return value as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalidConfig(): never {
  throw new Error("Physical Runner machine config is invalid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runPhysicalRunnerService().catch(() => {
    diagnostic("FAILED");
    process.exitCode = 1;
  });
}
