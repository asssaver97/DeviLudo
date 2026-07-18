import type { TargetPlatform } from "../../../lib/domain/types";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import type { PreparedInputTenantAuthorizer } from "../../evidence-archive/src/prepared-inputs";
import type { RunnerExecutionLockPort } from "../../artifact-preparer/src/preparer";
import type { RunnerToolchainRevisionPayload } from "../../artifact-preparer/src/contracts";
import { parseRunnerExecutionLock, runnerExecutionLockDigest } from "../../runner-control/src/execution-lock";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[1-9][0-9]{0,19}$/;
const APP_ID = /^[1-9][0-9]{0,19}$/;
const BETA_BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface SteamCleanInstallPreparationTrigger {
  readonly schemaVersion: "deviludo.steam-clean-install-preparation-trigger.v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly lockKey: string;
  readonly commitSha: string;
  readonly steamBuildId: string;
  readonly targetMatrix: readonly TargetPlatform[];
}

export interface SteamCleanInstallAuthorityResolution {
  readonly trigger: SteamCleanInstallPreparationTrigger;
  readonly buildReceiptId: string;
  readonly sourceDigest: string;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly runnerToolchainRevisionId: string;
  readonly runnerToolchainDigest: string;
  readonly toolchain: Readonly<RunnerToolchainRevisionPayload>;
  readonly steamAppId: string;
  readonly betaBranch: string;
}

export interface SteamCleanInstallPreparationAuthority {
  resolve(trigger: unknown): Promise<SteamCleanInstallAuthorityResolution>;
  probe(): Promise<void>;
}

export interface SteamCleanInstallGrantIssuer {
  issue(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly lockKey: string;
    readonly buildReceiptId: string;
    readonly steamAppId: string;
    readonly buildId: string;
    readonly betaBranch: string;
    readonly targetMatrix: readonly TargetPlatform[];
  }): Promise<Readonly<{
    installGrantId: string;
    steamAppId: string;
    buildId: string;
    betaBranch: string;
    targetMatrix: readonly TargetPlatform[];
  }>>;
  probe(): Promise<void>;
}

export interface SteamCleanInstallPreparationReceipt {
  readonly executionLockId: string;
  readonly executionLockDigest: string;
  readonly sourceDigest: string;
  readonly steamAppId: string;
  readonly buildId: string;
  readonly betaBranch: string;
  readonly installGrantId: string;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly created: boolean;
}

/** Steam-owned core: no account/session/branch secret is returned to Runner Control. */
export class SteamCleanInstallPreparationService {
  readonly #now: () => Date;

  constructor(private readonly options: {
    readonly tenants: PreparedInputTenantAuthorizer;
    readonly authority: SteamCleanInstallPreparationAuthority;
    readonly grants: SteamCleanInstallGrantIssuer;
    readonly locks: RunnerExecutionLockPort;
    readonly now?: () => Date;
  }) {
    this.#now = options.now ?? (() => new Date());
  }

