import type { KeyObject } from "node:crypto";
import { readFile, realpath, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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
import type { SteamClientNativeExecutionResult } from "./connector";
import { verifySteamAppManifest } from "./steam-appmanifest";

const SHA256 = /^[a-f0-9]{64}$/;
const CODE = /^[A-Z0-9_]{2,64}$/;
const FORBIDDEN_LOG = /config\.vdf|steam.?guard|branch.?password|account.?password|refresh.?token/i;

export interface NativeSteamBridgeProbe {
  readonly schemaVersion: "deviludo.native-steam-desktop-probe.v1";
  readonly status: "READY";
  readonly runnerId: string;
  readonly platform: TargetPlatform;
  readonly interactiveSession: true;
  readonly steamSession: "ENROLLED";
}

export interface NativeSteamStepResult {
  readonly id: "steam-client-reset" | "steam-install" | "production-boot" | "platform-suite";
  readonly status: "PASSED" | "FAILED";
  readonly durationMs: number;
  readonly code: string;
}

export interface NativeSteamInstallResult extends NativeSteamStepResult {
  readonly id: "steam-install";
  readonly installRoot: string;
  readonly appManifestPath: string;
}

export interface NativeSteamSuiteResult extends NativeSteamStepResult {
  readonly id: "platform-suite";
  readonly harnessRoot: string;
  readonly harnessResultPath: string;
  readonly logsPath: string;
}

export interface NativeSteamDesktopAutomationPort {
  probe(input: Readonly<{ runnerId: string; platform: TargetPlatform }>): Promise<NativeSteamBridgeProbe>;
  resetClient(input: NativeSteamAutomationContext): Promise<NativeSteamStepResult>;
  installBuild(input: NativeSteamAutomationContext): Promise<NativeSteamInstallResult>;
  bootProduction(input: NativeSteamAutomationContext & Readonly<{ installRoot: string }>): Promise<NativeSteamStepResult>;
  runPlatformSuite(input: NativeSteamAutomationContext & Readonly<{
    installRoot: string;
    testPlan: GodotTestPlan;
  }>): Promise<NativeSteamSuiteResult>;
}

export interface NativeSteamAutomationContext {
  readonly executionId: string;
  readonly stagingRoot: string;
  readonly steamAppId: string;
  readonly buildId: string;
  readonly betaBranch: string;
  readonly platform: TargetPlatform;
}

/**
 * Security controller compiled into each signed OS bridge artifact. Platform
 * accessibility/UI code only implements NativeSteamDesktopAutomationPort and
 * cannot change job validation, stage order, BuildID proof or result shape.
 */
export class NativeSteamBridgeController {
  readonly #stagingRoot: string;
  readonly #now: () => Date;

  constructor(private readonly options: Readonly<{
    jobPublicKey: KeyObject;
    jobKeyId: string;
    runnerId: string;
    platform: TargetPlatform;
    stagingRoot: string;
    automation: NativeSteamDesktopAutomationPort;
    now?: () => Date;
  }>) {
    if (options.jobPublicKey.asymmetricKeyType !== "ed25519"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(options.jobKeyId)
      || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(options.runnerId)) invalid("identity");
    this.#stagingRoot = absolutePath(options.stagingRoot);
    this.#now = options.now ?? (() => new Date());
  }

  async probe(): Promise<Readonly<{ schemaVersion: "deviludo.native-steam-client-probe.v1"; status: "READY" }>> {
    await canonicalDirectory(this.#stagingRoot, this.#stagingRoot);
    const value = record(await this.options.automation.probe({
      runnerId: this.options.runnerId,
      platform: this.options.platform,
    }));
    exactKeys(value, ["schemaVersion", "status", "runnerId", "platform", "interactiveSession", "steamSession"]);
    if (value.schemaVersion !== "deviludo.native-steam-desktop-probe.v1" || value.status !== "READY"
      || value.runnerId !== this.options.runnerId || value.platform !== this.options.platform
      || value.interactiveSession !== true || value.steamSession !== "ENROLLED") invalid("probe");
    return Object.freeze({ schemaVersion: "deviludo.native-steam-client-probe.v1", status: "READY" });
  }

  async execute(value: unknown): Promise<SteamClientNativeExecutionResult> {
    const request = nativeRequest(value);
    const job = request.signedJob;
    const execution = job.payload.execution;
    const observedNow = this.#now();
    if (!Number.isFinite(observedNow.getTime()) || request.executionId !== sha256Canonical(job.payload)
      || execution.kind !== "STEAM_CLEAN_INSTALL") invalid("job binding");
    let verified = false;
    try {
      verified = verifyRunnerJob(job, this.options.jobPublicKey, {
        keyId: this.options.jobKeyId,
        runnerId: this.options.runnerId,
        platform: this.options.platform,
        now: observedNow.toISOString(),
      });
    } catch { invalid("signed job"); }
    if (!verified) invalid("signed job");
    const stagingRoot = await canonicalDirectory(request.stagingRoot, this.#stagingRoot);
    if (stagingRoot !== await realpath(this.#stagingRoot)) invalid("staging root");
    const plan = parseFrozenGodotTestPlan(Buffer.from(canonicalJson(request.testPlan)), {
      testPlanDigest: job.payload.testPlanDigest,
      targetMatrix: job.payload.targetMatrix,
      requiredGodotVersion: job.payload.requiredGodotVersion,
      currentPlatform: job.payload.platform,
    });
    const context: NativeSteamAutomationContext = Object.freeze({
      executionId: request.executionId,
      stagingRoot,
      steamAppId: execution.steamAppId,
      buildId: execution.buildId,
      betaBranch: execution.betaBranch,
      platform: job.payload.platform,
    });

    const reset = stage(await this.options.automation.resetClient(context), "steam-client-reset", true);
    const installed = installStage(await this.options.automation.installBuild(context));
    const installRoot = await canonicalDirectory(installed.installRoot, stagingRoot);
    const appManifestPath = await canonicalFile(installed.appManifestPath, stagingRoot, 2 * 1024 * 1024);
    if (basename(appManifestPath) !== `appmanifest_${execution.steamAppId}.acf`) invalid("appmanifest path");
    const appManifest = verifySteamAppManifest(await readFile(appManifestPath), {
      appId: execution.steamAppId,
      buildId: execution.buildId,
    });
    const expectedInstallRoot = await canonicalDirectory(
      join(dirname(appManifestPath), "common", appManifest.installDirectoryName),
      stagingRoot,
    );
    if (expectedInstallRoot !== installRoot) invalid("install root");

    const boot = stage(await this.options.automation.bootProduction({ ...context, installRoot }), "production-boot", true);
    const suiteValue = await this.options.automation.runPlatformSuite({ ...context, installRoot, testPlan: plan });
    const suite = suiteStage(suiteValue);
    const harnessRoot = await canonicalDirectory(suiteValue.harnessRoot, stagingRoot);
    const harnessResultPath = await canonicalFile(suiteValue.harnessResultPath, harnessRoot, 8 * 1024 * 1024);
    const logsPath = await canonicalFile(suiteValue.logsPath, harnessRoot, 8 * 1024 * 1024);
    const harness = parseGodotHarnessResult(JSON.parse(await readFile(harnessResultPath, "utf8")) as unknown, plan);
    if ((harness.status === "PASSED") !== (suite.status === "PASSED")) invalid("suite status");
    if (FORBIDDEN_LOG.test(await readFile(logsPath, "utf8"))) invalid("credential-free logs");

    return Object.freeze({
      installRoot,
      appManifestPath,
      harnessRoot,
      harnessResultPath,
      logsPath,
      commands: Object.freeze([reset, installed.command, boot, suite]),
    });
  }
}

function nativeRequest(value: unknown): Readonly<{
  schemaVersion: "deviludo.native-steam-clean-install.v1";
  executionId: string;
  stagingRoot: string;
  signedJob: SignedRunnerJob;
  testPlan: unknown;
}> {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "executionId", "stagingRoot", "signedJob", "testPlan"]);
  const signedJob = record(body.signedJob);
  exactKeys(signedJob, ["payload", "signature"]);
  const payload = record(signedJob.payload);
  record(payload.execution);
  const signature = record(signedJob.signature);
  exactKeys(signature, ["algorithm", "keyId", "value"]);
  record(body.testPlan);
  if (body.schemaVersion !== "deviludo.native-steam-clean-install.v1"
    || typeof body.executionId !== "string" || !SHA256.test(body.executionId)
    || typeof body.stagingRoot !== "string" || signature.algorithm !== "Ed25519"
    || typeof signature.keyId !== "string" || typeof signature.value !== "string") invalid("request");
  return Object.freeze({
    schemaVersion: "deviludo.native-steam-clean-install.v1",
    executionId: body.executionId,
    stagingRoot: body.stagingRoot,
    signedJob: signedJob as unknown as SignedRunnerJob,
    testPlan: body.testPlan,
  });
}

function installStage(value: NativeSteamInstallResult): Readonly<{
  command: GodotCommandEvidence;
  installRoot: string;
  appManifestPath: string;
}> {
  const body = record(value);
  exactKeys(body, ["id", "status", "durationMs", "code", "installRoot", "appManifestPath"]);
  return Object.freeze({
    command: stage(body, "steam-install", true),
    installRoot: absolutePath(body.installRoot),
    appManifestPath: absolutePath(body.appManifestPath),
  });
}

function suiteStage(value: NativeSteamSuiteResult): GodotCommandEvidence {
  const body = record(value);
  exactKeys(body, ["id", "status", "durationMs", "code", "harnessRoot", "harnessResultPath", "logsPath"]);
  absolutePath(body.harnessRoot);
  absolutePath(body.harnessResultPath);
  absolutePath(body.logsPath);
  return stage(body, "platform-suite", false);
}

function stage(value: unknown, expectedId: NativeSteamStepResult["id"], mustPass: boolean): GodotCommandEvidence {
  const body = record(value);
  if (expectedId !== "steam-install" && expectedId !== "platform-suite") {
    exactKeys(body, ["id", "status", "durationMs", "code"]);
  }
  if (body.id !== expectedId || (body.status !== "PASSED" && body.status !== "FAILED")
    || (mustPass && body.status !== "PASSED") || typeof body.durationMs !== "number"
    || !Number.isFinite(body.durationMs) || body.durationMs < 0 || body.durationMs > 3_600_000
    || typeof body.code !== "string" || !CODE.test(body.code)) invalid(`${expectedId} result`);
  return Object.freeze({
    id: expectedId,
    status: body.status,
    durationMs: body.durationMs,
    code: body.code,
  });
}

async function canonicalDirectory(path: string, root: string): Promise<string> {
  const requested = absolutePath(path);
  const metadata = await lstat(requested);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("directory");
  const [canonical, boundary] = await Promise.all([realpath(requested), realpath(root)]);
  if (canonical !== boundary && !canonical.startsWith(`${boundary}${sep}`)) invalid("path boundary");
  return canonical;
}

async function canonicalFile(path: string, root: string, maximum: number): Promise<string> {
  const requested = absolutePath(path);
  const metadata = await lstat(requested);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximum) invalid("file");
  const [canonical, boundary] = await Promise.all([realpath(requested), realpath(root)]);
  if (!canonical.startsWith(`${boundary}${sep}`)) invalid("path boundary");
  return canonical;
}

function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || value.includes("\u0000")) {
    invalid("absolute path");
  }
  return value;
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

function invalid(label: string): never {
  throw new Error(`Native Steam bridge ${label} is invalid`);
}
