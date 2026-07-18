import { randomUUID } from "node:crypto";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type {
  AgentSupplyChainNativeExecutor,
  AgentSupplyChainOperationPersistence,
  AgentSupplyChainRequest,
  AgentSupplyChainResponse,
  AgentSupplyChainTerminalFailureReceipt,
} from "./contracts";
import {
  agentSupplyChainOperationKind,
  agentSupplyChainPayloadDigest,
  isAgentSupplyChainTerminalFailure,
  parseAgentSupplyChainRequest,
  parseAgentSupplyChainTerminalFailure,
  validateAgentSupplyChainOperationResult,
  validateAgentSupplyChainResponse,
} from "./request-contract";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DEFAULT_LEASE_MS = 10 * 60_000;

export class AgentSupplyChainBusyError extends Error {
  constructor() { super("Agent supply-chain operation is already running"); this.name = "AgentSupplyChainBusyError"; }
}

export class AgentSupplyChainTerminalError extends Error {
  constructor(readonly receipt: AgentSupplyChainTerminalFailureReceipt) {
    super("Agent supply-chain policy rejected the operation");
    this.name = "AgentSupplyChainTerminalError";
  }
}

/** Durable, fenced composition around the fixed native supply-chain executable. */
export class DurableAgentSupplyChainBrokerService {
  readonly #now: () => Date;
  readonly #claimToken: () => string;
  readonly #leaseMs: number;

  constructor(
    private readonly operations: AgentSupplyChainOperationPersistence,
    private readonly executor: AgentSupplyChainNativeExecutor,
    options: Readonly<{ now?: () => Date; claimToken?: () => string; leaseMs?: number }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#claimToken = options.claimToken ?? randomUUID;
    this.#leaseMs = boundedLease(options.leaseMs ?? DEFAULT_LEASE_MS);
  }

  async execute(value: unknown): Promise<AgentSupplyChainResponse> {
    const request = parseAgentSupplyChainRequest(value);
    const claimToken = this.#claimToken();
    if (!UUID.test(claimToken)) invalid();
    const claimedAt = validDate(this.#now());
    const claim = await this.operations.claim({
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      kind: agentSupplyChainOperationKind(request),
      payloadDigest: agentSupplyChainPayloadDigest(request),
      request,
      claimToken,
      claimedAt: claimedAt.toISOString(),
      claimExpiresAt: new Date(claimedAt.getTime() + this.#leaseMs).toISOString(),
    });
    if (claim.kind === "BUSY") throw new AgentSupplyChainBusyError();
    if (claim.kind === "REPLAY") {
      const replay = validateAgentSupplyChainOperationResult(claim.response, request);
      if (isAgentSupplyChainTerminalFailure(replay)) throw new AgentSupplyChainTerminalError(replay);
      return replay;
    }
    try {
      const response = validateAgentSupplyChainResponse(await this.executor.execute(request), request);
      const completedAt = validDate(this.#now()).toISOString();
      await this.operations.complete({
        operationKey: request.operationKey,
        claimToken,
        response,
        responseDigest: sha256Canonical(response),
        completedAt,
      });
      return response;
    } catch (error) {
      if (error instanceof AgentSupplyChainTerminalError) {
        const receipt = parseAgentSupplyChainTerminalFailure(error.receipt, request);
        const completedAt = validDate(this.#now()).toISOString();
        await this.operations.complete({
          operationKey: request.operationKey,
          claimToken,
          response: receipt,
          responseDigest: sha256Canonical(receipt),
          completedAt,
        });
        throw new AgentSupplyChainTerminalError(receipt);
      }
      await this.operations.release({
        operationKey: request.operationKey,
        claimToken,
        releasedAt: validDate(this.#now()).toISOString(),
      }).catch(() => undefined);
      throw error;
    }
  }

  async probe(): Promise<void> {
    await Promise.all([this.operations.probe(), this.executor.probe()]);
  }
}

export function requestForOperation(value: unknown): AgentSupplyChainRequest {
  return parseAgentSupplyChainRequest(value);
}

function boundedLease(value: number): number {
  if (!Number.isInteger(value) || value < 30_000 || value > 10 * 60_000) invalid();
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return value;
}

function invalid(): never { throw new Error("Agent supply-chain Broker state is invalid"); }
