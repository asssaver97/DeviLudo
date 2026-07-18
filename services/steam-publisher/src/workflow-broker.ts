import { readFile } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { WorkflowJobError } from "../../temporal/src/job-processor";
import type {
  SteamDefaultBranchWorkflowPort,
  SteamDefaultBranchWorkflowReceipt,
  SteamPrivateBetaWorkflowPort,
  SteamPrivateBetaWorkflowReceipt,
} from "./workflow-handler";

const MAX_RESPONSE_BYTES = 512 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[1-9][0-9]{0,19}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,99}$/;

type UploadInput = Parameters<SteamPrivateBetaWorkflowPort["upload"]>[0];
type PublishInput = Parameters<SteamDefaultBranchWorkflowPort["publish"]>[0];
type SteamOperationKind = "PRIVATE_BETA_UPLOAD" | "DEFAULT_BRANCH_PUBLISH";
type SteamWorkflowReceipt = SteamPrivateBetaWorkflowReceipt | SteamDefaultBranchWorkflowReceipt;

export interface SteamWorkflowBrokerTlsMaterial {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export interface SteamWorkflowBrokerHttpRequest {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly tls: SteamWorkflowBrokerTlsMaterial;
}

export interface SteamWorkflowBrokerHttpResponse {
  readonly statusCode: number;
  readonly payload: unknown;
}

export type SteamWorkflowBrokerHttp = (
  url: URL,
  request: SteamWorkflowBrokerHttpRequest,
) => Promise<SteamWorkflowBrokerHttpResponse>;

type OperationStatus = {
  readonly status: "RUNNING" | "COMPLETED";
  readonly operationId: string;
  readonly receipt: SteamWorkflowReceipt | null;
};

export interface SteamWorkflowBrokerIdentity {
  readonly version: string;
  readonly binaryDigest: string;
}

/**
 * Both Steam workflow commands use one isolated Broker. The Broker alone may
 * materialize config.vdf, call SteamCMD/SteamPipe or use a build account.
 */
export class MtlsSteamWorkflowBroker implements SteamPrivateBetaWorkflowPort, SteamDefaultBranchWorkflowPort {
  readonly #endpoint: URL;
  readonly #tls: SteamWorkflowBrokerTlsMaterial;
  readonly #requestTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #maxWaitMs: number;
  readonly #http: SteamWorkflowBrokerHttp;
  readonly #expectedBroker: SteamWorkflowBrokerIdentity;
  readonly #pause: (delayMs: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: SteamWorkflowBrokerTlsMaterial;
    readonly expectedBroker: SteamWorkflowBrokerIdentity;
    readonly requestTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly maxWaitMs?: number;
    readonly http?: SteamWorkflowBrokerHttp;
    readonly pause?: (delayMs: number) => Promise<void>;
    readonly now?: () => number;
  }) {
    this.#endpoint = strictEndpoint(options.endpoint);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#expectedBroker = brokerIdentity(options.expectedBroker);
    this.#requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? 30_000, 1_000, 600_000, "request timeout");
    this.#pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 10_000, 250, 60_000, "poll interval");
    this.#maxWaitMs = boundedInteger(options.maxWaitMs ?? 2 * 60 * 60_000, 30_000, 24 * 60 * 60_000, "maximum wait");
    this.#http = options.http ?? steamWorkflowBrokerHttpsJson;
    this.#pause = options.pause ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.#now = options.now ?? Date.now;
  }

  async upload(input: UploadInput): Promise<SteamPrivateBetaWorkflowReceipt> {
    validateUpload(input);
    return await this.#execute("PRIVATE_BETA_UPLOAD", input) as SteamPrivateBetaWorkflowReceipt;
  }

  async publish(input: PublishInput): Promise<SteamDefaultBranchWorkflowReceipt> {
    validatePublish(input);
    return await this.#execute("DEFAULT_BRANCH_PUBLISH", input) as SteamDefaultBranchWorkflowReceipt;
  }

  async probe(): Promise<void> {
    const endpoint = new URL(this.#endpoint.href);
    endpoint.pathname = "/healthz";
    const response = await this.#http(endpoint, {
      method: "GET",
      timeoutMs: this.#requestTimeoutMs,
      tls: this.#tls,
      headers: Object.freeze({ accept: "application/json" }),
    });
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "status", "service", "version", "binaryDigest"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.steam-workflow-broker-health.v1"
      || body.status !== "ok" || body.service !== "deviludo-steam-workflow-broker"
      || body.version !== this.#expectedBroker.version || body.binaryDigest !== this.#expectedBroker.binaryDigest) {
      throw new Error("Steam workflow Broker readiness probe failed");
    }
  }

  async #execute(kind: SteamOperationKind, input: UploadInput | PublishInput): Promise<SteamWorkflowReceipt> {
    const body = JSON.stringify({
      schemaVersion: "deviludo.steam-workflow.v1",
      kind,
      operationKey: input.operationKey,
      requestDigest: input.requestDigest,
      tenantId: input.tenantId,
      projectId: input.projectId,
      workflowId: input.workflowId,
      runId: input.runId,
      ...(kind === "PRIVATE_BETA_UPLOAD" ? {
        mainCommitSha: (input as UploadInput).mainCommitSha,
        mainEvidenceBundleId: (input as UploadInput).mainEvidenceBundleId,
        mfaApprovalId: (input as UploadInput).mfaApprovalId,
        targetMatrix: (input as UploadInput).targetMatrix,
      } : {
        betaBuildId: (input as PublishInput).betaBuildId,
        externalApprovalIds: (input as PublishInput).externalApprovalIds,
      }),
    });
    const initial = parseStatus(await this.#http(this.#endpoint, {
      method: "POST",
      timeoutMs: this.#requestTimeoutMs,
      tls: this.#tls,
      headers: Object.freeze({
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": input.operationKey,
        "x-deviludo-request-digest": input.requestDigest,
        "x-deviludo-tenant-id": input.tenantId,
      }),
      body,
    }), kind, input);
    if (initial.receipt) return initial.receipt;
    const startedAt = validNow(this.#now());
    const deadline = startedAt + this.#maxWaitMs;
    const statusUrl = statusEndpoint(this.#endpoint, initial.operationId);
    while (validNow(this.#now()) < deadline) {
      await input.heartbeat();
      await this.#pause(this.#pollIntervalMs);
      const current = parseStatus(await this.#http(statusUrl, {
        method: "GET",
        timeoutMs: this.#requestTimeoutMs,
        tls: this.#tls,
        headers: Object.freeze({
          accept: "application/json",
          "idempotency-key": input.operationKey,
          "x-deviludo-request-digest": input.requestDigest,
          "x-deviludo-tenant-id": input.tenantId,
        }),
      }), kind, input);
      if (current.operationId !== initial.operationId) throw new Error("Steam workflow Broker changed the immutable operation identity");
      if (current.receipt) return current.receipt;
    }
    throw new WorkflowJobError("STEAM_OPERATION_WAIT_TIMEOUT");
  }
}

