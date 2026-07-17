import { createHash, randomUUID } from "node:crypto";
import type { DeliveryState } from "../../../lib/orchestration/game-delivery";
import type { DeliveryDispatchRequest } from "./activities";
import type {
  DeliveryActivityReceipt,
  DeliveryCommandDestination,
  DispatchableDeliveryCommand,
} from "./contracts";
import { deliveryCommandDestination } from "./contracts";

const COMMAND_STATES = {
  CONTINUE_IDEA_DIALOGUE: "IDEATION",
  REQUEST_SPEC_APPROVAL: "WAITING_SPEC_APPROVAL",
  START_LOCKED_AGENT_RUN: "DEVELOPMENT_QUEUED",
  WAIT_FOR_PROVIDER: "WAITING_PROVIDER",
  START_TARGET_MATRIX_E2E: "CROSS_PLATFORM_E2E",
  REQUEST_USER_ACCEPTANCE: "WAITING_USER_ACCEPTANCE",
  MERGE_DRAFT_PULL_REQUEST: "MERGING",
  START_MAIN_SHA_RELEASE_GATE: "MAIN_SHA_E2E",
  REQUEST_FRESH_MFA: "WAITING_MFA",
  UPLOAD_AND_ACTIVATE_PRIVATE_BETA: "STEAM_PRIVATE_BETA",
  INSTALL_FROM_CLEAN_STEAM_CLIENT: "STEAM_INSTALL_E2E",
  WAIT_FOR_EXTERNAL_APPROVAL: "EXTERNAL_APPROVAL_REQUIRED",
  PUBLISH_STEAM_DEFAULT_BRANCH: "READY_TO_PUBLISH",
} as const satisfies Record<DispatchableDeliveryCommand, DeliveryState>;

export interface WorkflowDispatchHeaders {
  readonly idempotencyKey: string;
  readonly workflowId: string;
  readonly destination: string;
  readonly operation: string;
}

export interface WorkflowCommandHandler {
  /** Resolve only after the command is durably queued by the owning service. */
  enqueue(request: DeliveryDispatchRequest): Promise<void>;
}

export interface WorkflowCommandInbox {
  acquire(input: {
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly destination: DeliveryCommandDestination;
    readonly operation: DispatchableDeliveryCommand | "CANCEL_DELIVERY";
    readonly claimToken: string;
    readonly claimExpiresAt: string;
  }): Promise<
    | { readonly kind: "ACQUIRED" }
    | { readonly kind: "BUSY" }
    | { readonly kind: "COMPLETED"; readonly receipt: DeliveryActivityReceipt }
  >;
  complete(input: {
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly tenantId: string;
    readonly claimToken: string;
    readonly receipt: DeliveryActivityReceipt;
  }): Promise<void>;
  release(input: {
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly tenantId: string;
    readonly claimToken: string;
  }): Promise<void>;
}

