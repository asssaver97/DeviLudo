import { Injectable } from "@nestjs/common";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  SpecModelReconciliationReceipt,
  SpecModelReconciliationRequest,
  SpecModelReconciliationStatus,
} from "../../spec-model-broker/src/contracts";
import { ServiceProblem } from "./contracts";
import { providerProbeHttpsJson, type ProviderProbeHttp } from "./provider-probe";

export abstract class SpecModelGenerationReconciler {
  abstract probe(): Promise<void>;
  abstract lookup(tenantId: string, generationOperationKey: string): Promise<SpecModelReconciliationStatus | null>;
  abstract reconcile(input: SpecModelReconciliationRequest): Promise<SpecModelReconciliationReceipt>;
}

export class SpecModelBrokerReconciliationClient extends SpecModelGenerationReconciler {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly http: ProviderProbeHttp = providerProbeHttpsJson,
  ) { super(); }

  async probe(): Promise<void> {
    if (!this.env.DEVILUDO_SPEC_MODEL_RECONCILIATION_URL && this.env.NODE_ENV !== "production") return;
    const url = this.endpoint();
    url.pathname = "/healthz";
    const tls = await reconciliationTls(this.env);
    try {
      const response = await this.http(url, { method: "GET", ...tls, timeoutMs: 10_000 });
      const health = exact(response.payload, ["schemaVersion", "service", "status"]);
      if (response.statusCode !== 200 || health.schemaVersion !== "deviludo.spec-model-health.v1"
        || health.status !== "ok" || health.service !== "deviludo-spec-model-broker") unavailable("readiness");
    } catch (error) {
      if (error instanceof ServiceProblem) throw error;
      unavailable("readiness");
    } finally { wipeTls(tls); }
  }

  async lookup(tenantId: string, generationOperationKey: string): Promise<SpecModelReconciliationStatus | null> {
    const url = this.endpoint();
    url.pathname = "/v1/spec-generation-reconciliations/lookup";
    try {
      const response = await this.call(url, JSON.stringify({ tenantId, generationOperationKey }));
      if (response.statusCode !== 200) unavailable("lookup");
      return parseStatus(response.payload, tenantId, generationOperationKey);
    } catch (error) {
      if (error instanceof ServiceProblem) throw error;
      unavailable("lookup");
    }
  }

  async reconcile(input: SpecModelReconciliationRequest): Promise<SpecModelReconciliationReceipt> {
    const url = this.endpoint();
    try {
      const response = await this.call(url, JSON.stringify(input));
      if (response.statusCode === 409) {
        throw new ServiceProblem(409, "SPEC_MODEL_RECONCILIATION_CONFLICT", "The specification model generation cannot be reconciled with this outcome");
      }
      if (response.statusCode !== 200) unavailable("mutation");
      return parseReceipt(response.payload, input);
    } catch (error) {
      if (error instanceof ServiceProblem) throw error;
      unavailable("mutation");
    }
  }

  private endpoint(): URL {
    const raw = this.env.DEVILUDO_SPEC_MODEL_RECONCILIATION_URL?.trim();
    if (!raw) unavailable("configuration");
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || url.pathname.replace(/\/$/, "") !== "/v1/spec-generation-reconciliations") {
      throw new ServiceProblem(500, "INVALID_SPEC_MODEL_RECONCILIATION_BROKER", "Specification model reconciliation URL must be credential-free HTTPS");
    }
    url.pathname = "/v1/spec-generation-reconciliations";
    return url;
  }

  private async call(url: URL, body: string) {
    const tls = await reconciliationTls(this.env);
    try { return await this.http(url, { method: "POST", ...tls, timeoutMs: 30_000, body }); }
    finally { wipeTls(tls); }
  }
}

Injectable()(SpecModelBrokerReconciliationClient);

export function createSpecModelGenerationReconciler(): SpecModelGenerationReconciler {
  return new SpecModelBrokerReconciliationClient();
}

