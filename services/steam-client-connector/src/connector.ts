import type { KeyObject } from "node:crypto";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { TargetPlatform } from "../../../lib/domain/types";
import { canonicalJson, sha256Canonical } from "../../runner-control/src/canonical";
import type { SignedRunnerJob } from "../../runner-control/src/contracts";
import { verifyRunnerJob } from "../../runner-control/src/coordinator";
import {
  parseFrozenGodotTestPlan,
  parseGodotHarnessResult,
  type GodotTestPlan,
} from "../../godot-testkit/src/contracts";
import type { GodotCommandEvidence } from "../../godot-testkit/src/godot-driver";
import type {
  SteamInstallGrantRedemptionPort,
  SteamInstallGrantRedemptionReceipt,
} from "./install-grant-client";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_LOG = /config\.vdf|steam.?guard|branch.?password|account.?password|refresh.?token/i;

export interface SteamClientNativeExecutor {
  execute(input: Readonly<{
    schemaVersion: "deviludo.native-steam-clean-install.v1";
    executionId: string;
    stagingRoot: string;
    signedJob: SignedRunnerJob;
    testPlan: GodotTestPlan;
  }>): Promise<SteamClientNativeExecutionResult>;
  probe(): Promise<void>;
}

/**
 * Result returned by the signed, OS-specific Steam Client bridge. The bridge
 * owns the protected Steam session. It must never put credentials in this
 * contract, its child environment, logs or installed game directory.
 */
export interface SteamClientNativeExecutionResult {
  readonly installRoot: string;
  readonly harnessRoot: string;
  readonly harnessResultPath: string;
  readonly logsPath: string;
  readonly commands: readonly GodotCommandEvidence[];
}

export interface SteamCleanInstallExecutionReceipt {
  readonly schemaVersion: "deviludo.steam-clean-install-execution-receipt.v1";
  readonly receiptDigest: string;
  readonly jobDigest: string;
  readonly executionLockDigest: string;
  readonly platform: TargetPlatform;
  readonly steamAppId: string;
  readonly buildId: string;
  readonly betaBranch: string;
  readonly installGrantId: string;
  readonly cleanClient: true;
  readonly installRoot: string;
  readonly harnessRoot: string;
  readonly harnessResultPath: string;
  readonly logsPath: string;
  readonly commands: readonly GodotCommandEvidence[];
}

/** Verifies platform authority before crossing into the native Steam session. */
export class SteamClientConnectorService {
  readonly #now: () => Date;
  readonly #stagingRoot: string;
  readonly #runs = new Map<string, Promise<SteamCleanInstallExecutionReceipt>>();

  constructor(private readonly options: Readonly<{
    jobPublicKey: KeyObject;
    jobKeyId: string;
    runnerId: string;
    platform: TargetPlatform;
    stagingRoot: string;
    executor: SteamClientNativeExecutor;
    grants: SteamInstallGrantRedemptionPort;
    now?: () => Date;
  }>) {
    if (options.jobPublicKey.asymmetricKeyType !== "ed25519") throw new Error("Steam Connector job key must be Ed25519");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(options.jobKeyId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(options.runnerId)) {
      throw new Error("Steam Connector identity configuration is invalid");
    }
    this.#stagingRoot = absolutePath(options.stagingRoot);
    this.#now = options.now ?? (() => new Date());
  }

