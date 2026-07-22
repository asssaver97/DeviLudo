import { Injectable } from "@nestjs/common";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  InferenceReconciliationReceipt,
  InferenceReconciliationRequest,
  InferenceReconciliationStatus,
} from "../../inference-gateway/src/contracts";
import { probeInferenceGatewayHealth, providerProbeHttpsJson, type ProviderProbeHttp } from "./provider-probe";
import { ServiceProblem } from "./contracts";

export abstract class InferenceRequestReconciler {
  abstract probe(): Promise<void>;
  abstract lookup(tenantId: string, runId: string): Promise<InferenceReconciliationStatus | null>;
  abstract reconcile(input: InferenceReconciliationRequest): Promise<InferenceReconciliationReceipt>;
}

export class InferenceGatewayReconciliationClient extends InferenceRequestReconciler {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly http: ProviderProbeHttp = providerProbeHttpsJson,
  ) { super(); }

  async probe(): Promise<void> {
    const endpoint = this.env.DEVILUDO_INFERENCE_RECONCILIATION_URL;
    if (!endpoint) {
      if (this.env.NODE_ENV !== "production") return;
      throw new ServiceProblem(503, "INFERENCE_RECONCILIATION_UNAVAILABLE", "Inference reconciliation is not configured");
    }
    const url = validateEndpoint(endpoint);
    const tls = await reconciliationTls(this.env);
    try { await probeInferenceGatewayHealth(url, tls, this.http); }
    catch (error) {
      if (error instanceof ServiceProblem) throw error;
      throw new ServiceProblem(503, "INFERENCE_RECONCILIATION_UNAVAILABLE", "Inference reconciliation readiness did not complete");
    } finally { wipeTls(tls); }
  }

  async lookup(tenantId: string, runId: string): Promise<InferenceReconciliationStatus | null> {
    const endpoint = this.env.DEVILUDO_INFERENCE_RECONCILIATION_URL;
    if (!endpoint) {
      throw new ServiceProblem(503, "INFERENCE_RECONCILIATION_UNAVAILABLE", "Inference reconciliation is not configured");
    }
    const url = validateEndpoint(endpoint);
    url.pathname = "/v1/inference-reconciliations/lookup";
    try {
      const response = await this.#call(url, JSON.stringify({ tenantId, runId }));
      if (response.statusCode !== 200) {
        throw new ServiceProblem(503, "INFERENCE_RECONCILIATION_UNAVAILABLE", "Inference reconciliation lookup did not complete");
      }
      return parseLookup(response.payload, tenantId, runId);
    } catch (error) {
      if (error instanceof ServiceProblem) throw error;
      throw new ServiceProblem(503, "INFERENCE_RECONCILIATION_UNAVAILABLE", "Inference reconciliation lookup did not complete");
    }
  }

  async reconcile(input: InferenceReconciliationRequest): Promise<InferenceReconciliationReceipt> {
    const endpoint = this.env.DEVILUDO_INFERENCE_RECONCILIATION_URL;
    if (!endpoint) {
      throw new ServiceProblem(503, "INFERENCE_RECONCILIATION_UNAVAILABLE", "Inference reconciliation is not configured");
    }
    const url = validateEndpoint(endpoint);
    try {
      const response = await this.#call(url, JSON.stringify(input));
      if (response.statusCode === 409) {
        throw new ServiceProblem(409, "INFERENCE_RECONCILIATION_CONFLICT", "The inference request cannot be reconciled with this outcome");
      }
      if (response.statusCode !== 200) {
        throw new ServiceProblem(503, "INFERENCE_RECONCILIATION_UNAVAILABLE", "Inference reconciliation did not complete");
      }
      return parseReceipt(response.payload, input);
    } catch (error) {
      if (error instanceof ServiceProblem) throw error;
      throw new ServiceProblem(503, "INFERENCE_RECONCILIATION_UNAVAILABLE", "Inference reconciliation did not complete");
    }
  }

  async #call(url: URL, body: string) {
    const tls = await reconciliationTls(this.env);
    try { return await this.http(url, { method: "POST", ...tls, timeoutMs: 30_000, body }); }
    finally { wipeTls(tls); }
  }
}

Injectable()(InferenceGatewayReconciliationClient);

export function createInferenceRequestReconciler(): InferenceRequestReconciler {
  return new InferenceGatewayReconciliationClient();
}