async function secretFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = env[name]?.trim();
  if (!path || !isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) throw new Error(`${name} file is invalid`);
    return await file.readFile();
  } finally { await file.close(); }
}

async function reconciliationTls(env: Readonly<Record<string, string | undefined>>) {
  const [key, certificate, ca] = await Promise.all([
    secretFile(env, "DEVILUDO_SPEC_MODEL_RECONCILIATION_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_SPEC_MODEL_RECONCILIATION_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_SPEC_MODEL_RECONCILIATION_CA_FILE"),
  ]);
  return { key, certificate, ca };
}
function wipeTls(tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>): void {
  tls.key.fill(0); tls.certificate.fill(0); tls.ca.fill(0);
}

function parseStatus(raw: unknown, tenantId: string, generationOperationKey: string): SpecModelReconciliationStatus | null {
  if (raw === null) return null;
  const value = exact(raw, ["conversationId", "createdAt", "dispatchGeneration", "generationOperationKey", "model", "profileRevisionId", "projectId", "providerRevisionId", "state", "tenantId"]);
  if (value.tenantId !== tenantId || value.generationOperationKey !== generationOperationKey
    || !UUID.test(String(value.projectId)) || !UUID.test(String(value.conversationId))
    || !positive(value.dispatchGeneration) || !safeId(value.profileRevisionId)
    || !safeId(value.providerRevisionId) || !model(value.model) || value.state !== "INDETERMINATE"
    || !iso(value.createdAt)) invalidResponse();
  return Object.freeze({
    tenantId, projectId: value.projectId as string, conversationId: value.conversationId as string,
    generationOperationKey, dispatchGeneration: value.dispatchGeneration as number,
    profileRevisionId: value.profileRevisionId as string, providerRevisionId: value.providerRevisionId as string,
    model: value.model as string, state: "INDETERMINATE", createdAt: new Date(value.createdAt as string).toISOString(),
  });
}

function parseReceipt(raw: unknown, input: SpecModelReconciliationRequest): SpecModelReconciliationReceipt {
  const value = exact(raw, ["action", "dispatchGeneration", "evidenceDigest", "generationOperationKey", "operationKey", "reconciledAt", "state", "tenantId", "usage"]);
  const usage = exact(value.usage, ["inputTokens", "outputTokens"]);
  if (value.operationKey !== input.operationKey || value.tenantId !== input.tenantId
    || value.generationOperationKey !== input.generationOperationKey || value.action !== input.action
    || value.evidenceDigest !== input.evidenceDigest || value.state !== "RELEASED"
    || !positive(value.dispatchGeneration) || !iso(value.reconciledAt)
    || !nonnegative(usage.inputTokens) || !nonnegative(usage.outputTokens)
    || usage.inputTokens !== (input.inputTokens ?? 0) || usage.outputTokens !== (input.outputTokens ?? 0)) invalidResponse();
  return Object.freeze({
    operationKey: input.operationKey, tenantId: input.tenantId,
    generationOperationKey: input.generationOperationKey,
    dispatchGeneration: value.dispatchGeneration as number, action: input.action,
    evidenceDigest: input.evidenceDigest, state: "RELEASED",
    usage: Object.freeze({ inputTokens: usage.inputTokens as number, outputTokens: usage.outputTokens as number }),
    reconciledAt: new Date(value.reconciledAt as string).toISOString(),
  });
}

function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalidResponse();
  const value = raw as Record<string, unknown>;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalidResponse();
  return value;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function safeId(value: unknown): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value); }
function model(value: unknown): boolean { return typeof value === "string" && value.length <= 200 && /[0-9]/.test(value) && !/\s/.test(value); }
function iso(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonnegative(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function invalidResponse(): never { throw new ServiceProblem(502, "INVALID_SPEC_MODEL_RECONCILIATION_RESPONSE", "Specification model reconciliation response is invalid"); }
function unavailable(stage: string): never {
  throw new ServiceProblem(503, "SPEC_MODEL_RECONCILIATION_UNAVAILABLE", `Specification model reconciliation ${stage} is unavailable`);
}
