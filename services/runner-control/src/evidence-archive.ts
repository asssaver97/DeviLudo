import { readFile } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { EvidenceBundle } from "../../../lib/domain/e2e";
import type { RunnerEvidenceArchive } from "./postgres-ingress";

const MAX_RESPONSE_BYTES = 256 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface RunnerEvidenceArchiveTlsMaterial {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export interface RunnerEvidenceArchiveHttpRequest {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly tls: RunnerEvidenceArchiveTlsMaterial;
}

export interface RunnerEvidenceArchiveHttpResponse {
  readonly statusCode: number;
  readonly payload: unknown;
}

export type RunnerEvidenceArchiveHttp = (
  url: URL,
  input: RunnerEvidenceArchiveHttpRequest,
) => Promise<RunnerEvidenceArchiveHttpResponse>;

/** Workload-authenticated connector to the content-addressed evidence service. */
export class MtlsRunnerEvidenceArchive implements RunnerEvidenceArchive {
  readonly #endpoint: URL;
  readonly #tls: RunnerEvidenceArchiveTlsMaterial;
  readonly #timeoutMs: number;
  readonly #http: RunnerEvidenceArchiveHttp;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: RunnerEvidenceArchiveTlsMaterial;
    readonly timeoutMs?: number;
    readonly http?: RunnerEvidenceArchiveHttp;
  }) {
    this.#endpoint = strictEndpoint(options.endpoint);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 1_000, 600_000);
    this.#http = options.http ?? runnerEvidenceArchiveHttpsJson;
  }

  async persistBundle(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly bundle: EvidenceBundle;
  }): Promise<Readonly<{ objectKey: string; repairPromptId: string | null }>> {
    validateInput(input);
    const body = JSON.stringify({
      schemaVersion: "deviludo.runner-evidence-archive.v1",
      tenantId: input.tenantId,
      projectId: input.projectId,
      attemptId: input.bundle.attemptId,
      bundleDigest: input.bundle.bundleDigest,
      bundle: input.bundle,
    });
    const response = await this.#http(this.#endpoint, {
      method: "POST",
      timeoutMs: this.#timeoutMs,
      tls: this.#tls,
      headers: Object.freeze({
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": input.bundle.bundleDigest,
        "x-deviludo-bundle-digest": input.bundle.bundleDigest,
      }),
      body,
    });
    if (response.statusCode !== 200 && response.statusCode !== 201) {
      throw new Error(`Runner evidence archive rejected the bundle with status ${response.statusCode}`);
    }
    return parseReceipt(response.payload, input);
  }

  async probe(): Promise<void> {
    const endpoint = new URL(this.#endpoint.href);
    endpoint.pathname = "/healthz";
    const response = await this.#http(endpoint, {
      method: "GET",
      timeoutMs: this.#timeoutMs,
      tls: this.#tls,
      headers: Object.freeze({ accept: "application/json" }),
    });
    const body = record(response.payload);
    if (response.statusCode !== 200 || body.status !== "ok" || body.service !== "deviludo-evidence-archive") {
      throw new Error("Runner evidence archive readiness probe failed");
    }
  }
}

export async function runnerEvidenceArchiveFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsRunnerEvidenceArchive> {
  const [key, certificate, ca] = await Promise.all([
    readRequiredFile(env, "DEVILUDO_RUNNER_EVIDENCE_ARCHIVE_TLS_KEY_FILE"),
    readRequiredFile(env, "DEVILUDO_RUNNER_EVIDENCE_ARCHIVE_TLS_CERT_FILE"),
    readRequiredFile(env, "DEVILUDO_RUNNER_EVIDENCE_ARCHIVE_CA_FILE"),
  ]);
  return new MtlsRunnerEvidenceArchive({
    endpoint: requiredEnv(env, "DEVILUDO_RUNNER_EVIDENCE_ARCHIVE_URL"),
    tls: { key, certificate, ca },
    timeoutMs: seconds(env.DEVILUDO_RUNNER_EVIDENCE_ARCHIVE_TIMEOUT_SECONDS, 30) * 1_000,
  });
}

export async function runnerEvidenceArchiveHttpsJson(
  url: URL,
  input: RunnerEvidenceArchiveHttpRequest,
): Promise<RunnerEvidenceArchiveHttpResponse> {
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
      if (!Number.isFinite(contentLength) || contentLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(new Error("Runner evidence archive response exceeded the limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Runner evidence archive response exceeded the limit"));
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
          reject(new Error("Runner evidence archive returned invalid JSON"));
        }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Runner evidence archive request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function parseReceipt(
  value: unknown,
  expected: { readonly tenantId: string; readonly projectId: string; readonly bundle: EvidenceBundle },
): Readonly<{ objectKey: string; repairPromptId: string | null }> {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "tenantId", "projectId", "attemptId", "bundleDigest", "objectKey", "repairPromptId",
  ]);
  if (body.schemaVersion !== "deviludo.runner-evidence-archive-receipt.v1"
    || body.tenantId !== expected.tenantId || body.projectId !== expected.projectId
    || body.attemptId !== expected.bundle.attemptId || body.bundleDigest !== expected.bundle.bundleDigest
    || typeof body.objectKey !== "string"
    || (body.repairPromptId !== null && (typeof body.repairPromptId !== "string" || !SAFE_ID.test(body.repairPromptId)))) {
    throw new Error("Runner evidence archive returned an invalid receipt");
  }
  return Object.freeze({ objectKey: body.objectKey, repairPromptId: body.repairPromptId as string | null });
}

function validateInput(input: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly bundle: EvidenceBundle;
}): void {
  if (!UUID.test(input.tenantId) || !UUID.test(input.projectId)
    || !UUID.test(input.bundle.attemptId) || !SHA256.test(input.bundle.bundleDigest)) {
    throw new Error("Runner evidence archive input is invalid");
  }
}

function strictEndpoint(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/v1/runner-evidence") {
    throw new Error("Runner evidence archive URL is invalid");
  }
  return url;
}

function validateTls(value: RunnerEvidenceArchiveTlsMaterial): void {
  if (!(value.key instanceof Buffer) || !(value.certificate instanceof Buffer) || !(value.ca instanceof Buffer)
    || value.key.byteLength < 32 || value.certificate.byteLength < 32 || value.ca.byteLength < 32) {
    throw new Error("Runner evidence archive TLS material is invalid");
  }
}

async function readRequiredFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = requiredEnv(env, name);
  if (!path.startsWith("/") || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} path is invalid`);
  const value = await readFile(path);
  if (value.byteLength < 32 || value.byteLength > 1024 * 1024) throw new Error(`${name} file is invalid`);
  return value;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error("Runner evidence archive returned an invalid receipt");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runner evidence archive returned invalid JSON");
  }
  return value as Record<string, unknown>;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function seconds(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600 || String(parsed) !== value) {
    throw new Error("Runner evidence archive timeout is invalid");
  }
  return parsed;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("Runner evidence archive timeout is invalid");
  }
  return value;
}
