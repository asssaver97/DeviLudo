import { randomUUID } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { validateRedirectForConnection, type DnsResolver, type ValidatedEndpoint } from "../../../lib/security/network";
import type {
  AuthorizedGatewayRequest,
  GatewayConnector,
  GatewayConnectorResponse,
  GatewayProtocol,
  GatewayUsage,
  UsageLedger,
} from "./contracts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 256 * 1024 * 1024;

export interface GatewayCredentialLease {
  readonly value: Uint8Array;
  destroy(): void;
}

export interface GatewayCredentialResolver {
  resolve(input: Readonly<{
    tenantId: string;
    projectId: string;
    runId: string;
    providerRevisionId: string;
    credentialVersionId: string;
  }>): Promise<GatewayCredentialLease>;
  probe(): Promise<void>;
}

export interface GatewayUpstreamResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Readable;
}

export interface GatewayUpstreamTransport {
  request(input: Readonly<{
    endpoint: ValidatedEndpoint;
    url: URL;
    headers: Readonly<Record<string, string>>;
    body: Buffer;
    signal: AbortSignal;
  }>): Promise<GatewayUpstreamResponse>;
}

/** Vault-resolving, DNS-pinned connector shared by Responses and Messages adapters. */
export class ProductionGatewayConnector implements GatewayConnector {
  constructor(private readonly options: Readonly<{
    credentials: GatewayCredentialResolver;
    usage: UsageLedger;
    dns: DnsResolver;
    transport?: GatewayUpstreamTransport;
  }>) {}

  async probe(): Promise<void> { await this.options.credentials.probe(); }

  async forward(input: Parameters<GatewayConnector["forward"]>[0]): Promise<GatewayConnectorResponse> {
    const requestBody = Buffer.from(JSON.stringify(input.body));
    if (requestBody.byteLength < 2 || requestBody.byteLength > MAX_REQUEST_BYTES) invalid();
    const lease = await this.options.credentials.resolve({
      tenantId: input.authorization.run.tenantId,
      projectId: input.authorization.run.projectId,
      runId: input.authorization.run.runId,
      providerRevisionId: input.authorization.provider.providerRevisionId,
      credentialVersionId: input.authorization.provider.credentialVersionId,
    });
    let response: GatewayUpstreamResponse;
    try {
      const secret = secretText(lease.value);
      const headers = upstreamHeaders(input.authorization, secret);
      const transport = this.options.transport ?? new PinnedHttpsGatewayTransport();
      response = await this.#requestFollowingSafeRedirects(
        transport, input.authorization, headers, requestBody, input.signal,
      );
    } finally {
      lease.destroy();
    }
    const responseHeaders = safeResponseHeaders(response.headers);
    const streaming = input.body.stream === true;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const raw = await readBounded(response.body, MAX_ERROR_RESPONSE_BYTES);
      return Object.freeze({
        statusCode: safeUpstreamStatus(response.statusCode),
        headers: responseHeaders,
        body: sanitizedUpstreamError(raw),
      });
    }
    if (streaming) {
      if (!contentType(response.headers).startsWith("text/event-stream")) invalid();
      return Object.freeze({
        statusCode: response.statusCode,
        headers: Object.freeze({ ...responseHeaders, "content-type": "text/event-stream" }),
        body: response.body.pipe(new UsageMeteringTransform({
          protocol: input.authorization.provider.protocol,
          authorization: input.authorization,
          usage: this.options.usage,
          requestId: randomUUID(),
        })),
      });
    }
    if (!contentType(response.headers).includes("json")) invalid();
    const raw = await readBounded(response.body, MAX_JSON_RESPONSE_BYTES);
    let body: unknown;
    try { body = JSON.parse(raw.toString("utf8")) as unknown; } catch { invalid(); }
    const usage = responseUsage(input.authorization.provider.protocol, body);
    await recordUsage(this.options.usage, input.authorization, randomUUID(), usage);
    return Object.freeze({ statusCode: response.statusCode, headers: responseHeaders, body });
  }

  async #requestFollowingSafeRedirects(
    transport: GatewayUpstreamTransport,
    authorization: AuthorizedGatewayRequest,
    headers: Readonly<Record<string, string>>,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<GatewayUpstreamResponse> {
    let endpoint = authorization.endpoint;
    let url = inferenceUrl(endpoint.url, authorization.provider.protocol);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await transport.request({ endpoint, url, headers, body, signal });
      if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response;
      const location = singleHeader(response.headers.location);
      response.body.destroy();
      if ((response.statusCode !== 307 && response.statusCode !== 308) || !location || redirect === 3) invalid();
      const next = await validateRedirectForConnection(url.toString(), location, redirect + 1, this.options.dns, {
        approvedPorts: authorization.provider.approvedPorts,
        maxRedirects: 3,
      });
      const nextUrl = inferenceUrl(next.url, authorization.provider.protocol);
      if (nextUrl.origin !== url.origin) invalid();
      endpoint = next;
      url = nextUrl;
    }
    invalid();
  }
}

