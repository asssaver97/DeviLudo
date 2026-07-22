import { readFile } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { WorkflowJobError } from "../../temporal/src/job-processor";
import type { ScmMergeWorkflowPort, ScmMergeWorkflowReceipt } from "./workflow-handler";

const MAX_RESPONSE_BYTES = 512 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,99}$/;

type MergeInput = Parameters<ScmMergeWorkflowPort["mergeAcceptedCandidate"]>[0];

export interface ScmMergeBrokerTlsMaterial {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export interface ScmMergeBrokerHttpRequest {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly tls: ScmMergeBrokerTlsMaterial;
}

export interface ScmMergeBrokerHttpResponse {
  readonly statusCode: number;
  readonly payload: unknown;
}

export type ScmMergeBrokerHttp = (
  url: URL,
  request: ScmMergeBrokerHttpRequest,
) => Promise<ScmMergeBrokerHttpResponse>;

type MergeStatus = {
  readonly status: "RUNNING" | "COMPLETED";
  readonly mergeId: string;
  readonly receipt: ScmMergeWorkflowReceipt | null;
};

/**
 * Workload-authenticated connector to the isolated GitHub App Broker. The
 * destination process sends only immutable IDs/digests and never receives an
 * installation token or GitHub App private key.
 */
export class MtlsScmMergeBroker implements ScmMergeWorkflowPort {
  readonly #endpoint: URL;
  readonly #tls: ScmMergeBrokerTlsMaterial;
  readonly #requestTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #maxWaitMs: number;
  readonly #http: ScmMergeBrokerHttp;
  readonly #pause: (delayMs: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: ScmMergeBrokerTlsMaterial;
    readonly requestTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly maxWaitMs?: number;
    readonly http?: ScmMergeBrokerHttp;
    readonly pause?: (delayMs: number) => Promise<void>;
    readonly now?: () => number;
  }) {
    this.#endpoint = strictEndpoint(options.endpoint);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? 30_000, 1_000, 600_000, "request timeout");
    this.#pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 5_000, 250, 60_000, "poll interval");
    this.#maxWaitMs = boundedInteger(options.maxWaitMs ?? 30 * 60_000, 30_000, 2 * 60 * 60_000, "maximum wait");
    this.#http = options.http ?? scmMergeBrokerHttpsJson;
    this.#pause = options.pause ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.#now = options.now ?? Date.now;
  }

  async mergeAcceptedCandidate(input: MergeInput): Promise<ScmMergeWorkflowReceipt> {
    validateInput(input);
    const body = JSON.stringify({
      schemaVersion: "deviludo.scm-merge.v1",
      operationKey: input.operationKey,
      requestDigest: input.requestDigest,
      tenantId: input.tenantId,
      projectId: input.projectId,
      workflowId: input.workflowId,
      runId: input.runId,
      specRevisionId: input.specRevisionId,
      candidateCommitSha: input.candidateCommitSha,
      pullRequestNumber: input.pullRequestNumber,
      evidenceBundleId: input.evidenceBundleId,
      acceptanceSignalId: input.acceptanceSignalId,
    });
    const response = await this.#http(this.#endpoint, {
      method: "POST",
      timeoutMs: this.#requestTimeoutMs,
      tls: this.#tls,
      headers: Object.freeze({
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": input.operationKey,
        "x-deviludo-request-digest": input.requestDigest,
      }),
      body,
    });
    const initial = parseStatus(response, input);
    if (initial.receipt) return initial.receipt;
    const startedAt = validNow(this.#now());
    const deadline = startedAt + this.#maxWaitMs;
    const statusUrl = statusEndpoint(this.#endpoint, initial.mergeId);
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
        }),
      }), input);
      if (current.mergeId !== initial.mergeId) throw new Error("SCM merge Broker changed the immutable merge identity");
      if (current.receipt) return current.receipt;
    }
    throw new WorkflowJobError("SCM_MERGE_WAIT_TIMEOUT");
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
    if (response.statusCode !== 200
      || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["schemaVersion", "service", "status"])
      || body.schemaVersion !== "deviludo.scm-merge-health.v1"
      || body.status !== "ok" || body.service !== "deviludo-scm-merge-broker") {
      throw new Error("SCM merge Broker readiness probe failed");
    }
  }
}

export async function scmMergeBrokerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsScmMergeBroker> {
  const [key, certificate, ca] = await Promise.all([
    readRequiredFile(env, "DEVILUDO_SCM_MERGE_BROKER_TLS_KEY_FILE"),
    readRequiredFile(env, "DEVILUDO_SCM_MERGE_BROKER_TLS_CERT_FILE"),
    readRequiredFile(env, "DEVILUDO_SCM_MERGE_BROKER_CA_FILE"),
  ]);
  return new MtlsScmMergeBroker({
    endpoint: requiredEnv(env, "DEVILUDO_SCM_MERGE_BROKER_URL"),
    tls: { key, certificate, ca },
    requestTimeoutMs: seconds(env.DEVILUDO_SCM_MERGE_REQUEST_TIMEOUT_SECONDS, 30, 1, 600) * 1_000,
    pollIntervalMs: seconds(env.DEVILUDO_SCM_MERGE_POLL_SECONDS, 5, 1, 60) * 1_000,
    maxWaitMs: seconds(env.DEVILUDO_SCM_MERGE_MAX_WAIT_SECONDS, 1_800, 30, 7_200) * 1_000,
  });
}