function validateEndpoint(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/$/, "") !== "/v1/inference-reconciliations") {
    throw new ServiceProblem(500, "INVALID_RECONCILIATION_GATEWAY", "Inference reconciliation URL must be credential-free HTTPS");
  }
  url.pathname = "/v1/inference-reconciliations";
  return url;
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

async function reconciliationTls(env: Readonly<Record<string, string | undefined>>) {
  const [key, certificate, ca] = await Promise.all([
    secretFile(env, "DEVILUDO_INFERENCE_RECONCILIATION_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_INFERENCE_RECONCILIATION_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_INFERENCE_RECONCILIATION_CA_FILE"),
  ]);
  return { key, certificate, ca };
}
function wipeTls(tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>): void {
  tls.key.fill(0); tls.certificate.fill(0); tls.ca.fill(0);
}

function parseReceipt(raw: unknown, input: InferenceReconciliationRequest): InferenceReconciliationReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalidReceipt();
  const value = raw as Record<string, unknown>;
  const keys = ["action", "evidenceDigest", "operationKey", "reconciledAt", "requestId", "runId", "state", "tenantId", "usage"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) invalidReceipt();
  if (value.operationKey !== input.operationKey || value.tenantId !== input.tenantId
    || value.runId !== input.runId || value.requestId !== input.requestId
    || value.action !== input.action || value.evidenceDigest !== input.evidenceDigest
    || (input.action === "RECORD_USAGE") !== (value.state === "COMPLETED")) invalidReceipt();
  if (typeof value.reconciledAt !== "string" || !Number.isFinite(Date.parse(value.reconciledAt))) invalidReceipt();
  const usage = value.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) invalidReceipt();
  const usageValue = usage as Record<string, unknown>;
  if (JSON.stringify(Object.keys(usageValue).sort()) !== JSON.stringify(["costUsd", "inputTokens", "outputTokens"])
    || !safeInteger(usageValue.inputTokens) || !safeInteger(usageValue.outputTokens)
    || typeof usageValue.costUsd !== "number" || !Number.isFinite(usageValue.costUsd) || usageValue.costUsd < 0) invalidReceipt();
  if (input.action === "CONFIRM_NO_USAGE"
    && (value.state !== "RELEASED" || usageValue.inputTokens !== 0 || usageValue.outputTokens !== 0 || usageValue.costUsd !== 0)) invalidReceipt();
  if (input.action === "RECORD_USAGE"
    && (usageValue.inputTokens !== input.inputTokens || usageValue.outputTokens !== input.outputTokens)) invalidReceipt();
  return Object.freeze({
    operationKey: value.operationKey as string,
    tenantId: value.tenantId as string,
    runId: value.runId as string,
    requestId: value.requestId as string,
    action: value.action as InferenceReconciliationReceipt["action"],
    evidenceDigest: value.evidenceDigest as string,
    state: value.state as InferenceReconciliationReceipt["state"],
    usage: Object.freeze({
      inputTokens: usageValue.inputTokens as number,
      outputTokens: usageValue.outputTokens as number,
      costUsd: usageValue.costUsd,
    }),
    reconciledAt: new Date(value.reconciledAt as string).toISOString(),
  });
}

function parseLookup(raw: unknown, tenantId: string, runId: string): InferenceReconciliationStatus | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalidReceipt();
  const value = raw as Record<string, unknown>;
  const keys = ["claimExpiresAt", "createdAt", "model", "providerRevisionId", "requestId", "runId", "state", "tenantId"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
    || value.tenantId !== tenantId || value.runId !== runId
    || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || typeof value.providerRevisionId !== "string" || !value.providerRevisionId
    || typeof value.model !== "string" || !value.model
    || (value.state !== "ACTIVE" && value.state !== "INDETERMINATE")
    || typeof value.claimExpiresAt !== "string" || !Number.isFinite(Date.parse(value.claimExpiresAt))
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) invalidReceipt();
  return Object.freeze({
    tenantId,
    runId,
    requestId: value.requestId,
    providerRevisionId: value.providerRevisionId,
    model: value.model,
    state: value.state,
    claimExpiresAt: new Date(value.claimExpiresAt).toISOString(),
    createdAt: new Date(value.createdAt).toISOString(),
  });
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function safeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function invalidReceipt(): never {
  throw new ServiceProblem(502, "INVALID_RECONCILIATION_RESPONSE", "Inference reconciliation response is invalid");
}
