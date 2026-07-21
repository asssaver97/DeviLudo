import {
  steamDepotFinalizationReceiptDigest,
  validateSteamDepotFinalizationReceipt,
} from "./contract";
import type {
  SteamDepotFinalizationOperationStore,
  SteamDepotFinalizationReceipt,
  SteamDepotFinalizationRequest,
} from "./contracts";

type Entry = {
  request: SteamDepotFinalizationRequest;
  state: "PENDING" | "RUNNING" | "COMPLETED";
  claimToken: string | null;
  claimExpiresAt: string | null;
  attempts: number;
  receipt: SteamDepotFinalizationReceipt | null;
};

export class InMemorySteamDepotFinalizationOperations implements SteamDepotFinalizationOperationStore {
  readonly entries = new Map<string, Entry>();

  async claim(input: Parameters<SteamDepotFinalizationOperationStore["claim"]>[0]) {
    const key = `${input.request.tenantId}:${input.request.operationKey}`;
    const entry = this.entries.get(key) ?? {
      request: input.request,
      state: "PENDING" as const,
      claimToken: null,
      claimExpiresAt: null,
      attempts: 0,
      receipt: null,
    };
    if (JSON.stringify(entry.request) !== JSON.stringify(input.request)) invalid();
    this.entries.set(key, entry);
    if (entry.state === "COMPLETED") {
      if (!entry.receipt) invalid();
      return Object.freeze({ kind: "REPLAY" as const, receipt: entry.receipt });
    }
    if (entry.state === "RUNNING" && Date.parse(entry.claimExpiresAt ?? "") > Date.parse(input.claimedAt)) {
      return Object.freeze({ kind: "BUSY" as const });
    }
    entry.state = "RUNNING";
    entry.claimToken = input.claimToken;
    entry.claimExpiresAt = input.claimExpiresAt;
    entry.attempts += 1;
    return Object.freeze({ kind: "ACQUIRED" as const, attempt: entry.attempts });
  }

  async complete(input: Parameters<SteamDepotFinalizationOperationStore["complete"]>[0]): Promise<void> {
    const entry = this.entry(input.request);
    const receipt = validateSteamDepotFinalizationReceipt(input.receipt, input.request);
    if (steamDepotFinalizationReceiptDigest(receipt) !== input.receiptDigest) invalid();
    if (entry.state === "COMPLETED") {
      if (!entry.receipt || steamDepotFinalizationReceiptDigest(entry.receipt) !== input.receiptDigest) invalid();
      return;
    }
    if (entry.state !== "RUNNING" || entry.claimToken !== input.claimToken
      || Date.parse(entry.claimExpiresAt ?? "") <= Date.parse(input.completedAt)) invalid();
    entry.state = "COMPLETED";
    entry.claimToken = null;
    entry.claimExpiresAt = null;
    entry.receipt = receipt;
  }

  async release(input: Parameters<SteamDepotFinalizationOperationStore["release"]>[0]): Promise<void> {
    const entry = this.entry(input.request);
    if (entry.state !== "RUNNING" || entry.claimToken !== input.claimToken) invalid();
    entry.state = "PENDING";
    entry.claimToken = null;
    entry.claimExpiresAt = null;
  }

  async probe(): Promise<void> {}

  private entry(request: SteamDepotFinalizationRequest): Entry {
    const entry = this.entries.get(`${request.tenantId}:${request.operationKey}`);
    if (!entry || JSON.stringify(entry.request) !== JSON.stringify(request)) invalid();
    return entry;
  }
}

function invalid(): never { throw new Error("In-memory Steam depot finalization operation is invalid"); }
