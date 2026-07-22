import { request as httpsRequest, type RequestOptions } from "node:https";
import { parseSpecModelResult, type SpecModelResult } from "./contracts";
import type { SpecDialogueModel } from "./model";

const MAX_RESPONSE_BYTES = 256 * 1024;

export interface SpecModelBrokerTls {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export interface SpecModelBrokerHttpResponse { readonly statusCode: number; readonly payload: unknown }
export type SpecModelBrokerHttp = (
  url: URL,
  input: {
    readonly method?: "GET" | "POST";
    readonly body: string;
    readonly operationKey: string | null;
    readonly timeoutMs: number;
    readonly tls: SpecModelBrokerTls;
  },
) => Promise<SpecModelBrokerHttpResponse>;

/**
 * Calls an isolated low-latency model Broker. This service receives no upstream
 * API key, base URL, CLI installation or autonomous tool capability.
 */
export class MtlsSpecDialogueModel implements SpecDialogueModel {
  readonly #endpoint: URL;
  readonly #tls: SpecModelBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: SpecModelBrokerHttp;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: SpecModelBrokerTls;
    readonly timeoutMs?: number;
    readonly http?: SpecModelBrokerHttp;
  }) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== "/v1/spec-generations") throw new Error("Specification model Broker endpoint is invalid");
    if (options.tls.key.byteLength < 32 || options.tls.certificate.byteLength < 32 || options.tls.ca.byteLength < 32) {
      throw new Error("Specification model Broker TLS material is invalid");
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error("Specification model Broker timeout is invalid");
    this.#endpoint = endpoint;
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = timeoutMs;
    this.#http = options.http ?? specModelBrokerHttpsJson;
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href);
    url.pathname = "/healthz";
    const response = await this.#http(url, {
      method: "GET", body: "", operationKey: null, timeoutMs: this.#timeoutMs, tls: this.#tls,
    });
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "status", "service"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.spec-model-health.v1"
      || body.status !== "ok" || body.service !== "deviludo-spec-model-broker") {
      throw new Error("Specification model Broker health identity is invalid");
    }
  }

  async generate(input: Parameters<SpecDialogueModel["generate"]>[0]): Promise<SpecModelResult> {
    const response = await this.#http(this.#endpoint, {
      operationKey: input.operationKey,
      timeoutMs: this.#timeoutMs,
      tls: this.#tls,
      body: JSON.stringify({
        schemaVersion: "deviludo.spec-generation.v1",
        tenantId: input.tenantId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        history: input.history,
        current: input.current,
        userMessage: input.userMessage,
        outputSchema: "deviludo.spec-model-result.v1",
        toolsAllowed: false,
      }),
    });
    if (response.statusCode !== 200) throw new Error("Specification model Broker did not complete the request");
    return parseSpecModelResult(response.payload);
  }
}

export function specModelBrokerHttpsJson(
  url: URL,
  input: {
    readonly method?: "GET" | "POST";
    readonly body: string;
    readonly operationKey: string | null;
    readonly timeoutMs: number;
    readonly tls: SpecModelBrokerTls;
  },
): Promise<SpecModelBrokerHttpResponse> {
  return new Promise((resolve, reject) => {
    const method = input.method ?? "POST";
    if (method === "POST" && !input.operationKey) {
      reject(new Error("Specification model Broker operation key is required"));
      return;
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(input.body));
      headers["idempotency-key"] = input.operationKey!;
    }
    const options: RequestOptions = {
      method,
      headers,
      key: input.tls.key,
      cert: input.tls.certificate,
      ca: input.tls.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: url.hostname,
    };
    const request = httpsRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Specification model Broker response exceeded the limit"));
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
        } catch { reject(new Error("Specification model Broker returned invalid JSON")); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Specification model Broker timed out")));
    request.once("error", reject);
    request.end(method === "POST" ? input.body : undefined);
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Specification model Broker health identity is invalid");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error("Specification model Broker health identity is invalid");
  }
}
