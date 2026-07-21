import type {
  SpecModelReconciliationReceipt,
  SpecModelReconciliationRequest,
  SpecModelReconciliationStatus,
  SpecModelReconciliationStore,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

export class SpecModelReconciliationRequestError extends Error {}

export class StrictSpecModelReconciliationService {
  constructor(private readonly store: SpecModelReconciliationStore) {}

  lookup(value: unknown): Promise<SpecModelReconciliationStatus | null> {
    const body = exact(value, ["generationOperationKey", "tenantId"]);
    const tenantId = string(body.tenantId);
    const generationOperationKey = string(body.generationOperationKey);
    if (!UUID.test(tenantId) || !SHA256.test(generationOperationKey)) invalid();
    return this.store.lookupReconciliation(tenantId, generationOperationKey);
  }

  run(value: unknown): Promise<SpecModelReconciliationReceipt> {
    return this.store.reconcile(parseSpecModelReconciliationRequest(value));
  }
}

export function parseSpecModelReconciliationRequest(value: unknown): SpecModelReconciliationRequest {
  const body = object(value);
  const action = body.action;
  if (action !== "CONFIRM_NO_USAGE" && action !== "RECORD_USAGE") invalid();
  const expected = action === "RECORD_USAGE"
    ? ["action", "evidenceDigest", "generationOperationKey", "inputTokens", "operationKey", "outputTokens", "reconciledBy", "tenantId"]
    : ["action", "evidenceDigest", "generationOperationKey", "operationKey", "reconciledBy", "tenantId"];
  exactKeys(body, expected);
  const operationKey = string(body.operationKey);
  const tenantId = string(body.tenantId);
  const generationOperationKey = string(body.generationOperationKey);
  const evidenceDigest = string(body.evidenceDigest);
  const reconciledBy = string(body.reconciledBy);
  if (!SHA256.test(operationKey) || !UUID.test(tenantId) || !SHA256.test(generationOperationKey)
    || !SHA256.test(evidenceDigest) || !SAFE_ACTOR.test(reconciledBy)) invalid();
  if (action === "CONFIRM_NO_USAGE") {
    return Object.freeze({ operationKey, tenantId, generationOperationKey, action, evidenceDigest, reconciledBy });
  }
  const inputTokens = integer(body.inputTokens, true);
  const outputTokens = integer(body.outputTokens, false);
  if (inputTokens + outputTokens > 10_000_000) invalid();
  return Object.freeze({
    operationKey, tenantId, generationOperationKey, action, evidenceDigest,
    reconciledBy, inputTokens, outputTokens,
  });
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const body = object(value); exactKeys(body, keys); return body;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalid();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function integer(value: unknown, zeroAllowed: boolean): number {
  if (!Number.isSafeInteger(value) || (value as number) < (zeroAllowed ? 0 : 1)) invalid();
  return value as number;
}
function invalid(): never { throw new SpecModelReconciliationRequestError("Specification model reconciliation request is invalid"); }