export class WorkflowCommandReceiver {
  constructor(
    private readonly destination: DeliveryCommandDestination,
    private readonly inbox: WorkflowCommandInbox,
    private readonly handler: WorkflowCommandHandler,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async receive(
    value: unknown,
    headers: WorkflowDispatchHeaders,
  ): Promise<DeliveryActivityReceipt> {
    const request = assertDeliveryDispatchRequest(value, this.destination);
    assertTransportBinding(request, headers);
    const requestDigest = deliveryDispatchRequestDigest(request);
    const claimToken = randomUUID();
    const acceptedAt = this.now();
    if (!Number.isFinite(acceptedAt.getTime())) throw new Error("Workflow receiver clock is invalid");
    const acquisition = await this.inbox.acquire({
      idempotencyKey: request.payload.idempotencyKey,
      requestDigest,
      tenantId: request.payload.tenantId,
      projectId: request.payload.projectId,
      workflowId: request.payload.workflowId,
      destination: request.destination,
      operation: request.kind === "COMMAND" ? request.payload.command : "CANCEL_DELIVERY",
      claimToken,
      claimExpiresAt: new Date(acceptedAt.getTime() + 5 * 60_000).toISOString(),
    });
    if (acquisition.kind === "BUSY") throw new Error("Workflow command is already being accepted");
    if (acquisition.kind === "COMPLETED") {
      assertReceiptMatchesRequest(acquisition.receipt, request);
      return acquisition.receipt;
    }

    try {
      await this.handler.enqueue(request);
      const receipt = Object.freeze({
        receiptId: randomUUID(),
        acceptedAt: acceptedAt.toISOString(),
        destination: request.destination,
        workflowId: request.payload.workflowId,
        idempotencyKey: request.payload.idempotencyKey,
        operation: request.kind === "COMMAND" ? request.payload.command : "CANCEL_DELIVERY",
      }) satisfies DeliveryActivityReceipt;
      await this.inbox.complete({
        idempotencyKey: request.payload.idempotencyKey,
        requestDigest,
        tenantId: request.payload.tenantId,
        claimToken,
        receipt,
      });
      return receipt;
    } catch (error) {
      await this.inbox.release({
        idempotencyKey: request.payload.idempotencyKey,
        requestDigest,
        tenantId: request.payload.tenantId,
        claimToken,
      });
      throw error;
    }
  }
}

type InboxRecord = {
  requestDigest: string;
  claimToken: string | null;
  claimExpiresAt: string | null;
  receipt: DeliveryActivityReceipt | null;
};

/** Test/local implementation. Production implements the same lease in Postgres. */
export class InMemoryWorkflowCommandInbox implements WorkflowCommandInbox {
  readonly #records = new Map<string, InboxRecord>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async acquire(input: Parameters<WorkflowCommandInbox["acquire"]>[0]): Promise<Awaited<ReturnType<WorkflowCommandInbox["acquire"]>>> {
    const existing = this.#records.get(input.idempotencyKey);
    if (existing && existing.requestDigest !== input.requestDigest) {
      throw new Error("Workflow idempotency key was reused with another request");
    }
    if (existing?.receipt) return { kind: "COMPLETED", receipt: existing.receipt };
    if (existing?.claimToken && existing.claimExpiresAt && Date.parse(existing.claimExpiresAt) > this.now().getTime()) {
      return { kind: "BUSY" };
    }
    this.#records.set(input.idempotencyKey, {
      requestDigest: input.requestDigest,
      claimToken: input.claimToken,
      claimExpiresAt: input.claimExpiresAt,
      receipt: null,
    });
    return { kind: "ACQUIRED" };
  }

  async complete(input: Parameters<WorkflowCommandInbox["complete"]>[0]): Promise<void> {
    const record = this.#records.get(input.idempotencyKey);
    assertClaim(record, input.requestDigest, input.claimToken);
    this.#records.set(input.idempotencyKey, {
      requestDigest: input.requestDigest,
      claimToken: null,
      claimExpiresAt: null,
      receipt: Object.freeze({ ...input.receipt }),
    });
  }

  async release(input: Parameters<WorkflowCommandInbox["release"]>[0]): Promise<void> {
    const record = this.#records.get(input.idempotencyKey);
    assertClaim(record, input.requestDigest, input.claimToken);
    this.#records.set(input.idempotencyKey, {
      requestDigest: input.requestDigest,
      claimToken: null,
      claimExpiresAt: null,
      receipt: null,
    });
  }
}

export function assertDeliveryDispatchRequest(
  value: unknown,
  expectedDestination: DeliveryCommandDestination,
): DeliveryDispatchRequest {
  if (!value || typeof value !== "object") throw new Error("Workflow dispatch body is invalid");
  const envelope = value as Record<string, unknown>;
  if (envelope.kind !== "COMMAND" && envelope.kind !== "CANCEL") throw new Error("Workflow dispatch kind is invalid");
  if (envelope.destination !== expectedDestination || !envelope.payload || typeof envelope.payload !== "object") {
    throw new Error("Workflow dispatch destination is invalid");
  }
  const payload = envelope.payload as Record<string, unknown>;
  const snapshot = payload.snapshot;
  if (
    !nonEmpty(payload.idempotencyKey) ||
    !nonEmpty(payload.workflowId) ||
    !nonEmpty(payload.tenantId) ||
    !nonEmpty(payload.projectId) ||
    payload.destination !== envelope.destination ||
    !snapshot ||
    typeof snapshot !== "object" ||
    (snapshot as Record<string, unknown>).workflowId !== payload.workflowId ||
    (snapshot as Record<string, unknown>).tenantId !== payload.tenantId ||
    (snapshot as Record<string, unknown>).projectId !== payload.projectId
  ) {
    throw new Error("Workflow dispatch immutable binding is invalid");
  }
  if (envelope.kind === "CANCEL") {
    if (expectedDestination !== "control-plane" || !nonEmpty(payload.reason)) {
      throw new Error("Workflow cancellation binding is invalid");
    }
    const request = value as Extract<DeliveryDispatchRequest, { kind: "CANCEL" }>;
    assertSnapshotCommandBinding(request, "CANCEL_DELIVERY");
    return request;
  }
  if (!isDispatchableCommand(payload.command)) throw new Error("Workflow command is invalid");
  if (deliveryCommandDestination(payload.command) !== expectedDestination) {
    throw new Error("Workflow command is not owned by this destination");
  }
  const request = value as Extract<DeliveryDispatchRequest, { kind: "COMMAND" }>;
  assertSnapshotCommandBinding(request, payload.command);
  return request;
}

