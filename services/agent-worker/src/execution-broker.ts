import { readFile } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { assertPinnedModelId } from "../../../lib/agent/providers";
import { validateAgentFailureDiagnostic } from "../../../lib/agent/failure-diagnostics";
import { validateAgentCodeReviewReceipt } from "../../../lib/agent/code-review";
import {
  AgentProviderUnavailableError,
  type AgentWorkflowRun,
  type AgentWorkflowRunReceipt,
  type LockedAgentWorkflowPort,
} from "./workflow-handler";
import { AgentExecutionCancelledError } from "./workflow-errors";

export { AgentExecutionCancelledError } from "./workflow-errors";

const MAX_RESPONSE_BYTES = 512 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256_IMAGE = /^sha256:[a-f0-9]{64}$/;

export interface AgentExecutionBrokerTlsMaterial {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export interface AgentExecutionBrokerHttpRequest {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly tls: AgentExecutionBrokerTlsMaterial;
}

export interface AgentExecutionBrokerHttpResponse {
  readonly statusCode: number;
  readonly payload: unknown;
}

export type AgentExecutionBrokerHttp = (
  url: URL,
  request: AgentExecutionBrokerHttpRequest,
) => Promise<AgentExecutionBrokerHttpResponse>;

export type AgentExecutionBrokerPause = (delayMs: number) => Promise<void>;

type BrokerStatus = {
  readonly status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  readonly runId: string;
  readonly providerRevisionId: string;
  readonly receipt: AgentWorkflowRunReceipt | null;
};

/**
 * Production connector for the isolated microVM execution broker. The
 * destination host submits identifiers and immutable digests only; the broker
 * resolves the lock and short-lived inference token inside its trust boundary.
 */
export class MtlsAgentExecutionBroker implements LockedAgentWorkflowPort {
  readonly #endpoint: URL;
  readonly #tls: AgentExecutionBrokerTlsMaterial;
  readonly #requestTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #maxWaitMs: number;
  readonly #http: AgentExecutionBrokerHttp;
  readonly #pause: AgentExecutionBrokerPause;
  readonly #now: () => number;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: AgentExecutionBrokerTlsMaterial;
    readonly requestTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly maxWaitMs?: number;
    readonly http?: AgentExecutionBrokerHttp;
    readonly pause?: AgentExecutionBrokerPause;
    readonly now?: () => number;
  }) {
    this.#endpoint = strictBrokerEndpoint(options.endpoint);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? 30_000, 1_000, 600_000, "request timeout");
    this.#pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 5_000, 250, 60_000, "poll interval");
    this.#maxWaitMs = boundedInteger(options.maxWaitMs ?? 2 * 60 * 60_000, 30_000, 24 * 60 * 60_000, "maximum wait");
    this.#http = options.http ?? agentExecutionBrokerHttpsJson;
    this.#pause = options.pause ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.#now = options.now ?? Date.now;
  }

  async start(input: Parameters<LockedAgentWorkflowPort["start"]>[0]): Promise<AgentWorkflowRun> {
    validateStart(input);
    const body = JSON.stringify({
      schemaVersion: "deviludo.agent-execution.v1",
      operationKey: input.operationKey,
      requestDigest: input.requestDigest,
      tenantId: input.tenantId,
      projectId: input.projectId,
      workflowId: input.workflowId,
      lockedRunConfigurationId: input.lockedRunConfigurationId,
      expectedRunId: input.expectedRunId,
      iteration: input.iteration,
      repairAttempts: input.repairAttempts,
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
        "x-deviludo-tenant-id": input.tenantId,
      }),
      body,
    });
    const initial = parseStatus(response, input.lockedRunConfigurationId);
    if (initial.status === "CANCELLED") {
      throw new AgentExecutionCancelledError(initial.runId, initial.providerRevisionId);
    }
    let completion: Promise<AgentWorkflowRunReceipt> | null = null;
    return Object.freeze({
      runId: initial.runId,
      providerRevisionId: initial.providerRevisionId,
      complete: () => {
        completion ??= initial.receipt
          ? Promise.resolve(initial.receipt)
          : this.#waitForCompletion(input, initial);
        return completion;
      },
    });
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
    if (response.statusCode !== 200 || body.status !== "ok"
      || body.service !== "deviludo-agent-execution-broker") {
      throw new Error("Agent execution Broker readiness probe failed");
    }
  }

  async #waitForCompletion(
    input: Parameters<LockedAgentWorkflowPort["start"]>[0],
    initial: BrokerStatus,
  ): Promise<AgentWorkflowRunReceipt> {
    const startedAt = validNow(this.#now());
    const deadline = startedAt + this.#maxWaitMs;
    const statusUrl = statusEndpoint(this.#endpoint, initial.runId);
    while (validNow(this.#now()) < deadline) {
      await this.#pause(this.#pollIntervalMs);
      await input.heartbeat();
      const response = await this.#http(statusUrl, {
        method: "GET",
        timeoutMs: this.#requestTimeoutMs,
        tls: this.#tls,
        headers: Object.freeze({
          accept: "application/json",
          "idempotency-key": input.operationKey,
          "x-deviludo-request-digest": input.requestDigest,
          "x-deviludo-tenant-id": input.tenantId,
        }),
      });
      const current = parseStatus(response, input.lockedRunConfigurationId);
      if (current.runId !== initial.runId || current.providerRevisionId !== initial.providerRevisionId) {
        throw new Error("Agent execution Broker changed an immutable run binding");
      }
      if (current.status === "CANCELLED") {
        throw new AgentExecutionCancelledError(current.runId, current.providerRevisionId);
      }
      if (current.receipt) return current.receipt;
    }
    throw new Error("Agent execution Broker did not complete within the configured wait");
  }
}

