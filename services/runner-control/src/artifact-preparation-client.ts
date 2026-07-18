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

export interface RunnerArtifactPreparationReceipt {
  readonly executionLockId: string;
  readonly executionLockDigest: string;
  readonly sourceDigest: string;
  readonly sourceArtifactDigest: string;
  readonly sourceObjectKey: string;
  readonly testPlanDigest: string;
  readonly testPlanObjectKey: string;
  readonly created: boolean;
}

export interface RunnerArtifactPreparationPort {
  prepare(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly lockKey: string;
    readonly mode: "CANDIDATE" | "MAIN_RELEASE_GATE";
    readonly commitSha: string;
    readonly targetMatrix: readonly TargetPlatform[];
  }): Promise<RunnerArtifactPreparationReceipt>;
}

/** mTLS Broker that sends only the workflow trigger and accepts one exact immutable lock receipt. */
export class MtlsRunnerArtifactPreparationClient implements RunnerArtifactPreparationPort {
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
    this.#timeoutMs = integer(options.timeoutMs ?? 24 * 60 * 60_000, 30_000, 24 * 60 * 60_000);
    this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }

  async prepare(input: Parameters<RunnerArtifactPreparationPort["prepare"]>[0]): Promise<RunnerArtifactPreparationReceipt> {
    validateInput(input);
    const url = new URL(this.#endpoint.href);
    url.pathname = "/v1/source-execution-preparations";
    let response: Awaited<ReturnType<TestKitArtifactBrokerHttp>>;
    try {
      response = await this.#http({
        url,
        body: JSON.stringify({
          schemaVersion: "deviludo.source-execution-preparation-trigger.v1",
          tenantId: input.tenantId,
          projectId: input.projectId,
          runId: input.runId,
          lockKey: input.lockKey,
          mode: input.mode,
          commitSha: input.commitSha,
          targetMatrix: input.targetMatrix,
        }),
        tls: this.#tls,
        timeoutMs: this.#timeoutMs,
      });
    } catch {
      throw new WorkflowJobError("RUNNER_ARTIFACT_PREPARATION_UNAVAILABLE");
    }
    if (response.statusCode !== 200) {
      throw new WorkflowJobError(
        response.statusCode === 409 ? "RUNNER_ARTIFACT_PREPARATION_REJECTED" : "RUNNER_ARTIFACT_PREPARATION_UNAVAILABLE",
        response.statusCode === 409,
      );
    }
    try { return parseReceipt(response.payload, input); }
    catch { throw new WorkflowJobError("RUNNER_ARTIFACT_PREPARATION_RECEIPT_INVALID", true); }
  }
}

export async function runnerArtifactPreparationClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsRunnerArtifactPreparationClient> {
  const [key, certificate, ca] = await Promise.all([
    readRequiredFile(requiredEnv(env, "DEVILUDO_RUNNER_ARTIFACT_PREPARER_TLS_KEY_FILE")),
    readRequiredFile(requiredEnv(env, "DEVILUDO_RUNNER_ARTIFACT_PREPARER_TLS_CERT_FILE")),
    readRequiredFile(requiredEnv(env, "DEVILUDO_RUNNER_ARTIFACT_PREPARER_CA_FILE")),
  ]);
  return new MtlsRunnerArtifactPreparationClient({
    endpoint: requiredEnv(env, "DEVILUDO_RUNNER_ARTIFACT_PREPARER_URL"),
    tls: { key, certificate, ca },
    timeoutMs: seconds(env.DEVILUDO_RUNNER_ARTIFACT_PREPARER_TIMEOUT_SECONDS, 86_400, 30, 86_400) * 1_000,
  });
}

function parseReceipt(
  value: unknown,
  input: Parameters<RunnerArtifactPreparationPort["prepare"]>[0],
): RunnerArtifactPreparationReceipt {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "executionLockId", "executionLockDigest", "sourceDigest", "sourceArtifactDigest",
    "sourceObjectKey", "testPlanDigest", "testPlanObjectKey", "created",
  ]);
  const executionLockId = required(body.executionLockId, UUID);
  const executionLockDigest = required(body.executionLockDigest, SHA256);
  const sourceDigest = required(body.sourceDigest, SHA256);
  const sourceArtifactDigest = required(body.sourceArtifactDigest, SHA256);
  const testPlanDigest = required(body.testPlanDigest, SHA256);
  const expectedSourceKey = `tenants/${input.tenantId}/projects/${input.projectId}/sources/${sourceArtifactDigest}.tar.zst`;
  const expectedPlanKey = `tenants/${input.tenantId}/projects/${input.projectId}/test-plans/${testPlanDigest}.json`;
  if (body.schemaVersion !== "deviludo.source-execution-preparation-receipt.v1"
    || body.sourceObjectKey !== expectedSourceKey || body.testPlanObjectKey !== expectedPlanKey
    || typeof body.created !== "boolean") invalid();
  return Object.freeze({
    executionLockId,
    executionLockDigest,
    sourceDigest,
    sourceArtifactDigest,
    sourceObjectKey: expectedSourceKey,
    testPlanDigest,
    testPlanObjectKey: expectedPlanKey,
    created: body.created,
  });
}

function validateInput(input: Parameters<RunnerArtifactPreparationPort["prepare"]>[0]): void {
  if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.runId)
    || !SHA256.test(input.lockKey) || !SHA1.test(input.commitSha)
    || (input.mode !== "CANDIDATE" && input.mode !== "MAIN_RELEASE_GATE")
    || input.targetMatrix.length < 1 || input.targetMatrix.length > 3
    || JSON.stringify([...input.targetMatrix].sort()) !== JSON.stringify(input.targetMatrix)
    || new Set(input.targetMatrix).size !== input.targetMatrix.length
    || input.targetMatrix.some((platform) => !["windows", "linux", "macos"].includes(platform))) invalid();
}

function strictOrigin(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Runner Artifact Preparer URL is invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Runner Artifact Preparer URL is invalid");
  return new URL(url.origin);
}

function validateTls(tls: TestKitArtifactBrokerTls): void {
  for (const value of [tls.key, tls.certificate, tls.ca]) {
    if (!Buffer.isBuffer(value) || value.byteLength < 32 || value.byteLength > 1024 * 1024) {
      throw new Error("Runner Artifact Preparer TLS material is invalid");
    }
  }
}

async function readRequiredFile(path: string): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) {
    throw new Error("Runner Artifact Preparer TLS path is invalid");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) {
      throw new Error("Runner Artifact Preparer TLS file is invalid");
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
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("Runner Artifact Preparer timeout is invalid");
  return value;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Runner Artifact Preparer timeout is invalid");
  }
  return parsed;
}

function invalid(): never {
  throw new Error("Runner Artifact Preparer contract is invalid");
}