function assertSnapshotCommandBinding(
  request: DeliveryDispatchRequest,
  operation: DispatchableDeliveryCommand | "CANCEL_DELIVERY",
): void {
  const { snapshot } = request.payload;
  const expectedState = operation === "CANCEL_DELIVERY" ? "CANCELLED" : COMMAND_STATES[operation];
  if (snapshot.state !== expectedState) throw new Error("Workflow command state binding is invalid");
  const expectedKey = `${snapshot.workflowId}:${snapshot.history.length}:${snapshot.state}:${operation}`;
  if (request.payload.idempotencyKey !== expectedKey) throw new Error("Workflow command idempotency binding is invalid");
  if (!Array.isArray(snapshot.targetMatrix) || snapshot.targetMatrix.length === 0) {
    throw new Error("Workflow command target matrix is invalid");
  }
  if (operation === "START_LOCKED_AGENT_RUN" && !snapshot.lockedRunConfigurationId) missing(operation);
  if (operation === "START_TARGET_MATRIX_E2E" && (!snapshot.candidateCommitSha || !snapshot.draftPullRequest)) missing(operation);
  if (operation === "MERGE_DRAFT_PULL_REQUEST" && (!snapshot.candidateCommitSha || !snapshot.draftPullRequest || !snapshot.candidateEvidenceBundleId)) missing(operation);
  if (operation === "START_MAIN_SHA_RELEASE_GATE" && !snapshot.mainCommitSha) missing(operation);
  if (operation === "REQUEST_FRESH_MFA" && (!snapshot.mainCommitSha || !snapshot.mainEvidenceBundleId)) missing(operation);
  if (operation === "UPLOAD_AND_ACTIVATE_PRIVATE_BETA" && (!snapshot.mainCommitSha || !snapshot.mainEvidenceBundleId || !snapshot.mfaApprovalId)) missing(operation);
  if (operation === "INSTALL_FROM_CLEAN_STEAM_CLIENT" && !snapshot.steamBuildId) missing(operation);
  if (operation === "WAIT_FOR_EXTERNAL_APPROVAL" && (!snapshot.steamInstallEvidenceBundleId || !snapshot.externalGate)) missing(operation);
  if (operation === "PUBLISH_STEAM_DEFAULT_BRANCH" && (snapshot.externalApprovals.length !== 3 || !snapshot.steamBuildId || snapshot.externalGate)) missing(operation);
  if (operation === "CANCEL_DELIVERY") {
    if (request.kind !== "CANCEL") missing(operation);
    const lastSignal = snapshot.history.at(-1)?.signal;
    if (lastSignal?.type !== "CANCEL" || lastSignal.reason !== request.payload.reason) missing(operation);
  }
}

function assertTransportBinding(
  request: DeliveryDispatchRequest,
  headers: WorkflowDispatchHeaders,
): void {
  const operation = request.kind === "COMMAND" ? request.payload.command : "CANCEL_DELIVERY";
  if (
    headers.idempotencyKey !== request.payload.idempotencyKey ||
    headers.workflowId !== request.payload.workflowId ||
    headers.destination !== request.destination ||
    headers.operation !== operation
  ) {
    throw new Error("Workflow dispatch transport binding mismatch");
  }
}

function assertReceiptMatchesRequest(
  receipt: DeliveryActivityReceipt,
  request: DeliveryDispatchRequest,
): void {
  const operation = request.kind === "COMMAND" ? request.payload.command : "CANCEL_DELIVERY";
  if (
    receipt.destination !== request.destination ||
    receipt.workflowId !== request.payload.workflowId ||
    receipt.idempotencyKey !== request.payload.idempotencyKey ||
    receipt.operation !== operation
  ) {
    throw new Error("Stored workflow receipt binding mismatch");
  }
}

function assertClaim(
  record: InboxRecord | undefined,
  requestDigest: string,
  claimToken: string,
): asserts record is InboxRecord {
  if (!record || record.requestDigest !== requestDigest || record.claimToken !== claimToken || record.receipt) {
    throw new Error("Workflow command claim was lost");
  }
}

export function deliveryDispatchRequestDigest(request: DeliveryDispatchRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 1_024;
}

function isDispatchableCommand(value: unknown): value is DispatchableDeliveryCommand {
  return typeof value === "string" && Object.hasOwn(COMMAND_STATES, value);
}

function missing(operation: string): never {
  throw new Error(`Workflow command ${operation} is missing its required snapshot binding`);
}