export async function scmMergeBrokerHttpsJson(
  url: URL,
  input: ScmMergeBrokerHttpRequest,
): Promise<ScmMergeBrokerHttpResponse> {
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
        reject(new Error("SCM merge Broker response exceeded the limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("SCM merge Broker response exceeded the limit"));
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
          reject(new Error("SCM merge Broker returned invalid JSON"));
        }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("SCM merge Broker request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function parseStatus(response: ScmMergeBrokerHttpResponse, expected: MergeInput): MergeStatus {
  if (response.statusCode !== 200 && response.statusCode !== 202) {
    throw new Error(`SCM merge Broker rejected the request with status ${response.statusCode}`);
  }
  const body = record(response.payload);
  if (body.operationKey !== expected.operationKey || body.requestDigest !== expected.requestDigest) invalidResponse();
  const mergeId = stringId(body.mergeId);
  if (body.status === "FAILED") {
    if (response.statusCode !== 200 || typeof body.errorCode !== "string" || !ERROR_CODE.test(body.errorCode)
      || typeof body.terminal !== "boolean" || (body.receipt !== null && body.receipt !== undefined)) invalidResponse();
    throw new WorkflowJobError(body.errorCode, body.terminal);
  }
  if (body.status === "RUNNING") {
    if (response.statusCode !== 202 || (body.receipt !== null && body.receipt !== undefined)) invalidResponse();
    return Object.freeze({ status: "RUNNING", mergeId, receipt: null });
  }
  if (body.status !== "COMPLETED" || response.statusCode !== 200) invalidResponse();
  return Object.freeze({ status: "COMPLETED", mergeId, receipt: parseReceipt(body.receipt, expected) });
}

function parseReceipt(value: unknown, expected: MergeInput): ScmMergeWorkflowReceipt {
  const body = record(value);
  if (!SAFE_ID.test(String(body.receiptId ?? "")) || body.runId !== expected.runId
    || body.candidateCommitSha !== expected.candidateCommitSha
    || body.pullRequestNumber !== expected.pullRequestNumber
    || body.evidenceBundleId !== expected.evidenceBundleId
    || body.acceptanceSignalId !== expected.acceptanceSignalId
    || !SHA1.test(String(body.mergeCommitSha ?? ""))
    || !SHA1.test(String(body.defaultBranchHeadSha ?? ""))
    || !SHA256.test(String(body.mainSourceDigest ?? ""))
    || typeof body.requiresFreshMainSnapshot !== "boolean"
    || body.requiresFreshMainSnapshot !== (body.defaultBranchHeadSha !== body.mergeCommitSha)) invalidResponse();
  return Object.freeze({
    receiptId: body.receiptId as string,
    runId: body.runId as string,
    candidateCommitSha: body.candidateCommitSha as string,
    pullRequestNumber: body.pullRequestNumber as number,
    evidenceBundleId: body.evidenceBundleId as string,
    acceptanceSignalId: body.acceptanceSignalId as string,
    mergeCommitSha: body.mergeCommitSha as string,
    defaultBranchHeadSha: body.defaultBranchHeadSha as string,
    mainSourceDigest: body.mainSourceDigest as string,
    requiresFreshMainSnapshot: body.requiresFreshMainSnapshot as boolean,
  });
}

function validateInput(input: MergeInput): void {
  if (!/^workflow-job:[a-f0-9-]{36}$/.test(input.operationKey) || !SHA256.test(input.requestDigest)
    || !UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.runId)
    || !SAFE_ID.test(input.workflowId) || !UUID.test(input.specRevisionId)
    || !SHA1.test(input.candidateCommitSha) || !Number.isSafeInteger(input.pullRequestNumber)
    || input.pullRequestNumber < 1 || !UUID.test(input.evidenceBundleId) || !SAFE_ID.test(input.acceptanceSignalId)) {
    throw new WorkflowJobError("SCM_MERGE_BINDING_INVALID", true);
  }
}

function strictEndpoint(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.port && url.port !== "443" || url.pathname !== "/v1/merges") {
    throw new Error("SCM merge Broker endpoint is invalid");
  }
  return url;
}

function statusEndpoint(base: URL, mergeId: string): URL {
  const url = new URL(base.href);
  url.pathname = `/v1/merges/${encodeURIComponent(mergeId)}`;
  return url;
}

function validateTls(tls: ScmMergeBrokerTlsMaterial): void {
  for (const value of [tls.key, tls.certificate, tls.ca]) {
    if (!Buffer.isBuffer(value) || value.byteLength < 32 || value.byteLength > 1024 * 1024) {
      throw new Error("SCM merge Broker TLS material is invalid");
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function stringId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) invalidResponse();
  return value;
}

function invalidResponse(): never {
  throw new Error("SCM merge Broker returned an invalid bound response");
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
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`SCM merge Broker ${label} is invalid`);
  return value;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("SCM merge Broker duration is invalid");
  }
  return parsed;
}

function validNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("SCM merge Broker clock is invalid");
  return value;
}
