import { parseSpecModelResult } from "../../spec-dialogue/src/contracts";
import { canonical, validateUsage } from "./contract";
import type {
  SpecModelOperationClaim,
  SpecModelOperationLookup,
  SpecModelOperationStore,
  SpecModelProviderBinding,
  SpecModelUsage,
} from "./contracts";
import { SpecModelRequestError } from "./contracts";

type State = "CLAIMED" | "COMPLETED" | "RELEASED" | "INDETERMINATE";
type Record = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly provider: SpecModelProviderBinding;
  state: State;
  claimToken: string | null;
  claimExpiresAt: number | null;
  result: ReturnType<typeof parseSpecModelResult> | null;
  usage: SpecModelUsage | null;
};

export class MemorySpecModelOperationStore implements SpecModelOperationStore {
  readonly records = new Map<string, Record>();
  constructor(private readonly now: () => number = Date.now) {}

  async lookup(input: Parameters<SpecModelOperationStore["lookup"]>[0]): Promise<SpecModelOperationLookup> {
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