export class PinnedHttpsGatewayTransport implements GatewayUpstreamTransport {
  request(input: Parameters<GatewayUpstreamTransport["request"]>[0]): Promise<GatewayUpstreamResponse> {
    const address = input.endpoint.connectAddresses[0];
    if (!address || input.url.protocol !== "https:" || input.url.hostname.toLowerCase() !== input.endpoint.hostname
      || Number(input.url.port || 443) !== input.endpoint.port || input.url.username || input.url.password) invalid();
    const options: RequestOptions = {
      method: "POST",
      hostname: input.url.hostname,
      port: input.endpoint.port,
      servername: input.url.hostname,
      path: `${input.url.pathname}${input.url.search}`,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      headers: { ...input.headers, "content-length": String(input.body.byteLength) },
      signal: input.signal,
      lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, value: string, family: number) => void) => {
        callback(null, address.address, address.family);
      }) as RequestOptions["lookup"],
    };
    return new Promise((accept, reject) => {
      const request = httpsRequest(options, (response) => accept(Object.freeze({
        statusCode: response.statusCode ?? 0,
        headers: Object.freeze({ ...response.headers }),
        body: response,
      })));
      request.setTimeout(10 * 60_000, () => request.destroy(new Error("Inference upstream timed out")));
      request.once("error", reject);
      request.end(input.body);
    });
  }
}

class UsageMeteringTransform extends Transform {
  #buffer = "";
  #bytes = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  constructor(private readonly options: Readonly<{
    protocol: GatewayProtocol;
    authorization: AuthorizedGatewayRequest;
    usage: UsageLedger;
    requestId: string;
  }>) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > MAX_STREAM_BYTES) { callback(new Error("Inference stream exceeded its bound")); return; }
    this.#buffer += chunk.toString("utf8");
    if (this.#buffer.length > MAX_JSON_RESPONSE_BYTES) { callback(new Error("Inference SSE event exceeded its bound")); return; }
    try {
      let boundary = sseBoundary(this.#buffer);
      while (boundary) {
        const event = this.#buffer.slice(0, boundary.index);
        this.#buffer = this.#buffer.slice(boundary.index + boundary.length);
        this.#consumeEvent(event);
        boundary = sseBoundary(this.#buffer);
      }
      callback(null, chunk);
    } catch (error) { callback(error as Error); }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.#buffer.trim()) this.#consumeEvent(this.#buffer);
      if (this.#inputTokens < 0 || this.#outputTokens < 0 || this.#inputTokens + this.#outputTokens < 1) invalid();
      const usage = pricedUsage(this.options.authorization, this.#inputTokens, this.#outputTokens);
      void recordUsage(this.options.usage, this.options.authorization, this.options.requestId, usage)
        .then(() => callback()).catch((error: unknown) => callback(error as Error));
    } catch (error) { callback(error as Error); }
  }

  #consumeEvent(value: string): void {
    const data = value.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    let parsed: unknown;
    try { parsed = JSON.parse(data) as unknown; } catch { invalid(); }
    const usage = streamingUsage(this.options.protocol, parsed);
    if (usage) {
      this.#inputTokens = Math.max(this.#inputTokens, usage.inputTokens);
      this.#outputTokens = Math.max(this.#outputTokens, usage.outputTokens);
    }
  }
}

function inferenceUrl(base: string, protocol: GatewayProtocol): URL {
  const url = new URL(base);
  const suffix = protocol === "openai-responses" ? "/responses" : "/messages";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  if (url.search || url.hash) invalid();
  return url;
}

function upstreamHeaders(authorization: AuthorizedGatewayRequest, secret: string): Readonly<Record<string, string>> {
  const provider = authorization.provider;
  const result: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": "DeviLudo-Inference-Gateway/1",
  };
  if (provider.protocol === "anthropic-messages") result["anthropic-version"] = "2023-06-01";
  if (provider.authentication === "x-api-key") result["x-api-key"] = secret;
  else result.authorization = `Bearer ${secret}`;
  return Object.freeze(result);
}

