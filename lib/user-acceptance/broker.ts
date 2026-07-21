import type { UserFeedbackReceipt } from "@/services/user-acceptance/src/contracts";
import type { CandidateAcceptanceReceipt } from "@/services/user-acceptance/src/candidate-acceptance";
import type { DeliveryCancellationReceipt } from "@/services/user-acceptance/src/delivery-cancellation";
import { parseSpecModelResult, type SpecDialogueMessage } from "@/services/spec-dialogue/src/contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export class UserAcceptanceBrokerClient {
  readonly #endpoint: URL;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetcher: typeof fetch = fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || url.pathname !== "/") throw new Error("User acceptance Broker endpoint is invalid");
    this.#endpoint = new URL("/v1/user-feedback", url);
    this.#fetch = fetcher;
  }

  async submit(command: Readonly<Record<string, unknown>>): Promise<UserFeedbackReceipt> {
    return parseReceipt(await this.#call("/v1/user-feedback", command), command);
  }

  async accept(command: Readonly<Record<string, unknown>>): Promise<CandidateAcceptanceReceipt> {
    return parseAcceptanceReceipt(await this.#call("/v1/candidate-acceptance", command), command);
  }

  async cancel(command: Readonly<Record<string, unknown>>): Promise<DeliveryCancellationReceipt> {
    return parseCancellationReceipt(await this.#call("/v1/delivery-cancellations", command), command);
  }

  async #call(path: string, command: Readonly<Record<string, unknown>>): Promise<unknown> {
    const response = await this.#fetch(new URL(path, this.#endpoint), {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": command.operationKey as string,
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(130_000),
    });
    if (response.status !== 201) throw new Error(`User acceptance Broker rejected the request with status ${response.status}`);
    const envelope = object(await response.json());
    if (JSON.stringify(Object.keys(envelope)) !== JSON.stringify(["data"])) invalid();
    return envelope.data;
  }
}

export function userAcceptanceBrokerFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): UserAcceptanceBrokerClient | null {
  const endpoint = env.DEVILUDO_USER_ACCEPTANCE_BROKER_URL?.trim();
  return endpoint ? new UserAcceptanceBrokerClient(endpoint) : null;
}

