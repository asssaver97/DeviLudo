import { randomUUID } from "node:crypto";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import type {
  SteamDefaultBranchWorkflowReceipt,
  SteamPrivateBetaWorkflowReceipt,
} from "./workflow-handler";
import {
  parseSteamWorkflowOperationRequest,
  validateSteamWorkflowOperationStatus,
  type SteamWorkflowOperationLookup,
  type SteamWorkflowOperationRequest,
  type SteamWorkflowOperationService,
  type SteamWorkflowOperationStatus,
} from "./workflow-broker-http";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,99}$/;
const LEASE_MS = 5 * 60_000;

export interface SteamWorkflowOperationPersistence {
  reserve(input: Readonly<{
    operationId: string;
    submitterSpiffeId: string;
    request: SteamWorkflowOperationRequest;
    createdAt: string;
  }>): Promise<Readonly<{ created: boolean; status: SteamWorkflowOperationStatus }>>;
  find(lookup: SteamWorkflowOperationLookup): Promise<SteamWorkflowOperationStatus>;
  claim(input: Readonly<{
    tenantId: string;
    operationId: string;
    claimToken: string;
    claimedAt: string;
    claimExpiresAt: string;
  }>): Promise<
    | Readonly<{ kind: "ACQUIRED"; request: SteamWorkflowOperationRequest }>
    | Readonly<{ kind: "BUSY" | "TERMINAL"; status: SteamWorkflowOperationStatus }>
  >;
  heartbeat(input: Readonly<{
    tenantId: string;
    operationId: string;
    claimToken: string;
    heartbeatAt: string;
    claimExpiresAt: string;
  }>): Promise<void>;
  complete(input: Readonly<{
    tenantId: string;
    operationId: string;
    claimToken: string;
    receipt: SteamPrivateBetaWorkflowReceipt | SteamDefaultBranchWorkflowReceipt;
    completedAt: string;
  }>): Promise<SteamWorkflowOperationStatus>;
  fail(input: Readonly<{
    tenantId: string;
    operationId: string;
    claimToken: string;
    errorCode: string;
    terminal: true;
    completedAt: string;
  }>): Promise<SteamWorkflowOperationStatus>;
  release(input: Readonly<{
    tenantId: string;
    operationId: string;
    claimToken: string;
    releasedAt: string;
  }>): Promise<void>;
  probe(): Promise<void>;
}

export interface SteamWorkflowOperationDispatcher {
  enqueue(input: Readonly<{
    tenantId: string;
    operationId: string;
    operationKey: string;
    requestDigest: string;
  }>): Promise<void>;
  probe(): Promise<void>;
}

export interface SteamWorkflowOperationExecutor {
  execute(
    request: SteamWorkflowOperationRequest,
    context: Readonly<{ heartbeat: () => Promise<void> }>,
  ): Promise<SteamPrivateBetaWorkflowReceipt | SteamDefaultBranchWorkflowReceipt>;
  probe(): Promise<void>;
}

/** HTTP-facing operation service. It persists before dispatch and never runs Steam in the request process. */
export class DurableSteamWorkflowOperationService implements SteamWorkflowOperationService {
  readonly #now: () => Date;
  readonly #operationId: () => string;

  constructor(
    private readonly operations: SteamWorkflowOperationPersistence,
    private readonly dispatcher: SteamWorkflowOperationDispatcher,
    options: Readonly<{ now?: () => Date; operationId?: () => string }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#operationId = options.operationId ?? randomUUID;
  }

  async submit(
    identity: EvidenceArchiveWorkloadIdentity,
    value: SteamWorkflowOperationRequest,
  ): Promise<SteamWorkflowOperationStatus> {
    const request = parseSteamWorkflowOperationRequest(value);
    const submitterSpiffeId = validateIdentity(identity);
    const operationId = this.#operationId();
    if (!UUID.test(operationId)) invalid();
    const reserved = await this.operations.reserve({
      operationId,
      submitterSpiffeId,
      request,
      createdAt: validNow(this.#now()).toISOString(),
    });
    if (reserved.status.status === "RUNNING") {
      await this.dispatcher.enqueue({
        tenantId: request.tenantId,
        operationId: reserved.status.operationId,
        operationKey: request.operationKey,
        requestDigest: request.requestDigest,
      });
    }
    return validateSteamWorkflowOperationStatus(reserved.status, request);
  }

  async get(
    identity: EvidenceArchiveWorkloadIdentity,
    lookup: SteamWorkflowOperationLookup,
  ): Promise<SteamWorkflowOperationStatus> {
    validateIdentity(identity);
    validateLookup(lookup);
    return validateSteamWorkflowOperationStatus(await this.operations.find(lookup), lookup);
  }

  async probe(): Promise<void> {
    await Promise.all([this.operations.probe(), this.dispatcher.probe()]);
  }
}

/** Queue consumer. Lease loss prevents a stale worker from committing a Steam result. */
export class SteamWorkflowOperationWorker {
  readonly #now: () => Date;
  readonly #claimToken: () => string;
  readonly #leaseMs: number;