function responseUsage(protocol: GatewayProtocol, body: unknown): GatewayUsage {
  const record = object(body);
  const usage = object(record.usage);
  const inputTokens = integer(usage.input_tokens);
  const outputTokens = integer(usage.output_tokens);
  if (protocol === "openai-responses" && typeof record.id !== "string") invalid();
  return pricedUsageFromValues(inputTokens, outputTokens, null);
}

function streamingUsage(protocol: GatewayProtocol, body: unknown): Readonly<{ inputTokens: number; outputTokens: number }> | null {
  const value = object(body);
  if (protocol === "openai-responses") {
    if (value.type !== "response.completed") return null;
    const usage = object(object(value.response).usage);
    return Object.freeze({ inputTokens: integer(usage.input_tokens), outputTokens: integer(usage.output_tokens) });
  }
  if (value.type === "message_start") {
    const usage = object(object(value.message).usage);
    return Object.freeze({ inputTokens: integer(usage.input_tokens), outputTokens: optionalInteger(usage.output_tokens) });
  }
  if (value.type === "message_delta") {
    const usage = object(value.usage);
    return Object.freeze({ inputTokens: optionalInteger(usage.input_tokens), outputTokens: integer(usage.output_tokens) });
  }
  return null;
}

function pricedUsage(authorization: AuthorizedGatewayRequest, inputTokens: number, outputTokens: number): GatewayUsage {
  return pricedUsageFromValues(inputTokens, outputTokens, authorization);
}
function pricedUsageFromValues(inputTokens: number, outputTokens: number, authorization: AuthorizedGatewayRequest | null): GatewayUsage {
  const pricing = authorization?.provider.pricing;
  const costUsd = pricing
    ? (inputTokens * pricing.inputUsdPerMillionTokens + outputTokens * pricing.outputUsdPerMillionTokens) / 1_000_000
    : 0;
  return Object.freeze({ inputTokens, outputTokens, costUsd });
}

async function recordUsage(ledger: UsageLedger, authorization: AuthorizedGatewayRequest, requestId: string, usage: GatewayUsage): Promise<void> {
  const priced = usage.costUsd === 0 && (usage.inputTokens || usage.outputTokens) ? pricedUsage(authorization, usage.inputTokens, usage.outputTokens) : usage;
  await ledger.record({
    requestId,
    tenantId: authorization.run.tenantId,
    projectId: authorization.run.projectId,
    runId: authorization.run.runId,
    providerRevisionId: authorization.provider.providerRevisionId,
    credentialVersionId: authorization.provider.credentialVersionId,
    model: authorization.model,
    usage: priced,
  });
}

async function readBounded(stream: Readable, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > maximum) { stream.destroy(); invalid(); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sanitizedUpstreamError(raw: Buffer): unknown {
  raw.fill(0);
  return { error: { code: "UPSTREAM_REQUEST_REJECTED" } };
}

function safeResponseHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of ["content-type", "x-request-id", "request-id"]) {
    const value = singleHeader(headers[name]); if (value && value.length <= 1000) result[name] = value;
  }
  return Object.freeze(result);
}
function contentType(headers: IncomingHttpHeaders): string { return (singleHeader(headers["content-type"]) ?? "").toLowerCase(); }
function sseBoundary(value: string): Readonly<{ index: number; length: number }> | null {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return Object.freeze({ index: crlf, length: 4 });
  return Object.freeze({ index: lf, length: 2 });
}
function singleHeader(value: string | string[] | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
function safeUpstreamStatus(value: number): number { return value === 401 || value === 403 ? 502 : value === 408 || value === 429 ? value : value >= 400 && value <= 599 ? value : 502; }
function secretText(value: Uint8Array): string {
  if (value.byteLength < 8 || value.byteLength > 64 * 1024) invalid();
  const result = Buffer.from(value).toString("utf8");
  if (Buffer.byteLength(result) !== value.byteLength || /[\0\r\n]/.test(result)) invalid();
  return result;
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); return value as number; }
function optionalInteger(value: unknown): number { return value === undefined ? 0 : integer(value); }
function invalid(): never { throw new Error("Inference upstream response or connector policy is invalid"); }