  async execute(value: unknown): Promise<SteamCleanInstallExecutionReceipt> {
    const request = parseRequest(value);
    const job = request.signedJob;
    const now = validNow(this.#now()).toISOString();
    if (request.jobDigest !== sha256Canonical(job.payload)
      || !verifyRunnerJob(job, this.options.jobPublicKey, {
        keyId: this.options.jobKeyId,
        runnerId: this.options.runnerId,
        platform: this.options.platform,
        now,
      })) invalid("signed Runner job");
    const execution = job.payload.execution;
    if (execution.kind !== "STEAM_CLEAN_INSTALL") invalid("execution mode");
    const planBytes = Buffer.from(canonicalJson(request.testPlan));
    const plan = parseFrozenGodotTestPlan(planBytes, {
      testPlanDigest: job.payload.testPlanDigest,
      targetMatrix: job.payload.targetMatrix,
      requiredGodotVersion: job.payload.requiredGodotVersion,
      currentPlatform: job.payload.platform,
    });
    const existing = this.#runs.get(request.jobDigest);
    if (existing) return existing;
    const running = this.#executeVerified(request.jobDigest, job, plan).catch((error) => {
      this.#runs.delete(request.jobDigest);
      throw error;
    });
    this.#runs.set(request.jobDigest, running);
    return running;
  }

  async probe(): Promise<void> {
    await canonicalDirectory(this.#stagingRoot, this.#stagingRoot);
    await Promise.all([this.options.grants.probe(), this.options.executor.probe()]);
  }

  async #executeVerified(
    jobDigest: string,
    signedJob: SignedRunnerJob,
    testPlan: GodotTestPlan,
  ): Promise<SteamCleanInstallExecutionReceipt> {
    const grant = await this.options.grants.redeem({ jobDigest, signedJob });
    verifyGrantReceipt(grant, jobDigest, signedJob);
    const result = await this.options.executor.execute(Object.freeze({
      schemaVersion: "deviludo.native-steam-clean-install.v1",
      executionId: jobDigest,
      stagingRoot: this.#stagingRoot,
      signedJob,
      testPlan,
    }));
    const stagingRoot = await canonicalDirectory(this.#stagingRoot, this.#stagingRoot);
    const installRoot = await canonicalDirectory(result.installRoot, stagingRoot);
    const harnessRoot = await canonicalDirectory(result.harnessRoot, stagingRoot);
    const harnessResultPath = await canonicalFile(result.harnessResultPath, harnessRoot, MAX_RESULT_BYTES);
    const logsPath = await canonicalFile(result.logsPath, harnessRoot, MAX_LOG_BYTES);
    const harness = parseGodotHarnessResult(JSON.parse(await readFile(harnessResultPath, "utf8")) as unknown, testPlan);
    await verifyHarnessFiles(harnessRoot, harness);
    const logs = await readFile(logsPath, "utf8");
    if (FORBIDDEN_LOG.test(logs)) invalid("credential-free logs");
    const commands = parseCommands(result.commands);
    const execution = signedJob.payload.execution;
    if (execution.kind !== "STEAM_CLEAN_INSTALL") invalid("execution mode");
    const core = Object.freeze({
      schemaVersion: "deviludo.steam-clean-install-execution-receipt.v1" as const,
      jobDigest,
      executionLockDigest: signedJob.payload.executionLockDigest,
      platform: signedJob.payload.platform,
      steamAppId: execution.steamAppId,
      buildId: execution.buildId,
      betaBranch: execution.betaBranch,
      installGrantId: execution.installGrantId,
      cleanClient: true as const,
      installRoot,
      harnessRoot,
      harnessResultPath,
      logsPath,
      commands,
    });
    return Object.freeze({ ...core, receiptDigest: sha256Canonical(core) });
  }
}

function verifyGrantReceipt(
  value: SteamInstallGrantRedemptionReceipt,
  jobDigest: string,
  signedJob: SignedRunnerJob,
): void {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "jobDigest", "executionLockDigest", "grantId", "platform",
    "steamAppId", "buildId", "betaBranch", "redeemedAt",
  ]);
  const execution = signedJob.payload.execution;
  if (execution.kind !== "STEAM_CLEAN_INSTALL"
    || body.schemaVersion !== "deviludo.steam-install-grant-redemption-receipt.v1"
    || body.jobDigest !== jobDigest || body.executionLockDigest !== signedJob.payload.executionLockDigest
    || body.grantId !== execution.installGrantId || body.platform !== signedJob.payload.platform
    || body.steamAppId !== execution.steamAppId || body.buildId !== execution.buildId
    || body.betaBranch !== execution.betaBranch || typeof body.redeemedAt !== "string"
    || !Number.isFinite(Date.parse(body.redeemedAt))) invalid("install grant redemption");
}