export async function agentExecutionBrokerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsAgentExecutionBroker> {
  const [key, certificate, ca] = await Promise.all([
    readRequiredFile(env, "DEVILUDO_AGENT_EXECUTION_BROKER_TLS_KEY_FILE"),
    readRequiredFile(env, "DEVILUDO_AGENT_EXECUTION_BROKER_TLS_CERT_FILE"),
    readRequiredFile(env, "DEVILUDO_AGENT_EXECUTION_BROKER_CA_FILE"),
  ]);
  return new MtlsAgentExecutionBroker({
    endpoint: requiredEnv(env, "DEVILUDO_AGENT_EXECUTION_BROKER_URL"),
    tls: { key, certificate, ca },
    requestTimeoutMs: seconds(env.DEVILUDO_AGENT_EXECUTION_REQUEST_TIMEOUT_SECONDS, 30, 1, 600) * 1_000,
    pollIntervalMs: seconds(env.DEVILUDO_AGENT_EXECUTION_POLL_SECONDS, 5, 1, 60) * 1_000,
    maxWaitMs: seconds(env.DEVILUDO_AGENT_EXECUTION_MAX_WAIT_SECONDS, 7_200, 30, 86_400) * 1_000,
  });
}

export async function agentExecutionBrokerHttpsJson(
  url: URL,
  input: AgentExecutionBrokerHttpRequest,
): Promise<AgentExecutionBrokerHttpResponse> {
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
        reject(new Error("Agent execution Broker response exceeded the limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Agent execution Broker response exceeded the limit"));
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
          reject(new Error("Agent execution Broker returned invalid JSON"));
        }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Agent execution Broker request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function parseStatus(response: AgentExecutionBrokerHttpResponse, lockedId: string): BrokerStatus {
  if (response.statusCode === 409) throw providerUnavailable(response.payload);
  if (response.statusCode !== 200 && response.statusCode !== 202) {
    throw new Error(`Agent execution Broker rejected the request with status ${response.statusCode}`);
  }
  const body = record(response.payload);
  const status = body.status;
  if (status !== "RUNNING" && status !== "COMPLETED" && status !== "FAILED" && status !== "CANCELLED") invalidResponse();
  const runId = stringId(body.runId);
  const providerRevisionId = stringId(body.providerRevisionId);
  if ((response.statusCode === 202) !== (status === "RUNNING")) invalidResponse();
  if (status === "RUNNING" || status === "CANCELLED") {
    if (body.receipt !== null && body.receipt !== undefined) invalidResponse();
    return Object.freeze({ status, runId, providerRevisionId, receipt: null });
  }
  const receipt = parseReceipt(body.receipt, status, lockedId, runId, providerRevisionId);
  return Object.freeze({ status, runId, providerRevisionId, receipt });
}