  async prepare(identity: EvidenceArchiveWorkloadIdentity, value: unknown): Promise<SteamCleanInstallPreparationReceipt> {
    const trigger = parseSteamCleanInstallPreparationTrigger(value);
    await this.options.tenants.authorize(identity, trigger.tenantId);
    const authority = await this.options.authority.resolve(trigger);
    exactAuthority(authority, trigger);
    const grant = await this.options.grants.issue({
      tenantId: trigger.tenantId,
      projectId: trigger.projectId,
      runId: trigger.runId,
      lockKey: trigger.lockKey,
      buildReceiptId: authority.buildReceiptId,
      steamAppId: authority.steamAppId,
      buildId: trigger.steamBuildId,
      betaBranch: authority.betaBranch,
      targetMatrix: trigger.targetMatrix,
    });
    exactGrant(grant, authority);
    const preparedAt = validNow(this.#now()).toISOString();
    const lock = parseRunnerExecutionLock({
      schemaVersion: "deviludo.runner-execution-lock.v1",
      tenantId: trigger.tenantId,
      projectId: trigger.projectId,
      runId: trigger.runId,
      mode: "STEAM_CLEAN_INSTALL",
      commitSha: trigger.commitSha,
      sourceDigest: authority.sourceDigest,
      steamBuildId: trigger.steamBuildId,
      specRevisionId: authority.specRevisionId,
      specDigest: authority.specDigest,
      testPlanDigest: authority.testPlanDigest,
      runnerToolchainRevisionId: authority.runnerToolchainRevisionId,
      runnerToolchainDigest: authority.runnerToolchainDigest,
      targetMatrix: trigger.targetMatrix,
      requiredGodotVersion: authority.toolchain.requiredGodotVersion,
      godotTestKitDigest: authority.toolchain.godotTestKitDigest,
      exportTemplates: authority.toolchain.exportTemplates,
      buildManifestDigest: authority.toolchain.buildManifestDigest,
      sbomDigest: authority.toolchain.sbomDigest,
      vulnerabilityScanDigest: authority.toolchain.vulnerabilityScanDigest,
      assetLicenseLedgerDigest: authority.toolchain.assetLicenseLedgerDigest,
      execution: {
        kind: "STEAM_CLEAN_INSTALL",
        steamAppId: authority.steamAppId,
        buildId: trigger.steamBuildId,
        betaBranch: authority.betaBranch,
        installGrantId: grant.installGrantId,
      },
      preparedAt,
    });
    const executionLockDigest = runnerExecutionLockDigest(lock);
    const persisted = await this.options.locks.persist({
      tenantId: trigger.tenantId,
      projectId: trigger.projectId,
      runId: trigger.runId,
      lockKey: trigger.lockKey,
      payload: lock,
      payloadDigest: executionLockDigest,
    });
    if (!UUID.test(persisted.executionLockId) || persisted.payloadDigest !== executionLockDigest
      || typeof persisted.created !== "boolean") invalid("execution lock receipt");
    return Object.freeze({
      executionLockId: persisted.executionLockId,
      executionLockDigest,
      sourceDigest: authority.sourceDigest,
      steamAppId: authority.steamAppId,
      buildId: trigger.steamBuildId,
      betaBranch: authority.betaBranch,
      installGrantId: grant.installGrantId,
      targetMatrix: Object.freeze([...trigger.targetMatrix]),
      created: persisted.created,
    });
  }

  async probe(): Promise<void> {
    await Promise.all([this.options.tenants.probe(), this.options.authority.probe(), this.options.grants.probe()]);
  }
}

export function parseSteamCleanInstallPreparationTrigger(value: unknown): SteamCleanInstallPreparationTrigger {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "tenantId", "projectId", "runId", "lockKey", "commitSha", "steamBuildId", "targetMatrix",
  ]);
  if (body.schemaVersion !== "deviludo.steam-clean-install-preparation-trigger.v1") invalid("trigger schema");
  return deepFreeze({
    schemaVersion: "deviludo.steam-clean-install-preparation-trigger.v1",
    tenantId: required(body.tenantId, UUID, "tenant"),
    projectId: required(body.projectId, UUID, "project"),
    runId: required(body.runId, UUID, "run"),
    lockKey: required(body.lockKey, SHA256, "lock key"),
    commitSha: required(body.commitSha, SHA1, "commit"),
    steamBuildId: required(body.steamBuildId, BUILD_ID, "BuildID"),
    targetMatrix: matrix(body.targetMatrix),
  });
}

function exactAuthority(authority: SteamCleanInstallAuthorityResolution, trigger: SteamCleanInstallPreparationTrigger): void {
  if (!authority || authority.trigger.tenantId !== trigger.tenantId || authority.trigger.projectId !== trigger.projectId
    || authority.trigger.runId !== trigger.runId || authority.trigger.lockKey !== trigger.lockKey
    || authority.trigger.commitSha !== trigger.commitSha || authority.trigger.steamBuildId !== trigger.steamBuildId
    || JSON.stringify(authority.trigger.targetMatrix) !== JSON.stringify(trigger.targetMatrix)
    || !UUID.test(authority.buildReceiptId) || !SHA256.test(authority.sourceDigest)
    || !UUID.test(authority.specRevisionId) || !SHA256.test(authority.specDigest) || !SHA256.test(authority.testPlanDigest)
    || !UUID.test(authority.runnerToolchainRevisionId) || !SHA256.test(authority.runnerToolchainDigest)
    || !APP_ID.test(authority.steamAppId) || !BETA_BRANCH.test(authority.betaBranch)
    || authority.betaBranch === "default" || authority.betaBranch === "public") invalid("authority");
}

function exactGrant(
  grant: Awaited<ReturnType<SteamCleanInstallGrantIssuer["issue"]>>,
  authority: SteamCleanInstallAuthorityResolution,
): void {
  if (!grant || !SAFE_ID.test(grant.installGrantId) || grant.steamAppId !== authority.steamAppId
    || grant.buildId !== authority.trigger.steamBuildId || grant.betaBranch !== authority.betaBranch
    || JSON.stringify(grant.targetMatrix) !== JSON.stringify(authority.trigger.targetMatrix)) invalid("grant receipt");
}

function matrix(value: unknown): readonly TargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length
    || value.some((platform) => typeof platform !== "string" || !["windows", "linux", "macos"].includes(platform))) invalid("matrix");
  const sorted = [...value].sort() as TargetPlatform[];
  if (JSON.stringify(sorted) !== JSON.stringify(value)) invalid("matrix order");
  return Object.freeze(sorted);
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

function required(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(label);
  return value;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid("clock");
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(label: string): never {
  throw new Error(`Steam clean-install preparation ${label} is invalid`);
}
