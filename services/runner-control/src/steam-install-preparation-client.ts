import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { TargetPlatform } from "../../../lib/domain/types";
import { WorkflowJobError } from "../../temporal/src/job-processor";
import {
  testKitArtifactBrokerHttpsJson,
  type TestKitArtifactBrokerHttp,
  type TestKitArtifactBrokerTls,
} from "./testkit-artifact-client";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[1-9][0-9]{0,19}$/;
const APP_ID = /^[1-9][0-9]{0,19}$/;
const BETA_BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface RunnerSteamInstallPreparationReceipt {
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

export interface RunnerSteamInstallPreparationPort {
  prepare(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly lockKey: string;
    readonly commitSha: string;
    readonly steamBuildId: string;
    readonly targetMatrix: readonly TargetPlatform[];
  }): Promise<RunnerSteamInstallPreparationReceipt>;
}

/** Requests one opaque, BuildID-bound clean-install grant from the isolated Steam boundary. */
export class MtlsRunnerSteamInstallPreparationClient implements RunnerSteamInstallPreparationPort {
  readonly #endpoint: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: TestKitArtifactBrokerHttp;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: TestKitArtifactBrokerTls;
    readonly timeoutMs?: number;
    readonly http?: TestKitArtifactBrokerHttp;
  }) {
    this.#endpoint = strictOrigin(options.endpoint);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 10 * 60_000, 30_000, 10 * 60_000);
    this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href);
    url.pathname = "/healthz";
    let response: Awaited<ReturnType<TestKitArtifactBrokerHttp>>;
    try {
      response = await this.#http({
        url,
        method: "GET",
        body: "{}",
        tls: this.#tls,
        timeoutMs: Math.min(this.#timeoutMs, 30_000),
      });
    } catch {
      throw new Error("Runner Steam Preparer readiness probe failed");
    }
    if (response.statusCode !== 200
      || !exactHealth(response.payload, "deviludo-steam-clean-install-preparer")) {
      throw new Error("Runner Steam Preparer readiness probe failed");
    }
  }

  async prepare(input: Parameters<RunnerSteamInstallPreparationPort["prepare"]>[0]): Promise<RunnerSteamInstallPreparationReceipt> {
    validateInput(input);
    const url = new URL(this.#endpoint.href);
    url.pathname = "/v1/clean-install-execution-preparations";
    let response: Awaited<ReturnType<TestKitArtifactBrokerHttp>>;
    try {
      response = await this.#http({
        url,
        body: JSON.stringify({
          schemaVersion: "deviludo.steam-clean-install-preparation-trigger.v1",
          tenantId: input.tenantId,
          projectId: input.projectId,
          runId: input.runId,
          lockKey: input.lockKey,
          commitSha: input.commitSha,
          steamBuildId: input.steamBuildId,
          targetMatrix: input.targetMatrix,
        }),
        tls: this.#tls,
        timeoutMs: this.#timeoutMs,
      });
    } catch {
      throw new WorkflowJobError("RUNNER_STEAM_INSTALL_PREPARATION_UNAVAILABLE");
    }
    if (response.statusCode !== 200) {
      throw new WorkflowJobError(
        response.statusCode === 409 ? "RUNNER_STEAM_INSTALL_PREPARATION_REJECTED" : "RUNNER_STEAM_INSTALL_PREPARATION_UNAVAILABLE",
        response.statusCode === 409,
      );
    }
    try { return parseReceipt(response.payload, input); }
    catch { throw new WorkflowJobError("RUNNER_STEAM_INSTALL_PREPARATION_RECEIPT_INVALID", true); }
  }
}

export async function runnerSteamInstallPreparationClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsRunnerSteamInstallPreparationClient> {
  const [key, certificate, ca] = await Promise.all([
    readRequiredFile(requiredEnv(env, "DEVILUDO_RUNNER_STEAM_PREPARER_TLS_KEY_FILE")),
    readRequiredFile(requiredEnv(env, "DEVILUDO_RUNNER_STEAM_PREPARER_TLS_CERT_FILE")),
    readRequiredFile(requiredEnv(env, "DEVILUDO_RUNNER_STEAM_PREPARER_CA_FILE")),
  ]);
  return new MtlsRunnerSteamInstallPreparationClient({
    endpoint: requiredEnv(env, "DEVILUDO_RUNNER_STEAM_PREPARER_URL"),
    tls: { key, certificate, ca },
    timeoutMs: seconds(env.DEVILUDO_RUNNER_STEAM_PREPARER_TIMEOUT_SECONDS, 600, 30, 600) * 1_000,
  });
}

function parseReceipt(
  value: unknown,
  input: Parameters<RunnerSteamInstallPreparationPort["prepare"]>[0],
): RunnerSteamInstallPreparationReceipt {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "executionLockId", "executionLockDigest", "sourceDigest", "steamAppId", "buildId",
    "betaBranch", "installGrantId", "targetMatrix", "created",
  ]);
  const targetMatrix = matrix(body.targetMatrix);
  if (body.schemaVersion !== "deviludo.steam-clean-install-preparation-receipt.v1"
    || body.buildId !== input.steamBuildId || JSON.stringify(targetMatrix) !== JSON.stringify(input.targetMatrix)
    || typeof body.created !== "boolean") invalid();
  return Object.freeze({
    executionLockId: required(body.executionLockId, UUID),
    executionLockDigest: required(body.executionLockDigest, SHA256),
    sourceDigest: required(body.sourceDigest, SHA256),
    steamAppId: required(body.steamAppId, APP_ID),
    buildId: required(body.buildId, BUILD_ID),
    betaBranch: fixedBetaBranch(body.betaBranch),
    installGrantId: required(body.installGrantId, SAFE_ID),
    targetMatrix,
    created: body.created,
  });
}

function validateInput(input: Parameters<RunnerSteamInstallPreparationPort["prepare"]>[0]): void {
  if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.runId)
    || !SHA256.test(input.lockKey) || !SHA1.test(input.commitSha) || !BUILD_ID.test(input.steamBuildId)
    || JSON.stringify(matrix(input.targetMatrix)) !== JSON.stringify(input.targetMatrix)) invalid();
}

function matrix(value: unknown): readonly TargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length
    || value.some((platform) => typeof platform !== "string" || !["windows", "linux", "macos"].includes(platform))) invalid();
  const sorted = [...value].sort() as TargetPlatform[];
  if (JSON.stringify(sorted) !== JSON.stringify(value)) invalid();
  return Object.freeze(sorted);
}

function fixedBetaBranch(value: unknown): string {
  const branch = required(value, BETA_BRANCH);
  if (branch === "default" || branch === "public") invalid();
  return branch;
}

function strictOrigin(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Runner Steam Preparer URL is invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Runner Steam Preparer URL is invalid");
  return new URL(url.origin);
}

function validateTls(tls: TestKitArtifactBrokerTls): void {
  for (const value of [tls.key, tls.certificate, tls.ca]) {
    if (!Buffer.isBuffer(value) || value.byteLength < 32 || value.byteLength > 1024 * 1024) {
      throw new Error("Runner Steam Preparer TLS material is invalid");
    }
  }
}

async function readRequiredFile(path: string): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) {
    throw new Error("Runner Steam Preparer TLS path is invalid");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) {
      throw new Error("Runner Steam Preparer TLS file is invalid");
    }
    return await file.readFile();
  } finally { await file.close(); }
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

function exactHealth(value: unknown, service: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).sort().join(",") === "service,status"
    && body.status === "ok" && body.service === service;
}

function required(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("Runner Steam Preparer timeout is invalid");
  return value;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Runner Steam Preparer timeout is invalid");
  }
  return parsed;
}

function invalid(): never {
  throw new Error("Runner Steam clean-install preparation contract is invalid");
}
