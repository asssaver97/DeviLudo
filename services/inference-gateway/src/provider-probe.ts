import { TLSSocket } from "node:tls";
import { validateEndpointForConnection, validateRedirectForConnection, type DnsResolver, type ValidatedEndpoint } from "../../../lib/security/network";
import { assertPinnedModelId } from "../../../lib/agent/providers";
import type { ModelRoles } from "../../../lib/agent/types";
import type { FastifyRequest } from "fastify";
import type { GatewayProviderProbeCredentialResolver } from "./credential-broker";
import { PinnedHttpsGatewayTransport, type GatewayUpstreamResponse, type GatewayUpstreamTransport } from "./production-connector";
import type { GatewayProtocol } from "./contracts";

const MAX_PROBE_RESPONSE_BYTES = 8 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export const PROVIDER_PROBE_CHECKS = Object.freeze([
  "authentication", "modelExistence", "streaming", "toolCalling", "cancellation",
  "usage", "timeout", "minimalReasoning", "dnsPinning", "redirectRevalidation",
] as const);
export type ProviderProbeCheck = (typeof PROVIDER_PROBE_CHECKS)[number];

export interface GatewayProviderProbeRequest {
  readonly providerRevisionId: string;
  readonly agent: "claude-code" | "codex-cli";
  readonly protocol: GatewayProtocol;
  readonly baseUrl: string;
  readonly models: ModelRoles;
  readonly credentialVersionId: string;
  readonly requiredChecks: readonly ProviderProbeCheck[];
}

export interface GatewayProviderProbeService {
  run(value: unknown): Promise<Readonly<{ providerRevisionId: string; checks: Readonly<Record<ProviderProbeCheck, "PASS">> }>>;
}

/** Executes the compatibility contract with the exact models and secret version. */
export class StrictGatewayProviderProbe implements GatewayProviderProbeService {
  readonly #transport: GatewayUpstreamTransport;
  constructor(private readonly options: Readonly<{
    credentials: GatewayProviderProbeCredentialResolver;
    dns: DnsResolver;
    transport?: GatewayUpstreamTransport;
  }>) { this.#transport = options.transport ?? new PinnedHttpsGatewayTransport(); }

  async run(value: unknown): Promise<Readonly<{ providerRevisionId: string; checks: Readonly<Record<ProviderProbeCheck, "PASS">> }>> {
    const provider = parseProviderProbeRequest(value);
    const endpoint = await validateEndpointForConnection(provider.baseUrl, this.options.dns, { approvedPorts: [443], maxRedirects: 3 });
    const lease = await this.options.credentials.resolveProviderProbe({
      providerRevisionId: provider.providerRevisionId,
      credentialVersionId: provider.credentialVersionId,
    });
    try {
      const secret = secretText(lease.value);
      const uniqueModels = [...new Set(Object.values(provider.models))];
      let primaryResponse: unknown | null = null;
      for (const model of uniqueModels) {
        const response = await this.#jsonRequest(provider, endpoint, minimalBody(provider.protocol, model), secret, new AbortController().signal);
        validateMinimal(provider.protocol, response);
        if (model === provider.models.primaryModel) primaryResponse = response;
      }
      if (primaryResponse === null) invalid();
      validateUsage(provider.protocol, primaryResponse);

      const streamed = await this.#request(provider, endpoint, streamBody(provider), secret, new AbortController().signal);
      if (streamed.statusCode < 200 || streamed.statusCode >= 300
        || !contentType(streamed).startsWith("text/event-stream")) invalid();
      validateStreamUsage(provider.protocol, (await readBounded(streamed.body)).toString("utf8"));

      const toolResponse = await this.#jsonRequest(provider, endpoint, toolBody(provider), secret, new AbortController().signal);
      validateToolCall(provider.protocol, toolResponse);
      await this.#verifyAbortPolicy(provider, endpoint, secret, AbortSignal.abort(), "cancellation");
      const timeout = new AbortController();
      const timeoutHandle = setTimeout(() => timeout.abort(), 1);
      try { await this.#verifyAbortPolicy(provider, endpoint, secret, timeout.signal, "timeout"); }
      finally { clearTimeout(timeoutHandle); }

      const checks = Object.freeze(Object.fromEntries(PROVIDER_PROBE_CHECKS.map((name) => [name, "PASS"])) as Record<ProviderProbeCheck, "PASS">);
      return Object.freeze({ providerRevisionId: provider.providerRevisionId, checks });
    } finally { lease.destroy(); }
  }

  async #jsonRequest(
    provider: GatewayProviderProbeRequest,
    endpoint: ValidatedEndpoint,
    body: Readonly<Record<string, unknown>>,
    secret: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.#request(provider, endpoint, body, secret, signal);
    if (response.statusCode < 200 || response.statusCode >= 300 || !contentType(response).includes("json")) invalid();
    const raw = await readBounded(response.body);
    try { return JSON.parse(raw.toString("utf8")) as unknown; } catch { invalid(); }
  }

  async #request(
    provider: GatewayProviderProbeRequest,
    initialEndpoint: ValidatedEndpoint,
    body: Readonly<Record<string, unknown>>,
    secret: string,
    signal: AbortSignal,
  ): Promise<GatewayUpstreamResponse> {
    const encoded = Buffer.from(JSON.stringify(body));
    let endpoint = initialEndpoint;
    let url = inferenceUrl(endpoint.url, provider.protocol);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await this.#transport.request({ endpoint, url, headers: headers(provider.protocol, secret), body: encoded, signal });
      if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response;
      const location = singleHeader(response.headers.location);
      response.body.destroy();
      if ((response.statusCode !== 307 && response.statusCode !== 308) || !location || redirect === 3) invalid();
      const next = await validateRedirectForConnection(url.toString(), location, redirect + 1, this.options.dns, { approvedPorts: [443], maxRedirects: 3 });
      const nextUrl = inferenceUrl(next.url, provider.protocol);
      if (nextUrl.origin !== url.origin) invalid();
      endpoint = next;
      url = nextUrl;
    }
    invalid();
  }

  async #verifyAbortPolicy(
    provider: GatewayProviderProbeRequest,
    endpoint: ValidatedEndpoint,
    secret: string,
    signal: AbortSignal,
    check: "cancellation" | "timeout",
  ): Promise<void> {
    try {
      const response = await this.#request(provider, endpoint, minimalBody(provider.protocol, provider.models.primaryModel), secret, signal);
      response.body.destroy();
      throw new Error(`Provider ${check} probe was not aborted`);
    } catch (error) {
      if (error instanceof Error && error.message === `Provider ${check} probe was not aborted`) throw error;
      if (!signal.aborted) throw error;
    }
  }
}