export async function userFeedbackOperationKey(input: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(["deviludo-user-feedback-v1", ...Object.values(input)].join("\0")),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function candidateAcceptanceOperationKey(input: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(["deviludo-candidate-acceptance-v1", ...Object.values(input)].join("\0")),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function deliveryCancellationOperationKey(input: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(["deviludo-delivery-cancellation-v1", ...Object.values(input)].join("\0")),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function parseReceipt(value: unknown, command: Readonly<Record<string, unknown>>): UserFeedbackReceipt {
  const body = object(value);
  const snapshot = object(body.snapshot);
  const delivery = object(body.delivery);
  if (body.operationKey !== command.operationKey || body.tenantId !== command.tenantId
    || body.projectId !== command.projectId || body.actorId !== command.actorId
    || body.state !== "AWAITING_SPEC_APPROVAL"
    || typeof body.workflowId !== "string" || !body.workflowId
    || typeof body.actionId !== "string" || !UUID.test(body.actionId)
    || typeof body.previousSpecRevisionId !== "string" || !UUID.test(body.previousSpecRevisionId)
    || typeof body.evidenceInvalidationId !== "string" || !UUID.test(body.evidenceInvalidationId)
    || typeof body.signalId !== "string" || body.signalId.length < 8
    || snapshot.tenantId !== command.tenantId || snapshot.projectId !== command.projectId
    || snapshot.state !== "DRAFT" || !Number.isSafeInteger(snapshot.revision)
    || typeof snapshot.conversationId !== "string" || !UUID.test(snapshot.conversationId)
    || typeof snapshot.specRevisionId !== "string" || !UUID.test(snapshot.specRevisionId)
    || typeof snapshot.testPlanRevisionId !== "string" || !UUID.test(snapshot.testPlanRevisionId)
    || typeof snapshot.specDigest !== "string" || !SHA256.test(snapshot.specDigest)
    || typeof snapshot.testPlanDigest !== "string" || !SHA256.test(snapshot.testPlanDigest)
    || !Array.isArray(snapshot.messages)
    || delivery.actionId !== body.actionId || delivery.workflowId !== body.workflowId
    || delivery.signalId !== body.signalId || typeof delivery.outboxId !== "string"
    || !UUID.test(delivery.outboxId) || typeof delivery.signalDigest !== "string"
    || !SHA256.test(delivery.signalDigest)
    || (delivery.state !== "PENDING_DELIVERY" && delivery.state !== "DELIVERED")
    || typeof delivery.replayed !== "boolean") invalid();
  const messages: SpecDialogueMessage[] = snapshot.messages.map((item, index) => {
    const message = object(item);
    if (typeof message.id !== "string" || !UUID.test(message.id)
      || message.sequence !== index + 1
      || (message.role !== "user" && message.role !== "assistant")
      || typeof message.text !== "string" || !message.text || message.text.length > 4_000
      || typeof message.createdAt !== "string" || !Number.isFinite(Date.parse(message.createdAt))) invalid();
    return Object.freeze({
      id: message.id,
      sequence: message.sequence as number,
      role: message.role,
      text: message.text,
      createdAt: new Date(message.createdAt).toISOString(),
    });
  });
  if (messages.length !== 2 || messages[0]!.role !== "user"
    || messages[0]!.text !== command.feedback || messages[1]!.role !== "assistant") invalid();
  const result = parseSpecModelResult(snapshot.result);
  return Object.freeze({
    operationKey: body.operationKey as string,
    tenantId: body.tenantId as string,
    projectId: body.projectId as string,
    actorId: body.actorId as string,
    workflowId: body.workflowId,
    actionId: body.actionId,
    previousSpecRevisionId: body.previousSpecRevisionId,
    evidenceInvalidationId: body.evidenceInvalidationId,
    signalId: body.signalId,
    snapshot: Object.freeze({
      tenantId: snapshot.tenantId as string,
      projectId: snapshot.projectId as string,
      conversationId: snapshot.conversationId,
      revision: snapshot.revision as number,
      state: "DRAFT" as const,
      specRevisionId: snapshot.specRevisionId,
      specDigest: snapshot.specDigest,
      testPlanRevisionId: snapshot.testPlanRevisionId,
      testPlanDigest: snapshot.testPlanDigest,
      messages: Object.freeze(messages),
      result,
    }),
    state: "AWAITING_SPEC_APPROVAL" as const,
    delivery: Object.freeze({
      actionId: body.actionId,
      outboxId: delivery.outboxId,
      workflowId: body.workflowId,
      signalId: body.signalId,
      signalDigest: delivery.signalDigest,
      state: delivery.state,
      replayed: delivery.replayed,
    }),
  });
}

function parseAcceptanceReceipt(value: unknown, command: Readonly<Record<string, unknown>>): CandidateAcceptanceReceipt {
  const body = object(value);
  const delivery = object(body.delivery);
  if (body.operationKey !== command.operationKey || body.tenantId !== command.tenantId
    || body.projectId !== command.projectId || body.actorId !== command.actorId
    || body.state !== "MERGE_QUEUED" || typeof body.workflowId !== "string" || !body.workflowId
    || typeof body.actionId !== "string" || !UUID.test(body.actionId)
    || typeof body.specRevisionId !== "string" || !UUID.test(body.specRevisionId)
    || typeof body.candidateReceiptId !== "string" || !UUID.test(body.candidateReceiptId)
    || typeof body.candidateCommitSha !== "string" || !/^[a-f0-9]{40}$/.test(body.candidateCommitSha)
    || !Number.isSafeInteger(body.draftPullRequest) || (body.draftPullRequest as number) < 1
    || typeof body.evidenceBundleId !== "string" || !UUID.test(body.evidenceBundleId)
    || typeof body.signalId !== "string" || body.signalId.length < 8
    || typeof body.acceptedAt !== "string" || !Number.isFinite(Date.parse(body.acceptedAt))
    || delivery.actionId !== body.actionId || delivery.workflowId !== body.workflowId
    || delivery.signalId !== body.signalId || typeof delivery.outboxId !== "string"
    || !UUID.test(delivery.outboxId) || typeof delivery.signalDigest !== "string"
    || !SHA256.test(delivery.signalDigest)
    || (delivery.state !== "PENDING_DELIVERY" && delivery.state !== "DELIVERED")
    || typeof delivery.replayed !== "boolean") invalid();
  return Object.freeze({
    operationKey: body.operationKey as string,
    tenantId: body.tenantId as string,
    projectId: body.projectId as string,
    actorId: body.actorId as string,
    workflowId: body.workflowId,
    actionId: body.actionId,
    specRevisionId: body.specRevisionId,
    candidateReceiptId: body.candidateReceiptId,
    candidateCommitSha: body.candidateCommitSha,
    draftPullRequest: body.draftPullRequest as number,
    evidenceBundleId: body.evidenceBundleId,
    signalId: body.signalId,
    acceptedAt: new Date(body.acceptedAt).toISOString(),
    state: "MERGE_QUEUED",
    delivery: Object.freeze({
      actionId: body.actionId,
      outboxId: delivery.outboxId,
      workflowId: body.workflowId,
      signalId: body.signalId,
      signalDigest: delivery.signalDigest,
      state: delivery.state,
      replayed: delivery.replayed,
    }),
  });
}

function parseCancellationReceipt(value: unknown, command: Readonly<Record<string, unknown>>): DeliveryCancellationReceipt {
  const body = object(value);
  if (body.operationKey !== command.operationKey || body.tenantId !== command.tenantId
    || body.projectId !== command.projectId || body.actorId !== command.actorId
    || body.reason !== command.reason || body.state !== "CANCEL_REQUESTED"
    || typeof body.workflowId !== "string" || !/^delivery-[a-f0-9-]{36}$/.test(body.workflowId)
    || !Number.isSafeInteger(body.projectionSequence) || (body.projectionSequence as number) < 0
    || (body.projectionSequence as number) > 100_000
    || typeof body.projectionKey !== "string" || body.projectionKey.length < 32 || body.projectionKey.length > 512
    || typeof body.projectionState !== "string" || !CANCELLABLE_STATES.has(body.projectionState)
    || typeof body.projectionDigest !== "string" || !SHA256.test(body.projectionDigest)
    || typeof body.signalId !== "string" || !/^cancel-[a-f0-9-]{36}$/.test(body.signalId)
    || typeof body.requestedAt !== "string" || !Number.isFinite(Date.parse(body.requestedAt))
    || typeof body.deliveredAt !== "string" || !Number.isFinite(Date.parse(body.deliveredAt))) invalid();
  return Object.freeze({
    operationKey: body.operationKey as string,
    tenantId: body.tenantId as string,
    projectId: body.projectId as string,
    actorId: body.actorId as string,
    reason: body.reason as string,
    workflowId: body.workflowId,
    projectionSequence: body.projectionSequence as number,
    projectionKey: body.projectionKey,
    projectionState: body.projectionState,
    projectionDigest: body.projectionDigest,
    signalId: body.signalId,
    requestedAt: new Date(body.requestedAt).toISOString(),
    state: "CANCEL_REQUESTED",
    deliveredAt: new Date(body.deliveredAt).toISOString(),
  } as DeliveryCancellationReceipt);
}

const CANCELLABLE_STATES = new Set([
  "IDEATION", "WAITING_SPEC_APPROVAL", "RESOLVING_AGENT_CONFIGURATION",
  "DEVELOPMENT_QUEUED", "DEVELOPING", "WAITING_PROVIDER",
  "CROSS_PLATFORM_E2E", "WAITING_USER_ACCEPTANCE", "MERGING",
  "MAIN_SHA_E2E", "WAITING_MFA", "STEAM_PRIVATE_BETA",
  "STEAM_INSTALL_E2E", "EXTERNAL_APPROVAL_REQUIRED",
]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function invalid(): never { throw new Error("User acceptance Broker response binding is invalid"); }
