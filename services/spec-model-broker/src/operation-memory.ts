import { parseSpecModelResult } from "../../spec-dialogue/src/contracts";
import { canonical, validateUsage } from "./contract";
import type {
  SpecModelOperationClaim,
  SpecModelOperationLookup,
  SpecModelOperationStore,
  SpecModelProviderBinding,
  SpecModelReconciliationReceipt,
  SpecModelReconciliationStore,
  SpecModelUsage,
} from "./contracts";
import { SpecModelReconciliationConflictError, SpecModelRequestError } from "./contracts";
import { parseSpecModelReconciliationRequest } from "./reconciliation";

type State = "CLAIMED" | "COMPLETED" | "RELEASED" | "INDETERMINATE";
type Record = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly provider: SpecModelProviderBinding;
  readonly createdAt: number;
  dispatchGeneration: number;
  state: State;
  claimToken: string | null;
  claimExpiresAt: number | null;
  result: ReturnType<typeof parseSpecModelResult> | null;
  usage: SpecModelUsage | null;
};

export class MemorySpecModelOperationStore implements SpecModelOperationStore, SpecModelReconciliationStore {
  readonly records = new Map<string, Record>();
  readonly reconciliations = new Map<string, SpecModelReconciliationReceipt>();
  readonly reconciliationRequests = new Map<string, string>();
  constructor(private readonly now: () => number = Date.now) {}

  lookup(input: Parameters<SpecModelOperationStore["lookup"]>[0]): Promise<SpecModelOperationLookup> {
    return this.lookupOperation(input);
  }

  async claim(input: Parameters<SpecModelOperationStore["claim"]>[0]): Promise<SpecModelOperationClaim> {
    const existing = this.records.get(key(input.tenantId, input.operationKey));
    if (existing) {
      assertRequest(existing, input);
      if (canonical(existing.provider) !== canonical(input.provider)) invalid();
      if (existing.state === "COMPLETED") return Object.freeze({ kind: "COMPLETED", result: existing.result! });
      if (existing.state === "INDETERMINATE") return Object.freeze({ kind: "INDETERMINATE" });
      if (existing.state === "CLAIMED" && existing.claimExpiresAt !== null && existing.claimExpiresAt <= this.now()) {
        existing.state = "INDETERMINATE";
        existing.claimToken = null;
        existing.claimExpiresAt = null;
        return Object.freeze({ kind: "INDETERMINATE" });
      }
      if (existing.state === "CLAIMED") return Object.freeze({ kind: "BUSY" });
      existing.state = "CLAIMED";
      existing.dispatchGeneration += 1;
      existing.claimToken = input.claimToken;
      existing.claimExpiresAt = this.now() + input.leaseSeconds * 1_000;
      return Object.freeze({ kind: "CLAIMED", claimToken: input.claimToken });
    }
    this.records.set(key(input.tenantId, input.operationKey), {
      tenantId: input.tenantId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      operationKey: input.operationKey,
      requestDigest: input.requestDigest,
      provider: input.provider,
      createdAt: this.now(),
      dispatchGeneration: 1,
      state: "CLAIMED",
      claimToken: input.claimToken,
      claimExpiresAt: this.now() + input.leaseSeconds * 1_000,
      result: null,
      usage: null,
    });
    return Object.freeze({ kind: "CLAIMED", claimToken: input.claimToken });
  }

  async complete(input: Parameters<SpecModelOperationStore["complete"]>[0]): Promise<void> {
    const record = this.require(input.tenantId, input.operationKey);
    const result = parseSpecModelResult(input.result);
    const usage = validateUsage(input.usage);
    if (record.state === "COMPLETED") {
      if (canonical(record.result) !== canonical(result) || canonical(record.usage) !== canonical(usage)) invalid();
      return;
    }
    if (record.state !== "CLAIMED" || record.claimToken !== input.claimToken
      || record.claimExpiresAt === null || record.claimExpiresAt <= this.now()) invalid();
    record.state = "COMPLETED";
    record.claimToken = null;
    record.claimExpiresAt = null;
    record.result = result;
    record.usage = usage;
  }

  async release(input: Parameters<SpecModelOperationStore["release"]>[0]): Promise<void> {
    this.transition(input, "RELEASED");
  }
  async abandon(input: Parameters<SpecModelOperationStore["abandon"]>[0]): Promise<void> {
    this.transition(input, "INDETERMINATE");
  }
  async probe(): Promise<void> {}

