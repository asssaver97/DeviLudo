import { Injectable } from "@nestjs/common";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { ServiceProblem, type ProviderRevisionRecord } from "./contracts";

const MAX_RESPONSE_BYTES = 128 * 1024;

export interface ProviderProbeHttpRequest {
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
  readonly timeoutMs: number;
}
export interface ProviderProbeHttpResponse { readonly statusCode: number; readonly payload: unknown }
export type ProviderProbeHttp = (url: URL, request: ProviderProbeHttpRequest) => Promise<ProviderProbeHttpResponse>;

export abstract class ProviderProbe {
  abstract probe(): Promise<void>;
  abstract run(provider: ProviderRevisionRecord): Promise<Readonly<Record<string, "PASS" | "FAIL">>>;
}

export type ProviderProbeConfiguration = Readonly<Pick<ProviderRevisionRecord,
  "id" | "agent" | "protocol" | "baseUrl" | "approvedPorts" | "authentication" | "models" | "credentialVersionId"
>>;

/**
 * Probes run through the internal inference gateway, which owns DNS pinning,
 * redirect revalidation and temporary access to Vault. The control-plane sends
 * a SecretRef identity only and never receives or forwards upstream key bytes.
 */
export class InferenceGatewayProviderProbeClient {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly http: ProviderProbeHttp = providerProbeHttpsJson,
  ) {}

  async probe(): Promise<void> {
    const endpoint = this.env.DEVILUDO_INFERENCE_PROBE_URL;
    if (!endpoint) {
      if (this.env.NODE_ENV === "production") {
        throw new ServiceProblem(503, "PROBE_GATEWAY_UNAVAILABLE", "The inference gateway probe service is not configured");
      }
      return;
    }
    const url = new URL(validateProbeEndpoint(endpoint));
    const tls = await providerProbeTls(this.env);
    try {
      await probeInferenceGatewayHealth(url, tls, this.http);
    } catch (error) {
      if (error instanceof ServiceProblem) throw error;
      throw new ServiceProblem(503, "PROBE_GATEWAY_UNAVAILABLE", "The inference gateway probe service is unavailable");
    } finally { wipeTls(tls); }
  }

  async run(provider: ProviderProbeConfiguration): Promise<Readonly<Record<string, "PASS" | "FAIL">>> {
    const endpoint = this.env.DEVILUDO_INFERENCE_PROBE_URL;
    if (!endpoint) {
      if (this.env.NODE_ENV === "production") {
        throw new ServiceProblem(503, "PROBE_GATEWAY_UNAVAILABLE", "The inference gateway probe service is not configured");
      }
      return developmentContractProbe();
    }
    const url = validateProbeEndpoint(endpoint);
    const tls = await providerProbeTls(this.env);
    try {
      const response = await this.http(new URL(url), {
        method: "POST", ...tls, timeoutMs: 30_000,
        body: JSON.stringify({
          providerRevisionId: provider.id,
          agent: provider.agent,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          approvedPorts: provider.approvedPorts,
          authentication: provider.authentication,
          models: provider.models,
          credentialVersionId: provider.credentialVersionId,
          requiredChecks: PROVIDER_REQUIRED_CHECKS,
        }),
      });
      if (response.statusCode !== 200) throw new ServiceProblem(409, "PROVIDER_PROBE_FAILED", "The inference gateway rejected the Provider probe");
      const checks = parseChecks(response.payload, provider.id);
      if (PROVIDER_REQUIRED_CHECKS.some((name) => checks[name] !== "PASS")) {
        throw new ServiceProblem(409, "PROVIDER_PROBE_FAILED", "Every Provider compatibility and network-safety probe must pass");
      }
      return checks;
    } catch (error) {
      if (error instanceof ServiceProblem) throw error;
      throw new ServiceProblem(409, "PROVIDER_PROBE_FAILED", "The inference gateway Provider probe did not complete");
    } finally { wipeTls(tls); }
  }
}