function parseReceipt(
  value: unknown,
  status: "COMPLETED" | "FAILED",
  lockedId: string,
  runId: string,
  providerRevisionId: string,
): AgentWorkflowRunReceipt {
  const body = record(value);
  if (body.status !== status || body.runId !== runId
    || body.lockedRunConfigurationId !== lockedId || body.providerRevisionId !== providerRevisionId
    || (body.agent !== "claude-code" && body.agent !== "codex-cli")
    || !SAFE_ID.test(String(body.profileRevisionId ?? ""))
    || !SAFE_ID.test(String(body.installationId ?? ""))
    || !SHA256_IMAGE.test(String(body.imageDigest ?? ""))
    || !validModel(body.model) || !SAFE_ID.test(String(body.receiptId ?? ""))) invalidResponse();
  const completed = status === "COMPLETED";
  let codeReviewReceipt = null;
  if (completed) {
    codeReviewReceipt = validateAgentCodeReviewReceipt(body.codeReviewReceipt);
    if (!SHA1.test(String(body.candidateCommitSha ?? ""))
      || !Number.isSafeInteger(body.draftPullRequest) || (body.draftPullRequest as number) < 1
      || codeReviewReceipt.runId !== runId || codeReviewReceipt.profileRevisionId !== body.profileRevisionId
      || codeReviewReceipt.installationId !== body.installationId || codeReviewReceipt.imageDigest !== body.imageDigest
      || codeReviewReceipt.model !== body.model
      || body.diagnosticId !== null || body.diagnostic !== null && body.diagnostic !== undefined) invalidResponse();
  }
  if (!completed && (!SAFE_ID.test(String(body.diagnosticId ?? ""))
    || body.candidateCommitSha !== null || body.draftPullRequest !== null || body.codeReviewReceipt !== null)) invalidResponse();
  const diagnostic = completed || body.diagnostic === null || body.diagnostic === undefined
    ? null
    : validateAgentFailureDiagnostic(body.diagnostic);
  if (diagnostic && (diagnostic.diagnosticId !== body.diagnosticId || diagnostic.runId !== runId)) invalidResponse();
  return Object.freeze({
    status,
    runId,
    lockedRunConfigurationId: lockedId,
    agent: body.agent,
    profileRevisionId: body.profileRevisionId,
    installationId: body.installationId,
    imageDigest: body.imageDigest,
    providerRevisionId,
    model: body.model,
    candidateCommitSha: body.candidateCommitSha,
    draftPullRequest: body.draftPullRequest,
    codeReviewReceipt,
    diagnosticId: body.diagnosticId,
    diagnostic,
    receiptId: body.receiptId,
  }) as AgentWorkflowRunReceipt;
}

function providerUnavailable(value: unknown): AgentProviderUnavailableError {
  const body = record(value);
  const error = record(body.error);
  if (error.code !== "PROVIDER_UNAVAILABLE") invalidResponse();
  return new AgentProviderUnavailableError(stringId(error.providerRevisionId));
}

function validateStart(input: Parameters<LockedAgentWorkflowPort["start"]>[0]): void {
  if (!/^workflow-job:[a-f0-9-]{36}$/i.test(input.operationKey)
    || !/^[a-f0-9]{64}$/.test(input.requestDigest)
    || !UUID.test(input.tenantId) || !UUID.test(input.projectId)
    || !SAFE_ID.test(input.workflowId) || !UUID.test(input.lockedRunConfigurationId)
    || (input.expectedRunId !== null && !SAFE_ID.test(input.expectedRunId))
    || !Number.isSafeInteger(input.iteration) || input.iteration < 1
    || !Number.isSafeInteger(input.repairAttempts) || input.repairAttempts < 0
    || typeof input.heartbeat !== "function") {
    throw new Error("Agent execution Broker request binding is invalid");
  }
}

function strictBrokerEndpoint(value: string | URL): URL {
  const url = new URL(value.toString());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/$/, "") !== "/v1/agent-runs") {
    throw new Error("Agent execution Broker endpoint must be credential-free HTTPS /v1/agent-runs");
  }
  url.pathname = "/v1/agent-runs";
  return url;
}

function statusEndpoint(endpoint: URL, runId: string): URL {
  const result = new URL(endpoint.href);
  result.pathname = `${endpoint.pathname}/${encodeURIComponent(runId)}`;
  return result;
}

function validateTls(tls: AgentExecutionBrokerTlsMaterial): void {
  for (const value of [tls.key, tls.certificate, tls.ca]) {
    if (!Buffer.isBuffer(value) || value.byteLength < 32 || value.byteLength > 1024 * 1024) {
      throw new Error("Agent execution Broker TLS material is invalid");
    }
  }
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

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < minimum || parsed > maximum) {
    throw new Error("Agent execution Broker duration configuration is invalid");
  }
  return parsed;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Agent execution Broker ${label} is invalid`);
  }
  return value;
}

function validNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Agent execution Broker clock is invalid");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function stringId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) invalidResponse();
  return value;
}

function validModel(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    assertPinnedModelId(value);
    return true;
  } catch {
    return false;
  }
}

function invalidResponse(): never {
  throw new Error("Agent execution Broker returned an invalid bound response");
}