  async lookupReconciliation(tenantId: string, generationOperationKey: string) {
    const record = this.records.get(key(tenantId, generationOperationKey));
    if (!record) return null;
    if (record.state === "CLAIMED" && record.claimExpiresAt !== null && record.claimExpiresAt <= this.now()) {
      record.state = "INDETERMINATE"; record.claimToken = null; record.claimExpiresAt = null;
    }
    if (record.state !== "INDETERMINATE") return null;
    return Object.freeze({
      tenantId: record.tenantId, projectId: record.projectId, conversationId: record.conversationId,
      generationOperationKey: record.operationKey, dispatchGeneration: record.dispatchGeneration,
      profileRevisionId: record.provider.profileRevisionId, providerRevisionId: record.provider.providerRevisionId,
      model: record.provider.model, state: "INDETERMINATE" as const,
      createdAt: new Date(record.createdAt).toISOString(),
    });
  }

  async reconcile(value: Parameters<SpecModelReconciliationStore["reconcile"]>[0]): Promise<SpecModelReconciliationReceipt> {
    const input = parseSpecModelReconciliationRequest(value);
    const reconciliationKey = key(input.tenantId, input.operationKey);
    const replay = this.reconciliations.get(reconciliationKey);
    if (replay) {
      if (this.reconciliationRequests.get(reconciliationKey) !== canonical(input)) conflict();
      return replay;
    }
    const record = this.records.get(key(input.tenantId, input.generationOperationKey));
    if (!record) conflict();
    if (record.state === "CLAIMED" && record.claimExpiresAt !== null && record.claimExpiresAt <= this.now()) {
      record.state = "INDETERMINATE"; record.claimToken = null; record.claimExpiresAt = null;
    }
    if (record.state !== "INDETERMINATE") conflict();
    if ([...this.reconciliations.values()].some((item) => item.tenantId === input.tenantId
      && item.generationOperationKey === input.generationOperationKey
      && item.dispatchGeneration === record.dispatchGeneration)) conflict();
    const receipt = Object.freeze({
      operationKey: input.operationKey, tenantId: input.tenantId,
      generationOperationKey: input.generationOperationKey,
      dispatchGeneration: record.dispatchGeneration, action: input.action,
      evidenceDigest: input.evidenceDigest, state: "RELEASED" as const,
      usage: Object.freeze({ inputTokens: input.inputTokens ?? 0, outputTokens: input.outputTokens ?? 0 }),
      reconciledAt: new Date(this.now()).toISOString(),
    });
    this.reconciliations.set(reconciliationKey, receipt);
    this.reconciliationRequests.set(reconciliationKey, canonical(input));
    record.state = "RELEASED";
    return receipt;
  }

  private transition(input: { tenantId: string; operationKey: string; claimToken: string }, state: State): void {
    const record = this.require(input.tenantId, input.operationKey);
    if (record.state === state) return;
    if (record.state !== "CLAIMED" || record.claimToken !== input.claimToken) invalid();
    record.state = state;
    record.claimToken = null;
    record.claimExpiresAt = null;
  }
  private require(tenantId: string, operationKey: string): Record {
    const record = this.records.get(key(tenantId, operationKey));
    if (!record) invalid();
    return record;
  }

  private async lookupOperation(input: Parameters<SpecModelOperationStore["lookup"]>[0]): Promise<SpecModelOperationLookup> {
    const record = this.records.get(key(input.tenantId, input.operationKey));
    if (!record) return null;
    assertRequest(record, input);
    if (record.state === "COMPLETED") return Object.freeze({ kind: "COMPLETED", result: record.result! });
    if (record.state === "INDETERMINATE") return Object.freeze({ kind: "INDETERMINATE" });
    if (record.state === "RELEASED") return Object.freeze({ kind: "RETRY" });
    if (record.claimExpiresAt !== null && record.claimExpiresAt <= this.now()) {
      record.state = "INDETERMINATE";
      record.claimToken = null;
      record.claimExpiresAt = null;
      return Object.freeze({ kind: "INDETERMINATE" });
    }
    return Object.freeze({ kind: "BUSY" });
  }
}

function assertRequest(record: Record, input: {
  tenantId: string; projectId: string; conversationId: string; operationKey: string; requestDigest: string;
}): void {
  if (record.tenantId !== input.tenantId || record.projectId !== input.projectId
    || record.conversationId !== input.conversationId || record.operationKey !== input.operationKey
    || record.requestDigest !== input.requestDigest) invalid();
}
function key(tenantId: string, operationKey: string): string { return `${tenantId}\0${operationKey}`; }
function invalid(): never { throw new SpecModelRequestError("Specification model operation binding is invalid"); }
function conflict(): never { throw new SpecModelReconciliationConflictError("Specification model reconciliation conflicts with durable state"); }