export async function steamWorkflowBrokerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsSteamWorkflowBroker> {
  const [key, certificate, ca] = await Promise.all([
    readRequiredFile(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_TLS_KEY_FILE"),
    readRequiredFile(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_TLS_CERT_FILE"),
    readRequiredFile(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_CA_FILE"),
  ]);
  return new MtlsSteamWorkflowBroker({
    endpoint: requiredEnv(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_URL"),
    tls: { key, certificate, ca },
    expectedBroker: {
      version: requiredEnv(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_VERSION"),
      binaryDigest: requiredEnv(env, "DEVILUDO_STEAM_WORKFLOW_BROKER_BINARY_DIGEST"),
    },
    requestTimeoutMs: seconds(env.DEVILUDO_STEAM_OPERATION_REQUEST_TIMEOUT_SECONDS, 30, 1, 600) * 1_000,
    pollIntervalMs: seconds(env.DEVILUDO_STEAM_OPERATION_POLL_SECONDS, 10, 1, 60) * 1_000,
    maxWaitMs: seconds(env.DEVILUDO_STEAM_OPERATION_MAX_WAIT_SECONDS, 7_200, 30, 86_400) * 1_000,
  });
}

export async function steamWorkflowBrokerHttpsJson(
  url: URL,
  input: SteamWorkflowBrokerHttpRequest,
): Promise<SteamWorkflowBrokerHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...input.headers };
    if (input.body !== undefined) headers["content-length"] = String(Buffer.byteLength(input.body));
    const options: RequestOptions = {
      method: input.method,
      headers,
      key: input.tls.key,
      cert: input.tls.certificate,
      ca: input.tls.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: url.hostname,
    };
    const request = httpsRequest(url, options, (response) => {
      const contentLength = Number(response.headers["content-length"] ?? 0);
      if (contentLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(new Error("Steam workflow Broker response exceeded the limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Steam workflow Broker response exceeded the limit"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve(Object.freeze({
            statusCode: response.statusCode ?? 503,
            payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          }));
        } catch {
          reject(new Error("Steam workflow Broker returned invalid JSON"));
        }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Steam workflow Broker request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function parseStatus(
  response: SteamWorkflowBrokerHttpResponse,
  kind: SteamOperationKind,
  expected: UploadInput | PublishInput,
): OperationStatus {
  if (response.statusCode !== 200 && response.statusCode !== 202) {
    throw new Error(`Steam workflow Broker rejected the request with status ${response.statusCode}`);
  }
  const body = record(response.payload);
  if (body.schemaVersion !== "deviludo.steam-workflow-operation-status.v1"
    || body.kind !== kind || body.operationKey !== expected.operationKey || body.requestDigest !== expected.requestDigest) invalidResponse();
  const operationId = stringId(body.operationId);
  if (body.status === "FAILED") {
    exactKeys(body, ["schemaVersion", "status", "kind", "operationId", "operationKey", "requestDigest", "errorCode", "terminal", "receipt"]);
    if (response.statusCode !== 200 || typeof body.errorCode !== "string" || !ERROR_CODE.test(body.errorCode)
      || typeof body.terminal !== "boolean" || (body.receipt !== null && body.receipt !== undefined)) invalidResponse();
    throw new WorkflowJobError(body.errorCode, body.terminal);
  }
  if (body.status === "RUNNING") {
    exactKeys(body, ["schemaVersion", "status", "kind", "operationId", "operationKey", "requestDigest", "receipt"]);
    if (response.statusCode !== 202 || (body.receipt !== null && body.receipt !== undefined)) invalidResponse();
    return Object.freeze({ status: "RUNNING", operationId, receipt: null });
  }
  if (body.status !== "COMPLETED" || response.statusCode !== 200) invalidResponse();
  exactKeys(body, ["schemaVersion", "status", "kind", "operationId", "operationKey", "requestDigest", "receipt"]);
  const receipt = kind === "PRIVATE_BETA_UPLOAD"
    ? parseUploadReceipt(body.receipt, expected as UploadInput)
    : parsePublishReceipt(body.receipt, expected as PublishInput);
  return Object.freeze({ status: "COMPLETED", operationId, receipt });
}

function parseUploadReceipt(value: unknown, expected: UploadInput): SteamPrivateBetaWorkflowReceipt {
  const body = record(value);
  exactKeys(body, ["receiptId", "runId", "mainCommitSha", "mainEvidenceBundleId", "mfaApprovalId", "targetMatrix", "buildId"]);
  const targetMatrix = parseMatrix(body.targetMatrix);
  if (!SAFE_ID.test(String(body.receiptId ?? "")) || body.runId !== expected.runId
    || body.mainCommitSha !== expected.mainCommitSha || body.mainEvidenceBundleId !== expected.mainEvidenceBundleId
    || body.mfaApprovalId !== expected.mfaApprovalId || !BUILD_ID.test(String(body.buildId ?? ""))
    || JSON.stringify(targetMatrix) !== JSON.stringify(expected.targetMatrix)) invalidResponse();
  return Object.freeze({
    receiptId: body.receiptId as string,
    runId: body.runId as string,
    mainCommitSha: body.mainCommitSha as string,
    mainEvidenceBundleId: body.mainEvidenceBundleId as string,
    mfaApprovalId: body.mfaApprovalId as string,
    targetMatrix,
    buildId: body.buildId as string,
  });
}

function parsePublishReceipt(value: unknown, expected: PublishInput): SteamDefaultBranchWorkflowReceipt {
  const body = record(value);
  exactKeys(body, ["receiptId", "releaseId", "runId", "betaBuildId", "defaultBranchBuildId", "externalApprovalIds"]);
  const approvals = parseIds(body.externalApprovalIds, 3);
  if (!SAFE_ID.test(String(body.receiptId ?? "")) || !SAFE_ID.test(String(body.releaseId ?? ""))
    || body.runId !== expected.runId || body.betaBuildId !== expected.betaBuildId
    || body.defaultBranchBuildId !== expected.betaBuildId
    || JSON.stringify(approvals) !== JSON.stringify(expected.externalApprovalIds)) invalidResponse();
  return Object.freeze({
    receiptId: body.receiptId as string,
    releaseId: body.releaseId as string,
    runId: body.runId as string,
    betaBuildId: body.betaBuildId as string,
    defaultBranchBuildId: body.defaultBranchBuildId as string,
    externalApprovalIds: approvals,
  });
}

function validateUpload(input: UploadInput): void {
  validateCommon(input);
  if (!SHA1.test(input.mainCommitSha) || !UUID.test(input.mainEvidenceBundleId)
    || !UUID.test(input.mfaApprovalId)) invalidBinding();
  parseMatrix(input.targetMatrix);
}

function validatePublish(input: PublishInput): void {
  validateCommon(input);
  if (!BUILD_ID.test(input.betaBuildId)) invalidBinding();
  const approvals = parseIds(input.externalApprovalIds, 3);
  if (JSON.stringify(approvals) !== JSON.stringify(input.externalApprovalIds)) invalidBinding();
}

function validateCommon(input: UploadInput | PublishInput): void {
  if (!/^workflow-job:[a-f0-9-]{36}$/.test(input.operationKey) || !SHA256.test(input.requestDigest)
    || !UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.runId)
    || !SAFE_ID.test(input.workflowId)) invalidBinding();
}

function parseMatrix(value: unknown): readonly ("windows" | "linux" | "macos")[] {
  if (!Array.isArray(value) || !value.length || value.length > 3 || new Set(value).size !== value.length
    || value.some((entry) => entry !== "windows" && entry !== "linux" && entry !== "macos")) invalidResponse();
  return Object.freeze([...value]) as readonly ("windows" | "linux" | "macos")[];
}

function parseIds(value: unknown, exactLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length !== exactLength || new Set(value).size !== value.length
    || value.some((entry) => typeof entry !== "string" || !SAFE_ID.test(entry))) invalidResponse();
  return Object.freeze([...value]) as readonly string[];
}

function strictEndpoint(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.port && url.port !== "443" || url.pathname !== "/v1/steam-operations") {
    throw new Error("Steam workflow Broker endpoint is invalid");
  }
  return url;
}

function statusEndpoint(base: URL, operationId: string): URL {
  const url = new URL(base.href);
  url.pathname = `/v1/steam-operations/${encodeURIComponent(operationId)}`;
  return url;
}

function validateTls(tls: SteamWorkflowBrokerTlsMaterial): void {
  for (const value of [tls.key, tls.certificate, tls.ca]) {
    if (!Buffer.isBuffer(value) || value.byteLength < 32 || value.byteLength > 1024 * 1024) {
      throw new Error("Steam workflow Broker TLS material is invalid");
    }
  }
}

function brokerIdentity(value: SteamWorkflowBrokerIdentity): SteamWorkflowBrokerIdentity {
  const body = record(value);
  exactKeys(body, ["version", "binaryDigest"]);
  if (typeof body.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/.test(body.version)
    || /(?:latest|stable|default)/i.test(body.version)
    || typeof body.binaryDigest !== "string" || !SHA256.test(body.binaryDigest)) invalidBinding();
  return Object.freeze({ version: body.version, binaryDigest: body.binaryDigest });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalidResponse();
}

function stringId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) invalidResponse();
  return value;
}

function invalidBinding(): never {
  throw new WorkflowJobError("STEAM_WORKFLOW_BINDING_INVALID", true);
}

function invalidResponse(): never {
  throw new Error("Steam workflow Broker returned an invalid bound response");
}

async function readRequiredFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = requiredEnv(env, name);
  if (!path.startsWith("/") || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} path is invalid`);
  const value = await readFile(path);
  if (value.byteLength < 32 || value.byteLength > 1024 * 1024) throw new Error(`${name} file is invalid`);
  return value;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Steam workflow Broker ${label} is invalid`);
  return value;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Steam workflow Broker duration is invalid");
  }
  return parsed;
}

function validNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Steam workflow Broker clock is invalid");
  return value;
}
