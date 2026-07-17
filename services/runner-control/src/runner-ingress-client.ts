import { readFile } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute } from "node:path";
import type { RunnerEvent } from "../../../lib/domain/e2e";
import type {
  PlatformEvidenceManifest,
  RegisteredRunner,
  RunnerCapabilities,
  RunnerEventReceipt,
  SignedRunnerJob,
} from "./contracts";
import { validateRunnerCapabilities, validateRunnerIdentity } from "./coordinator";
import type { PhysicalRunnerIngress } from "./physical-runner";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface PhysicalRunnerIngressTlsMaterial {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export interface PhysicalRunnerIngressHttpRequest {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly tls: PhysicalRunnerIngressTlsMaterial;
}

export interface PhysicalRunnerIngressHttpResponse {
  readonly statusCode: number;
  readonly payload: unknown;
}

export type PhysicalRunnerIngressHttp = (
  url: URL,
  input: PhysicalRunnerIngressHttpRequest,
) => Promise<PhysicalRunnerIngressHttpResponse>;

/** mTLS transport used on physical Windows/Linux/macOS Runner machines. */
export class MtlsPhysicalRunnerIngressClient implements PhysicalRunnerIngress {
  readonly #origin: URL;
  readonly #tls: PhysicalRunnerIngressTlsMaterial;
  readonly #timeoutMs: number;
  readonly #http: PhysicalRunnerIngressHttp;
  readonly #now: () => Date;

  constructor(options: {
    readonly origin: string | URL;
    readonly tls: PhysicalRunnerIngressTlsMaterial;
    readonly timeoutMs?: number;
    readonly http?: PhysicalRunnerIngressHttp;
    readonly now?: () => Date;
  }) {
    this.#origin = strictOrigin(options.origin);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 1_000, 600_000);
    this.#http = options.http ?? physicalRunnerIngressHttpsJson;
    this.#now = options.now ?? (() => new Date());
  }

  async register(capabilities: RunnerCapabilities): Promise<RegisteredRunner> {
    validateRunnerCapabilities(capabilities);
    const data = await this.#post("/v1/register", { capabilities });
    const runner = record(data) as unknown as RegisteredRunner;
    const capabilityFields = { ...runner } as Record<string, unknown>;
    for (const key of [
      "spiffeId", "certificateFingerprint", "certificateSerial", "certificateNotAfter",
      "state", "registeredAt", "lastSeenAt",
    ]) delete capabilityFields[key];
    validateRunnerCapabilities(capabilityFields as unknown as RunnerCapabilities);
    validateRunnerIdentity(runner, nowIso(this.#now));
    if (!Number.isFinite(Date.parse(runner.registeredAt)) || !Number.isFinite(Date.parse(runner.lastSeenAt))
      || !["ONLINE", "DRAINING", "OFFLINE", "QUARANTINED"].includes(runner.state)) {
      throw new Error("Physical Runner ingress returned an invalid registration");
    }
    return Object.freeze(runner);
  }

  async leaseNext(runnerId: string, tenantId: string): Promise<SignedRunnerJob | null> {
    const data = await this.#post("/v1/lease", { runnerId, tenantId });
    if (data === null) return null;
    const job = record(data);
    exactKeys(job, ["payload", "signature"]);
    record(job.payload);
    record(job.signature);
    return Object.freeze(job as unknown as SignedRunnerJob);
  }

  async submitEvidence(tenantId: string, manifest: PlatformEvidenceManifest): Promise<PlatformEvidenceManifest> {
    return Object.freeze(record(await this.#post("/v1/evidence", { tenantId, manifest })) as unknown as PlatformEvidenceManifest);
  }

  async acceptEvent(tenantId: string, event: RunnerEvent): Promise<RunnerEventReceipt> {
    return Object.freeze(record(await this.#post("/v1/events", { tenantId, event })) as unknown as RunnerEventReceipt);
  }

  async #post(path: string, payload: unknown): Promise<unknown> {
    const endpoint = new URL(path, this.#origin);
    const body = JSON.stringify(payload);
    const response = await this.#http(endpoint, {
      method: "POST",
      timeoutMs: this.#timeoutMs,
      tls: this.#tls,
      headers: Object.freeze({ accept: "application/json", "content-type": "application/json" }),
      body,
    });
    if (response.statusCode !== 200) {
      throw new Error(`Physical Runner ingress rejected the request with status ${response.statusCode}`);
    }
    const envelope = record(response.payload);
    exactKeys(envelope, ["data"]);
    return envelope.data;
  }
}

export async function physicalRunnerIngressClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsPhysicalRunnerIngressClient> {
  const [key, certificate, ca] = await Promise.all([
    readRequiredFile(env, "DEVILUDO_PHYSICAL_RUNNER_TLS_KEY_FILE"),
    readRequiredFile(env, "DEVILUDO_PHYSICAL_RUNNER_TLS_CERT_FILE"),
    readRequiredFile(env, "DEVILUDO_PHYSICAL_RUNNER_CA_FILE"),
  ]);
  return new MtlsPhysicalRunnerIngressClient({
    origin: requiredEnv(env, "DEVILUDO_RUNNER_INGRESS_URL"),
    tls: { key, certificate, ca },
    timeoutMs: seconds(env.DEVILUDO_PHYSICAL_RUNNER_REQUEST_TIMEOUT_SECONDS, 30) * 1_000,
  });
}

export async function physicalRunnerIngressHttpsJson(
  url: URL,
  input: PhysicalRunnerIngressHttpRequest,
): Promise<PhysicalRunnerIngressHttpResponse> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method: input.method,
      headers: { ...input.headers, "content-length": String(Buffer.byteLength(input.body)) },
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
        reject(new Error("Physical Runner ingress response exceeded the limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Physical Runner ingress response exceeded the limit"));
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
          reject(new Error("Physical Runner ingress returned invalid JSON"));
        }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Physical Runner ingress request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function strictOrigin(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Physical Runner ingress origin is invalid");
  }
  return url;
}

function validateTls(value: PhysicalRunnerIngressTlsMaterial): void {
  if (!(value.key instanceof Buffer) || !(value.certificate instanceof Buffer) || !(value.ca instanceof Buffer)
    || value.key.byteLength < 32 || value.certificate.byteLength < 32 || value.ca.byteLength < 32) {
    throw new Error("Physical Runner ingress TLS material is invalid");
  }
}

async function readRequiredFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = requiredEnv(env, name);
  if (!isAbsolute(path) || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} path is invalid`);
  const value = await readFile(path);
  if (value.byteLength < 32 || value.byteLength > 1024 * 1024) throw new Error(`${name} file is invalid`);
  return value;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error("Physical Runner ingress response fields are invalid");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Physical Runner ingress returned invalid JSON");
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
    throw new Error("Physical Runner ingress timeout is invalid");
  }
  return parsed;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("Physical Runner ingress timeout is invalid");
  }
  return value;
}

function nowIso(now: () => Date): string {
  const value = now().toISOString();
  if (!Number.isFinite(Date.parse(value))) throw new Error("Physical Runner clock is invalid");
  return value;
}