export class GatewayProbeSpiffeAuthorizer {
  constructor(private readonly allowedSpiffeIds: ReadonlySet<string>) {
    if (allowedSpiffeIds.size < 1 || allowedSpiffeIds.size > 32) invalid();
  }

  authorize(request: FastifyRequest): void {
    const socket = request.raw.socket;
    if (!(socket instanceof TLSSocket) || !socket.authorized) throw new Error("Provider probe requires an authorized mTLS identity");
    const peer = socket.getPeerCertificate(false);
    const spiffe = String(peer.subjectaltname ?? "").split(/,\s*/)
      .filter((entry) => entry.startsWith("URI:spiffe://"))
      .map((entry) => entry.slice(4));
    if (spiffe.length !== 1 || !this.allowedSpiffeIds.has(spiffe[0]!)) throw new Error("Provider probe workload is forbidden");
  }
}

export function parseProviderProbeRequest(value: unknown): GatewayProviderProbeRequest {
  const body = record(value);
  if (!SAFE_ID.test(String(body.providerRevisionId ?? "")) || !SAFE_ID.test(String(body.credentialVersionId ?? ""))
    || (body.agent !== "claude-code" && body.agent !== "codex-cli")
    || (body.protocol !== "anthropic-messages" && body.protocol !== "openai-responses")
    || (body.agent === "codex-cli") !== (body.protocol === "openai-responses")) invalid();
  if (!Array.isArray(body.requiredChecks)
    || JSON.stringify(body.requiredChecks) !== JSON.stringify(PROVIDER_PROBE_CHECKS)) invalid();
  const modelsBody = record(body.models);
  const models = Object.freeze({
    primaryModel: pinned(modelsBody.primaryModel),
    planningModel: pinned(modelsBody.planningModel),
    smallFastModel: pinned(modelsBody.smallFastModel),
    subagentModel: pinned(modelsBody.subagentModel),
  });
  return Object.freeze({
    providerRevisionId: body.providerRevisionId as string,
    agent: body.agent,
    protocol: body.protocol,
    baseUrl: strictString(body.baseUrl, 2_048),
    models,
    credentialVersionId: body.credentialVersionId as string,
    requiredChecks: PROVIDER_PROBE_CHECKS,
  });
}