export class InferenceGatewayProviderProbe extends ProviderProbe {
  readonly #client = new InferenceGatewayProviderProbeClient();
  async probe(): Promise<void> { await this.#client.probe(); }
  async run(provider: ProviderRevisionRecord): Promise<Readonly<Record<string, "PASS" | "FAIL">>> {
    return this.#client.run(provider);
  }
}

Injectable()(InferenceGatewayProviderProbe);

export const PROVIDER_REQUIRED_CHECKS = [
  "authentication",
  "modelExistence",
  "streaming",
  "toolCalling",
  "cancellation",
  "usage",
  "timeout",
  "minimalReasoning",
  "dnsPinning",
  "redirectRevalidation",
] as const;

function developmentContractProbe(): Readonly<Record<string, "PASS">> {
  return Object.freeze(Object.fromEntries(PROVIDER_REQUIRED_CHECKS.map((name) => [name, "PASS"])) as Record<string, "PASS">);
}

function validateProbeEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/$/, "") !== "/v1/provider-probes") {
    throw new ServiceProblem(500, "INVALID_PROBE_GATEWAY", "Inference probe gateway URL must be credential-free HTTPS /v1/provider-probes");
  }
  url.pathname = "/v1/provider-probes";
  return url.toString();
}

export async function providerProbeHttpsJson(url: URL, input: ProviderProbeHttpRequest): Promise<ProviderProbeHttpResponse> {
  return new Promise((accept, reject) => {
    const body = input.body;
    const options: RequestOptions = {
      method: input.method,
      key: input.key,
      cert: input.certificate,
      ca: input.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: url.hostname,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        }),
      },
    };
    const request = httpsRequest(url, options, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          for (const chunk of chunks) chunk.fill(0);
          value.fill(0);
          response.destroy(new Error("Inference probe response exceeded its bound"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => {
        let payload: Buffer | null = null;
        try {
          payload = Buffer.concat(chunks);
          accept(Object.freeze({ statusCode: response.statusCode ?? 503, payload: JSON.parse(payload.toString("utf8")) as unknown }));
        }
        catch { reject(new Error("Inference probe returned invalid JSON")); }
        finally { payload?.fill(0); for (const chunk of chunks) chunk.fill(0); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Inference probe timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

export async function probeInferenceGatewayHealth(
  endpoint: URL,
  tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>,
  http: ProviderProbeHttp = providerProbeHttpsJson,
): Promise<void> {
  const url = new URL(endpoint);
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  const response = await http(url, { method: "GET", ...tls, timeoutMs: 10_000 });
  const health = exactObject(response.payload);
  const expected = Object.freeze({
    schemaVersion: "deviludo.inference-gateway-health.v1",
    status: "ok",
    service: "deviludo-inference-gateway",
    connector: "CONFIGURED",
    providerProbe: "CONFIGURED",
    reconciliation: "CONFIGURED",
  });
  if (response.statusCode !== 200
    || JSON.stringify(Object.keys(health).sort()) !== JSON.stringify(Object.keys(expected).sort())
    || Object.entries(expected).some(([key, value]) => health[key] !== value)) {
    throw new Error("Inference Gateway readiness identity is invalid");
  }
}

async function secretFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = env[name]?.trim();
  if (!path || !isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) {
    throw new Error(`${name} path is invalid`);
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) throw new Error(`${name} file is invalid`);
    return await file.readFile();
  } finally { await file.close(); }
}

async function providerProbeTls(env: Readonly<Record<string, string | undefined>>) {
  const [key, certificate, ca] = await Promise.all([
    secretFile(env, "DEVILUDO_INFERENCE_PROBE_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_INFERENCE_PROBE_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_INFERENCE_PROBE_CA_FILE"),
  ]);
  return { key, certificate, ca };
}

function wipeTls(tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>): void {
  tls.key.fill(0); tls.certificate.fill(0); tls.ca.fill(0);
}

function exactObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Inference Gateway readiness identity is invalid");
  }
  return value as Record<string, unknown>;
}

function parseChecks(raw: unknown, providerRevisionId: string): Readonly<Record<string, "PASS" | "FAIL">> {
  if (!raw || typeof raw !== "object") throw new ServiceProblem(409, "INVALID_PROBE_RESPONSE", "Provider probe response is invalid");
  const response = raw as Record<string, unknown>;
  if (response.providerRevisionId !== providerRevisionId) {
    throw new ServiceProblem(409, "INVALID_PROBE_RESPONSE", "Provider probe response is bound to another revision");
  }
  const value = response.checks;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceProblem(409, "INVALID_PROBE_RESPONSE", "Provider probe response has no checks object");
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== PROVIDER_REQUIRED_CHECKS.length || PROVIDER_REQUIRED_CHECKS.some((name) => !keys.includes(name))) {
    throw new ServiceProblem(409, "INVALID_PROBE_RESPONSE", "Provider probe response check set is invalid");
  }
  const checks = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, result]) => [key, result === "PASS" ? "PASS" : "FAIL"]),
  ) as Record<string, "PASS" | "FAIL">;
  return Object.freeze(checks);
}
