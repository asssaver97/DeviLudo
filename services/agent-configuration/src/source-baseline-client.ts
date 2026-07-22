import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute, resolve } from "node:path";
import {
  parseSourceBaselineReceipt,
  parseSourceBaselineRequest,
  type SourceBaselineReceipt,
  type SourceBaselineRequest,
} from "../../scm-proxy/src/source-baseline-contracts";
import type { SourceBaselinePort } from "./contracts";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 1024 * 1024;

export interface SourceBaselineBrokerTls {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}
export interface SourceBaselineBrokerHttpResponse {
  readonly statusCode: number;
  readonly payload: unknown;
}
export type SourceBaselineBrokerHttp = (input: {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly body: string;
  readonly idempotencyKey?: string;
  readonly tls: SourceBaselineBrokerTls;
  readonly timeoutMs: number;
}) => Promise<SourceBaselineBrokerHttpResponse>;

/** Fixed-route mTLS client; it accepts no repository name, branch or GitHub token. */
export class MtlsSourceBaselineClient implements SourceBaselinePort {
  readonly #endpoint: URL;
  readonly #tls: SourceBaselineBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: SourceBaselineBrokerHttp;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: SourceBaselineBrokerTls;
    readonly timeoutMs?: number;
    readonly http?: SourceBaselineBrokerHttp;
  }) {
    this.#endpoint = strictOrigin(options.endpoint);
    validateTls(options.tls);
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) invalidConfig();
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = timeoutMs;
    this.#http = options.http ?? sourceBaselineBrokerHttpsJson;
  }

  async resolve(value: SourceBaselineRequest): Promise<SourceBaselineReceipt> {
    const request = parseSourceBaselineRequest(value);
    const url = route(this.#endpoint, "/v1/source-baselines");
    const response = await this.#http({
      method: "POST",
      url,
      body: JSON.stringify(request),
      idempotencyKey: request.operationKey,
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
    });
    if (response.statusCode !== 200 && response.statusCode !== 201) {
      throw new Error(`Source baseline Broker rejected the request with status ${response.statusCode}`);
    }
    const envelope = record(response.payload);
    if (JSON.stringify(Object.keys(envelope).sort()) !== '["data"]') invalidResponse();
    const receipt = parseSourceBaselineReceipt(envelope.data);
    if (receipt.operationKey !== request.operationKey || receipt.tenantId !== request.tenantId
      || receipt.projectId !== request.projectId || receipt.workflowId !== request.workflowId
      || receipt.specRevisionId !== request.specRevisionId
      || receipt.testPlanRevisionId !== request.testPlanRevisionId
      || receipt.specApprovalReceiptId !== request.specApprovalReceiptId
      || receipt.replayed !== (response.statusCode === 200)) invalidResponse();
    return receipt;
  }

  async probe(): Promise<void> {
    const response = await this.#http({
      method: "GET",
      url: route(this.#endpoint, "/healthz"),
      body: "",
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
    });
    const payload = record(response.payload);
    if (response.statusCode !== 200
      || JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(["service", "status"])
      || payload.status !== "ok"
      || payload.service !== "deviludo-source-snapshot") invalidResponse();
  }
}

export async function sourceBaselineClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsSourceBaselineClient> {
  const [key, certificate, ca] = await Promise.all([
    readSecret(required(env, "DEVILUDO_SOURCE_BASELINE_TLS_KEY_FILE")),
    readSecret(required(env, "DEVILUDO_SOURCE_BASELINE_TLS_CERT_FILE")),
    readSecret(required(env, "DEVILUDO_SOURCE_BASELINE_CA_FILE")),
  ]);
  return new MtlsSourceBaselineClient({
    endpoint: required(env, "DEVILUDO_SOURCE_BASELINE_BROKER_URL"),
    tls: { key, certificate, ca },
    timeoutMs: seconds(env.DEVILUDO_SOURCE_BASELINE_TIMEOUT_SECONDS, 60) * 1_000,
  });
}

export function sourceBaselineBrokerHttpsJson(input: {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly body: string;
  readonly idempotencyKey?: string;
  readonly tls: SourceBaselineBrokerTls;
  readonly timeoutMs: number;
}): Promise<SourceBaselineBrokerHttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (input.method === "POST") {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(input.body));
      if (!input.idempotencyKey) return reject(new Error("Source baseline idempotency key is missing"));
      headers["idempotency-key"] = input.idempotencyKey;
    }
    const options: RequestOptions = {
      method: input.method,
      headers,
      key: input.tls.key,
      cert: input.tls.certificate,
      ca: input.tls.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: input.url.hostname,
    };
    const request = httpsRequest(input.url, options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Source baseline Broker response exceeded the limit"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolvePromise({
            statusCode: response.statusCode ?? 503,
            payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          });
        } catch { reject(new Error("Source baseline Broker returned invalid JSON")); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Source baseline Broker request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

async function readSecret(path: string): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) invalidConfig();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) invalidConfig();
    return await file.readFile();
  } finally { await file.close(); }
}
function strictOrigin(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { invalidConfig(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) invalidConfig();
  return url;
}
function route(origin: URL, pathname: string): URL { const result = new URL(origin); result.pathname = pathname; return result; }
function validateTls(value: SourceBaselineBrokerTls): void {
  if (!Buffer.isBuffer(value.key) || !Buffer.isBuffer(value.certificate) || !Buffer.isBuffer(value.ca)
    || value.key.byteLength < 32 || value.certificate.byteLength < 32 || value.ca.byteLength < 32) invalidConfig();
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim(); if (!value) invalidConfig(); return value;
}
function seconds(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const result = Number.parseInt(value, 10);
  if (!Number.isInteger(result) || result < 1 || result > 600 || String(result) !== value) invalidConfig();
  return result;
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Readonly<Record<string, unknown>>;
}
function invalidConfig(): never { throw new Error("Source baseline client configuration is invalid"); }
function invalidResponse(): never { throw new Error("Source baseline Broker response is invalid"); }