function minimalBody(protocol: GatewayProtocol, model: string): Readonly<Record<string, unknown>> {
  return protocol === "openai-responses"
    ? Object.freeze({ model, input: "Reply with exactly OK.", max_output_tokens: 16, store: false })
    : Object.freeze({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with exactly OK." }] });
}
function streamBody(provider: GatewayProviderProbeRequest): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...minimalBody(provider.protocol, provider.models.primaryModel), stream: true });
}
function toolBody(provider: GatewayProviderProbeRequest): Readonly<Record<string, unknown>> {
  const tool = { name: "deviludo_probe_ok", description: "Return probe success", input_schema: { type: "object", properties: {}, additionalProperties: false } };
  if (provider.protocol === "anthropic-messages") return Object.freeze({
    model: provider.models.primaryModel, max_tokens: 32, messages: [{ role: "user", content: "Call the probe tool." }],
    tools: [tool], tool_choice: { type: "tool", name: tool.name },
  });
  return Object.freeze({
    model: provider.models.primaryModel, input: "Call the probe tool.", max_output_tokens: 32, store: false,
    tools: [{ type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema, strict: true }],
    tool_choice: { type: "function", name: tool.name },
  });
}

function validateMinimal(protocol: GatewayProtocol, value: unknown): void {
  const body = record(value);
  if (protocol === "openai-responses") {
    if (typeof body.id !== "string" || (!body.output && typeof body.output_text !== "string")) invalid();
  } else if (body.type !== "message" || !Array.isArray(body.content) || body.content.length < 1) invalid();
  const usage = usageRecord(protocol, body);
  if (integer(usage.input_tokens) < 1 || integer(usage.output_tokens) < 1) invalid();
}
function validateUsage(protocol: GatewayProtocol, value: unknown): void { validateMinimal(protocol, value); }
function validateStreamUsage(protocol: GatewayProtocol, value: string): void {
  let input = 0; let output = 0; let terminal = false;
  for (const event of value.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(data) as unknown; } catch { invalid(); }
    const body = record(parsed);
    if (protocol === "openai-responses" && body.type === "response.completed") {
      const usage = usageRecord(protocol, record(body.response)); input = integer(usage.input_tokens); output = integer(usage.output_tokens); terminal = true;
    } else if (protocol === "anthropic-messages" && body.type === "message_start") {
      const usage = usageRecord(protocol, record(body.message)); input = integer(usage.input_tokens);
    } else if (protocol === "anthropic-messages" && body.type === "message_delta") {
      output = integer(record(body.usage).output_tokens); terminal = true;
    }
  }
  if (!terminal || input < 1 || output < 1) invalid();
}
function validateToolCall(protocol: GatewayProtocol, value: unknown): void {
  const body = record(value);
  const values = protocol === "openai-responses" ? body.output : body.content;
  if (!Array.isArray(values) || !values.some((item) => {
    const entry = record(item);
    return protocol === "openai-responses"
      ? entry.type === "function_call" && entry.name === "deviludo_probe_ok"
      : entry.type === "tool_use" && entry.name === "deviludo_probe_ok";
  })) invalid();
}
function usageRecord(_protocol: GatewayProtocol, body: Record<string, unknown>): Record<string, unknown> { return record(body.usage); }
function headers(protocol: GatewayProtocol, secret: string): Readonly<Record<string, string>> {
  return Object.freeze({
    "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "DeviLudo-Provider-Probe/1",
    ...(protocol === "anthropic-messages" ? { "x-api-key": secret, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${secret}` }),
  });
}
function inferenceUrl(base: string, protocol: GatewayProtocol): URL {
  const url = new URL(base); const suffix = protocol === "openai-responses" ? "/responses" : "/messages";
  url.pathname = url.pathname.replace(/\/+$/, "").endsWith(suffix) ? url.pathname.replace(/\/+$/, "") : `${url.pathname.replace(/\/+$/, "")}${suffix}`;
  if (url.search || url.hash) invalid(); return url;
}
async function readBounded(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of stream) { const chunk = Buffer.isBuffer(value) ? value : typeof value === "string" ? Buffer.from(value) : Buffer.from(value as Uint8Array); size += chunk.byteLength; if (size > MAX_PROBE_RESPONSE_BYTES) invalid(); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function contentType(response: GatewayUpstreamResponse): string { return (singleHeader(response.headers["content-type"]) ?? "").toLowerCase(); }
function singleHeader(value: string | string[] | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
function secretText(value: Uint8Array): string { if (value.byteLength < 8 || value.byteLength > 64 * 1024) invalid(); const text = Buffer.from(value).toString("utf8"); if (/\0|\r|\n/.test(text)) invalid(); return text; }
function pinned(value: unknown): string { if (typeof value !== "string") invalid(); try { return assertPinnedModelId(value); } catch { invalid(); } }
function strictString(value: unknown, maximum: number): string { if (typeof value !== "string" || value.length < 1 || value.length > maximum || /\0/.test(value)) invalid(); return value; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); return value as number; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function invalid(): never { throw new Error("Inference Provider compatibility probe failed"); }
