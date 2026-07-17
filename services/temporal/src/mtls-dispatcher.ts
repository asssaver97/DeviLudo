import { request as httpsRequest, type RequestOptions } from "node:https";
import { readFile } from "node:fs/promises";
import type { CommandDispatcher, DeliveryDispatchEndpoints, DeliveryDispatchRequest } from "./activities";
import type { DeliveryActivityReceipt, DeliveryCommandDestination } from "./contracts";
import { assertDeliveryDispatchRequest } from "./receiver";

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface WorkflowDispatchTlsMaterial {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export interface WorkflowHttpsPostRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly tls: WorkflowDispatchTlsMaterial;
}

export type WorkflowHttpsPost = (url: URL, request: WorkflowHttpsPostRequest) => Promise<{
  readonly statusCode: number;
  readonly payload: unknown;
}>;

/** HTTPS dispatcher that presents the Temporal workload certificate. */
export class MtlsCommandDispatcher implements CommandDispatcher {
  readonly #endpoints: Readonly<Record<DeliveryCommandDestination, URL>>;

  constructor(
    endpoints: DeliveryDispatchEndpoints,
    private readonly tls: WorkflowDispatchTlsMaterial,
    private readonly timeoutMs = 30_000,
    private readonly post: WorkflowHttpsPost = httpsPostJson,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new Error("Activity dispatch timeout is invalid");
    }
    validateTlsMaterial(tls);
    this.#endpoints = Object.freeze({
      "control-plane": strictHttpsEndpoint(endpoints["control-plane"]),
      "agent-worker": strictHttpsEndpoint(endpoints["agent-worker"]),
      "runner-control": strictHttpsEndpoint(endpoints["runner-control"]),
      "scm-proxy": strictHttpsEndpoint(endpoints["scm-proxy"]),
      "steam-publisher": strictHttpsEndpoint(endpoints["steam-publisher"]),
    });
  }

  async dispatch(request: DeliveryDispatchRequest): Promise<DeliveryActivityReceipt> {
    assertDeliveryDispatchRequest(request, request.destination);
    if (request.destination !== request.payload.destination) {
      throw new Error("Activity dispatch envelope destination mismatch");
    }
    const operation = request.kind === "COMMAND" ? request.payload.command : "CANCEL_DELIVERY";
    const response = await this.post(this.#endpoints[request.destination], {
      timeoutMs: this.timeoutMs,
      tls: this.tls,
      headers: Object.freeze({
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": request.payload.idempotencyKey,
        "x-deviludo-destination": request.destination,
        "x-deviludo-operation": operation,
        "x-deviludo-workflow-id": request.payload.workflowId,
      }),
      body: JSON.stringify(request),
    });
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`Activity dispatcher rejected the command with status ${response.statusCode}`);
    }
    return receipt(response.payload, request, operation);
  }
}

export async function mtlsCommandDispatcherFromEnv(
  endpoints: DeliveryDispatchEndpoints,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsCommandDispatcher> {
  const [key, certificate, ca] = await Promise.all([
    readPem(env, "DEVILUDO_TEMPORAL_DISPATCH_TLS_KEY_FILE"),
    readPem(env, "DEVILUDO_TEMPORAL_DISPATCH_TLS_CERT_FILE"),
    readPem(env, "DEVILUDO_TEMPORAL_DISPATCH_CA_FILE"),
  ]);
  return new MtlsCommandDispatcher(endpoints, { key, certificate, ca });
}

async function httpsPostJson(url: URL, input: WorkflowHttpsPostRequest): Promise<{
  readonly statusCode: number;
  readonly payload: unknown;
}> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method: "POST",
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
      if (contentLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(new Error("Activity dispatcher receipt exceeded the response limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Activity dispatcher receipt exceeded the response limit"));
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve({
            statusCode: response.statusCode ?? 503,
            payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          });
        } catch {
          reject(new Error("Activity dispatcher returned invalid JSON"));
        }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Activity dispatch timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function receipt(
  value: unknown,
  request: DeliveryDispatchRequest,
  operation: DeliveryActivityReceipt["operation"],
): DeliveryActivityReceipt {
  if (!value || typeof value !== "object") invalidReceipt();
  const candidate = value as Partial<DeliveryActivityReceipt>;
  if (!candidate.receiptId?.trim() || !candidate.acceptedAt || !Number.isFinite(Date.parse(candidate.acceptedAt))
    || candidate.destination !== request.destination || candidate.workflowId !== request.payload.workflowId
    || candidate.idempotencyKey !== request.payload.idempotencyKey || candidate.operation !== operation) invalidReceipt();
  return Object.freeze({ ...candidate }) as DeliveryActivityReceipt;
}

function strictHttpsEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("mTLS activity dispatch endpoint must be credential-free HTTPS");
  }
  return url;
}

function validateTlsMaterial(value: WorkflowDispatchTlsMaterial): void {
  for (const entry of [value.key, value.certificate, value.ca]) {
    if (!Buffer.isBuffer(entry) || entry.byteLength < 32 || entry.byteLength > 1024 * 1024) {
      throw new Error("Activity dispatch TLS material is invalid");
    }
  }
}

async function readPem(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = env[name]?.trim();
  if (!path || !path.startsWith("/") || path.length > 4_096 || /\0/.test(path)) {
    throw new Error(`${name} is required as an absolute path`);
  }
  const value = await readFile(path);
  if (value.byteLength < 32 || value.byteLength > 1024 * 1024) throw new Error(`${name} file is invalid`);
  return value;
}

function invalidReceipt(): never {
  throw new Error("Activity dispatcher returned an invalid receipt");
}
