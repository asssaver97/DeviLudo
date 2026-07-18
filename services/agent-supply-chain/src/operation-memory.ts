import { sha256Canonical } from "../../runner-control/src/canonical";
import type {
  AgentSupplyChainOperationPersistence,
  AgentSupplyChainOperationResult,
  AgentSupplyChainRequest,
} from "./contracts";
import { parseAgentSupplyChainRequest, validateAgentSupplyChainOperationResult } from "./request-contract";

type Entry = {
  operationKey: string;
  requestDigest: string;
  kind: string;
  payloadDigest: string;
  request: AgentSupplyChainRequest;
  state: "PENDING" | "RUNNING" | "COMPLETED";
  claimToken: string | null;
  claimExpiresAt: string | null;
  attempt: number;
  response: AgentSupplyChainOperationResult | null;
  responseDigest: string | null;
};

/** Test/development store. Production composition always uses PostgreSQL. */
export class InMemoryAgentSupplyChainOperations implements AgentSupplyChainOperationPersistence {
  readonly entries = new Map<string, Entry>();

  async claim(input: Parameters<AgentSupplyChainOperationPersistence["claim"]>[0]) {
    const request = parseAgentSupplyChainRequest(input.request);
    const existing = this.entries.get(input.operationKey);
    if (existing) {
      if (existing.requestDigest !== input.requestDigest || existing.kind !== input.kind
        || existing.payloadDigest !== input.payloadDigest) invalid();
      if (existing.state === "COMPLETED" && existing.response) {
        const response = validateAgentSupplyChainOperationResult(existing.response, request);
        if (sha256Canonical(response) !== existing.responseDigest) invalid();
        return Object.freeze({ kind: "REPLAY" as const, response });
      }
      if (existing.state === "RUNNING" && Date.parse(existing.claimExpiresAt ?? "") > Date.parse(input.claimedAt)) {
        return Object.freeze({ kind: "BUSY" as const });
      }
      existing.state = "RUNNING";
      existing.claimToken = input.claimToken;
      existing.claimExpiresAt = input.claimExpiresAt;
      existing.attempt += 1;
      return Object.freeze({ kind: "ACQUIRED" as const, attempt: existing.attempt });
    }
    this.entries.set(input.operationKey, {
      operationKey: input.operationKey,
      requestDigest: input.requestDigest,
      kind: input.kind,
      payloadDigest: input.payloadDigest,
      request,
      state: "RUNNING",
      claimToken: input.claimToken,
      claimExpiresAt: input.claimExpiresAt,
      attempt: 1,
      response: null,
      responseDigest: null,
    });
    return Object.freeze({ kind: "ACQUIRED" as const, attempt: 1 });
  }

  async complete(input: Parameters<AgentSupplyChainOperationPersistence["complete"]>[0]): Promise<void> {
    const entry = this.entries.get(input.operationKey);
    if (!entry) invalid();
    const response = validateAgentSupplyChainOperationResult(input.response, entry.request);
    if (sha256Canonical(response) !== input.responseDigest) invalid();
    if (entry.state === "COMPLETED") {
      if (entry.responseDigest !== input.responseDigest || !entry.response
        || sha256Canonical(entry.response) !== input.responseDigest) invalid();
      return;
    }
    if (entry.state !== "RUNNING" || entry.claimToken !== input.claimToken
      || Date.parse(entry.claimExpiresAt ?? "") <= Date.parse(input.completedAt)) invalid();
    entry.state = "COMPLETED";
    entry.claimToken = null;
    entry.claimExpiresAt = null;
    entry.response = response;
    entry.responseDigest = input.responseDigest;
  }

  async release(input: Parameters<AgentSupplyChainOperationPersistence["release"]>[0]): Promise<void> {
    const entry = this.entries.get(input.operationKey);
    if (!entry || entry.state !== "RUNNING" || entry.claimToken !== input.claimToken
      || !Number.isFinite(Date.parse(input.releasedAt))) invalid();
    entry.state = "PENDING";
    entry.claimToken = null;
    entry.claimExpiresAt = null;
  }

  async probe(): Promise<void> {}
}

function invalid(): never { throw new Error("In-memory Agent supply-chain operation is invalid"); }