  constructor(
    private readonly operations: SteamWorkflowOperationPersistence,
    private readonly executor: SteamWorkflowOperationExecutor,
    options: Readonly<{ now?: () => Date; claimToken?: () => string; leaseMs?: number }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#claimToken = options.claimToken ?? randomUUID;
    this.#leaseMs = boundedLease(options.leaseMs ?? LEASE_MS);
  }

  async execute(input: Readonly<{ tenantId: string; operationId: string }>): Promise<SteamWorkflowOperationStatus> {
    if (!UUID.test(input.tenantId) || !UUID.test(input.operationId)) invalid();
    const claimToken = this.#claimToken();
    if (!UUID.test(claimToken)) invalid();
    const claimedAt = validNow(this.#now());
    const claim = await this.operations.claim({
      ...input,
      claimToken,
      claimedAt: claimedAt.toISOString(),
      claimExpiresAt: new Date(claimedAt.getTime() + this.#leaseMs).toISOString(),
    });
    if (claim.kind !== "ACQUIRED") return claim.status;
    const request = parseSteamWorkflowOperationRequest(claim.request);
    if (request.tenantId !== input.tenantId) invalid();
    try {
      const receipt = await this.executor.execute(request, {
        heartbeat: async () => {
          const heartbeatAt = validNow(this.#now());
          await this.operations.heartbeat({
            ...input,
            claimToken,
            heartbeatAt: heartbeatAt.toISOString(),
            claimExpiresAt: new Date(heartbeatAt.getTime() + this.#leaseMs).toISOString(),
          });
        },
      });
      validateSteamWorkflowOperationStatus({
        status: "COMPLETED",
        kind: request.kind,
        operationId: input.operationId,
        operationKey: request.operationKey,
        requestDigest: request.requestDigest,
        receipt,
      }, request);
      return await this.operations.complete({
        ...input,
        claimToken,
        receipt,
        completedAt: validNow(this.#now()).toISOString(),
      });
    } catch (error) {
      if (error instanceof SteamWorkflowExecutionError && error.terminal) {
        return await this.operations.fail({
          ...input,
          claimToken,
          errorCode: error.code,
          terminal: true,
          completedAt: validNow(this.#now()).toISOString(),
        });
      }
      await this.operations.release({
        ...input,
        claimToken,
        releasedAt: validNow(this.#now()).toISOString(),
      });
      throw error;
    }
  }

  async probe(): Promise<void> {
    await Promise.all([this.operations.probe(), this.executor.probe()]);
  }
}

export class SteamWorkflowExecutionError extends Error {
  constructor(readonly code: string, readonly terminal: boolean) {
    if (!ERROR_CODE.test(code)) invalid();
    super(code);
    this.name = "SteamWorkflowExecutionError";
  }
}

function validateIdentity(identity: EvidenceArchiveWorkloadIdentity): string {
  if (!identity || typeof identity !== "object" || typeof identity.spiffeId !== "string"
    || !identity.spiffeId.startsWith("spiffe://") || identity.spiffeId.length > 512) invalid();
  const url = new URL(identity.spiffeId);
  if (url.protocol !== "spiffe:" || url.username || url.password || url.search || url.hash) invalid();
  return url.toString();
}

function validateLookup(value: SteamWorkflowOperationLookup): void {
  if (!UUID.test(value.tenantId) || !UUID.test(value.operationId)
    || !/^workflow-job:[a-f0-9-]{36}$/.test(value.operationKey)
    || !/^[a-f0-9]{64}$/.test(value.requestDigest)) invalid();
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return value;
}

function boundedLease(value: number): number {
  if (!Number.isInteger(value) || value < 30_000 || value > 15 * 60_000) invalid();
  return value;
}

function invalid(): never { throw new Error("Steam workflow operation is invalid"); }