function parseRequest(value: unknown): Readonly<{
  schemaVersion: "deviludo.steam-clean-install-execution.v1";
  jobDigest: string;
  signedJob: SignedRunnerJob;
  testPlan: unknown;
}> {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "jobDigest", "signedJob", "testPlan"]);
  const job = record(body.signedJob);
  exactKeys(job, ["payload", "signature"]);
  record(job.payload);
  const signature = record(job.signature);
  exactKeys(signature, ["algorithm", "keyId", "value"]);
  if (body.schemaVersion !== "deviludo.steam-clean-install-execution.v1"
    || typeof body.jobDigest !== "string" || !SHA256.test(body.jobDigest)
    || signature.algorithm !== "Ed25519" || typeof signature.keyId !== "string" || typeof signature.value !== "string") {
    invalid("request");
  }
  record(body.testPlan);
  return Object.freeze({
    schemaVersion: "deviludo.steam-clean-install-execution.v1",
    jobDigest: body.jobDigest,
    signedJob: job as unknown as SignedRunnerJob,
    testPlan: body.testPlan,
  });
}

function parseCommands(value: readonly GodotCommandEvidence[]): readonly GodotCommandEvidence[] {
  if (!Array.isArray(value) || value.length !== 4) invalid("native commands");
  const expected = ["steam-client-reset", "steam-install", "production-boot", "platform-suite"] as const;
  return Object.freeze(value.map((item, index) => {
    const body = record(item);
    exactKeys(body, ["id", "status", "durationMs", "code"]);
    if (body.id !== expected[index] || (body.status !== "PASSED" && body.status !== "FAILED")
      || !Number.isFinite(body.durationMs) || (body.durationMs as number) < 0 || (body.durationMs as number) > 3_600_000
      || typeof body.code !== "string" || !/^[A-Z0-9_]{2,64}$/.test(body.code)) invalid("native commands");
    return Object.freeze({
      id: body.id,
      status: body.status,
      durationMs: body.durationMs as number,
      code: body.code,
    }) as GodotCommandEvidence;
  }));
}

async function canonicalDirectory(path: string, root: string): Promise<string> {
  const requested = absolutePath(path);
  const metadata = await lstat(requested);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("native directory");
  const canonical = await realpath(requested);
  const boundary = await realpath(root);
  if (canonical !== boundary && !canonical.startsWith(`${boundary}${sep}`)) invalid("staging boundary");
  return canonical;
}

async function canonicalFile(path: string, root: string, maximum: number): Promise<string> {
  const requested = absolutePath(path);
  const metadata = await lstat(requested);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximum) invalid("native file");
  const canonical = await realpath(requested);
  if (!canonical.startsWith(`${root}${sep}`)) invalid("harness boundary");
  return canonical;
}

async function verifyHarnessFiles(root: string, result: ReturnType<typeof parseGodotHarnessResult>): Promise<void> {
  for (const screenshot of result.screenshots) {
    const path = await canonicalFile(resolve(root, ...screenshot.file.split("/")), root, 128 * 1024 * 1024);
    if (createHash("sha256").update(await readFile(path)).digest("hex") !== screenshot.sha256) invalid("screenshot digest");
  }
  await canonicalFile(resolve(root, ...result.videoFile.split("/")), root, 4 * 1024 * 1024 * 1024);
}

function absolutePath(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) {
    invalid("absolute path");
  }
  return value;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid("clock");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object");
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid("fields");
}

function invalid(label: string): never {
  throw new Error(`Steam Client Connector ${label} is invalid`);
}
