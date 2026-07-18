import type { KeyObject } from "node:crypto";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { SignedRunnerJob } from "../../runner-control/src/contracts";
import { verifyRunnerJob } from "../../runner-control/src/coordinator";
import type { SignedRunnerFleetPolicy } from "../../runner-control/src/fleet-manifest";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import type { SteamInstallGrantRedemptionStore } from "./postgres-install-grants";

const SHA256 = /^[a-f0-9]{64}$/;

export class SteamInstallGrantRedemptionService {
  readonly #now: () => Date;
  constructor(private readonly options: Readonly<{
    jobKeyId: string;
    jobPublicKey: KeyObject;
    fleet: Pick<SignedRunnerFleetPolicy, "authorizeJob" | "probe">;
    store: SteamInstallGrantRedemptionStore;
    now?: () => Date;
  }>) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(options.jobKeyId)
      || options.jobPublicKey.asymmetricKeyType !== "ed25519") invalid();
    this.#now = options.now ?? (() => new Date());
  }

  async redeem(identity: EvidenceArchiveWorkloadIdentity, value: unknown) {
    const request = parseRequest(value);
    const job = request.signedJob;
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    if (!Number.isFinite(nowDate.getTime()) || request.jobDigest !== sha256Canonical(job.payload)) invalid();
    let verified = false;
    try {
      verified = verifyRunnerJob(job, this.options.jobPublicKey, {
        keyId: this.options.jobKeyId,
        runnerId: job.payload.runnerId,
        platform: job.payload.platform,
        now,
      });
    } catch { /* malformed job */ }
    if (!verified || job.payload.execution.kind !== "STEAM_CLEAN_INSTALL") invalid();
    if (!(await this.options.fleet.authorizeJob({
      identity,
      runnerId: job.payload.runnerId,
      platform: job.payload.platform,
      capabilityDigest: job.payload.runnerCapabilityDigest,
      tenantId: job.payload.tenantId,
      workload: "steam-client-connector",
    }))) invalid();
    const execution = job.payload.execution;
    const receipt = await this.options.store.redeem({
      tenantId: job.payload.tenantId,
      projectId: job.payload.projectId,
      runId: job.payload.runId,
      grantId: execution.installGrantId,
      platform: job.payload.platform,
      runnerId: job.payload.runnerId,
      jobDigest: request.jobDigest,
      executionLockDigest: job.payload.executionLockDigest,
      steamAppId: execution.steamAppId,
      buildId: execution.buildId,
      betaBranch: execution.betaBranch,
    });
    if (receipt.grantId !== execution.installGrantId || receipt.platform !== job.payload.platform
      || receipt.steamAppId !== execution.steamAppId || receipt.buildId !== execution.buildId
      || receipt.betaBranch !== execution.betaBranch || !Number.isFinite(Date.parse(receipt.redeemedAt))) invalid();
    return Object.freeze({
      schemaVersion: "deviludo.steam-install-grant-redemption-receipt.v1",
      jobDigest: request.jobDigest,
      executionLockDigest: job.payload.executionLockDigest,
      grantId: receipt.grantId,
      platform: receipt.platform,
      steamAppId: receipt.steamAppId,
      buildId: receipt.buildId,
      betaBranch: receipt.betaBranch,
      redeemedAt: receipt.redeemedAt,
    });
  }

  async probe(): Promise<void> {
    await Promise.all([this.options.fleet.probe(), this.options.store.probe()]);
  }
}

function parseRequest(value: unknown): Readonly<{
  schemaVersion: "deviludo.steam-install-grant-redemption.v1";
  jobDigest: string;
  signedJob: SignedRunnerJob;
}> {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "jobDigest", "signedJob"]);
  if (body.schemaVersion !== "deviludo.steam-install-grant-redemption.v1"
    || typeof body.jobDigest !== "string" || !SHA256.test(body.jobDigest)) invalid();
  return Object.freeze({ schemaVersion: body.schemaVersion, jobDigest: body.jobDigest, signedJob: record(body.signedJob) as unknown as SignedRunnerJob });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}

function invalid(): never { throw new Error("Steam install grant redemption is invalid"); }
