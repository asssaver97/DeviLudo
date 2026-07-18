import type {
  InferenceReconciliationReceipt,
  InferenceReconciliationRequest,
  InferenceReconciliationStatus,
  InferenceReconciliationStore,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

export interface GatewayInferenceReconciliationService {
  lookup(value: unknown): Promise<InferenceReconciliationStatus | null>;
  run(value: unknown): Promise<InferenceReconciliationReceipt>;
}

export class InferenceReconciliationRequestError extends Error {
  readonly code = "INVALID_RECONCILIATION_REQUEST";
  readonly statusCode = 400;
  constructor() { super("Inference reconciliation request is invalid"); }
}

export class StrictGatewayInferenceReconciliation implements GatewayInferenceReconciliationService {
  constructor(private readonly store: InferenceReconciliationStore) {}
  lookup(value: unknown): Promise<InferenceReconciliationStatus | null> {
    const body = object(value);
    if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["runId", "tenantId"])) invalid();
    const tenantId = string(body.tenantId);
    const runId = string(body.runId);
    if (!UUID.test(tenantId) || !UUID.test(runId)) invalid();
    return this.store.lookup(tenantId, runId);
  }
  run(value: unknown): Promise<InferenceReconciliationReceipt> {
    return this.store.reconcile(parseInferenceReconciliationRequest(value));
  }
}

export function parseInferenceReconciliationRequest(value: unknown): InferenceReconciliationRequest {
  const body = object(value);
  const action = body.action;
  if (action !== "CONFIRM_NO_USAGE" && action !== "RECORD_USAGE") invalid();
  const expected = action === "RECORD_USAGE"
    ? ["action", "evidenceDigest", "inputTokens", "operationKey", "outputTokens", "reconciledBy", "requestId", "runId", "tenantId"]
    : ["action", "evidenceDigest", "operationKey", "reconciledBy", "requestId", "runId", "tenantId"];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected)) invalid();
  const operationKey = string(body.operationKey);
  const tenantId = string(body.tenantId);
  const runId = string(body.runId);
  const requestId = string(body.requestId);
  const evidenceDigest = string(body.evidenceDigest);
  const reconciledBy = string(body.reconciledBy);
  if (!SHA256.test(operationKey) || !UUID.test(tenantId) || !UUID.test(runId)
    || !UUID.test(requestId) || !SHA256.test(evidenceDigest) || !SAFE_ACTOR.test(reconciledBy)) invalid();
  if (action === "CONFIRM_NO_USAGE") {
    return Object.freeze({ operationKey, tenantId, runId, requestId, action, evidenceDigest, reconciledBy });
  }
  const inputTokens = integer(body.inputTokens);
  const outputTokens = integer(body.outputTokens);
  if (inputTokens + outputTokens < 1) invalid();
  return Object.freeze({
    operationKey, tenantId, runId, requestId, action, evidenceDigest,
    reconciledBy, inputTokens, outputTokens,
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}
function invalid(): never { throw new InferenceReconciliationRequestError(); }
