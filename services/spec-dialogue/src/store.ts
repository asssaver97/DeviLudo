import { createHash, randomUUID } from "node:crypto";
import { parseSpecModelResult, type SpecApprovalCommand, type SpecApprovalReceipt, type SpecDialogueCommand, type SpecDialogueMessage, type SpecDialogueSnapshot, type SpecModelResult } from "./contracts";

export interface SpecDialogueClaim {
  readonly claimToken: string;
  readonly command: SpecDialogueCommand;
  readonly history: readonly SpecDialogueMessage[];
  readonly current: SpecModelResult | null;
}

export type SpecDialogueClaimResult =
  | { readonly kind: "ACQUIRED"; readonly claim: SpecDialogueClaim }
  | { readonly kind: "REPLAY"; readonly snapshot: SpecDialogueSnapshot }
  | { readonly kind: "BUSY" }
  | { readonly kind: "CONFLICT" };

export class SpecDialogueToolchainUnavailable extends Error {
  readonly code = "RUNNER_TOOLCHAIN_UNAVAILABLE";

  constructor() {
    super("No compatible immutable Runner toolchain is available for this specification");
  }
}

export abstract class SpecDialogueStore {
  abstract begin(command: SpecDialogueCommand): Promise<SpecDialogueClaimResult>;
  abstract complete(claim: SpecDialogueClaim, result: SpecModelResult): Promise<SpecDialogueSnapshot>;
  abstract release(claim: SpecDialogueClaim): Promise<void>;
  abstract approve(command: SpecApprovalCommand): Promise<SpecApprovalReceipt>;
  abstract read(input: { readonly tenantId: string; readonly projectId: string; readonly conversationId: string }): Promise<SpecDialogueSnapshot | null>;
  abstract probe(): Promise<void>;
}

type Conversation = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly conversationId: string;
  revision: number;
  messages: SpecDialogueMessage[];
  result: SpecModelResult | null;
  specRevisionId: string | null;
  specDigest: string | null;
  testPlanRevisionId: string | null;
  testPlanDigest: string | null;
  state: "DRAFT" | "APPROVED";
};

type Operation = {
  readonly requestDigest: string;
  state: "CLAIMED" | "COMPLETED";
  claimToken: string | null;
  snapshot: SpecDialogueSnapshot | null;
};

export interface InMemorySpecDialogueState {
  readonly schemaVersion: "deviludo.in-memory-spec-dialogue.v1";
  readonly conversations: readonly SpecDialogueSnapshot[];
  readonly operations: readonly Readonly<{
    operationKey: string;
    requestDigest: string;
    snapshot: SpecDialogueSnapshot;
  }>[];
  readonly approvals: readonly Readonly<{
    operationKey: string;
    digest: string;
    receipt: SpecApprovalReceipt;
  }>[];
}

/** Loopback/test store. Production uses the PostgreSQL implementation. */
export class InMemorySpecDialogueStore extends SpecDialogueStore {
  readonly #conversations = new Map<string, Conversation>();
  readonly #operations = new Map<string, Operation>();
  readonly #approvals = new Map<string, { readonly digest: string; readonly receipt: SpecApprovalReceipt }>();

  constructor(initialState?: unknown) {
    super();
    if (initialState === undefined) return;
    const state = parseInMemorySpecDialogueState(initialState);
    for (const snapshot of state.conversations) {
      this.#conversations.set(conversationKey(snapshot), conversationOf(snapshot));
    }
    for (const operation of state.operations) {
      this.#operations.set(operation.operationKey, {
        requestDigest: operation.requestDigest,
        state: "COMPLETED",
        claimToken: null,
        snapshot: cloneSnapshot(operation.snapshot),
      });
    }
    for (const approval of state.approvals) {
      this.#approvals.set(approval.operationKey, {
        digest: approval.digest,
        receipt: structuredClone(approval.receipt),
      });
    }
  }

  /** Durable loopback/test snapshot. In-flight claims are intentionally omitted. */
  exportState(): InMemorySpecDialogueState {
    return Object.freeze({
      schemaVersion: "deviludo.in-memory-spec-dialogue.v1",
      conversations: Object.freeze([...this.#conversations.values()].map((conversation) => cloneSnapshot(snapshotOf(conversation)))),
      operations: Object.freeze([...this.#operations.entries()]
        .filter(([, operation]) => operation.state === "COMPLETED" && operation.snapshot !== null)
        .map(([operationKey, operation]) => Object.freeze({
          operationKey,
          requestDigest: operation.requestDigest,
          snapshot: cloneSnapshot(operation.snapshot!),
        }))),
      approvals: Object.freeze([...this.#approvals.entries()].map(([operationKey, approval]) => Object.freeze({
        operationKey,
        digest: approval.digest,
        receipt: structuredClone(approval.receipt),
      }))),
    });
  }

  /**
   * Local/test-only immutable successor creation. Production feedback uses the
   * user-acceptance PostgreSQL transaction, which creates a distinct
   * conversation and preserves the approved ancestor in the same way.
   */
  async forkApproved(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly conversationId: string;
    readonly nextConversationId: string;
  }): Promise<SpecDialogueSnapshot> {
    if (input.conversationId === input.nextConversationId) {
      throw new Error("Specification feedback successor must use a new conversation");
    }
    const nextKey = conversationKey({
      tenantId: input.tenantId,
      projectId: input.projectId,
      conversationId: input.nextConversationId,
    });
    const existing = this.#conversations.get(nextKey);
    if (existing) return cloneSnapshot(snapshotOf(existing));
    const source = this.#conversations.get(conversationKey(input));
    if (!source || source.state !== "APPROVED" || !source.result
      || !source.specRevisionId || !source.testPlanRevisionId) {
      throw new Error("Specification feedback ancestor is not an approved revision");
    }
    const successor: Conversation = {
      tenantId: source.tenantId,
      projectId: source.projectId,
      conversationId: input.nextConversationId,
      revision: source.revision,
      messages: source.messages.map((message) => Object.freeze({ ...message })),
      result: parseSpecModelResult(source.result),
      specRevisionId: null,
      specDigest: null,
      testPlanRevisionId: null,
      testPlanDigest: null,
      state: "DRAFT",
    };
    this.#conversations.set(nextKey, successor);
    return cloneSnapshot(snapshotOf(successor));
  }

  async begin(command: SpecDialogueCommand): Promise<SpecDialogueClaimResult> {
    const requestDigest = digest({
      tenantId: command.tenantId,
      projectId: command.projectId,
      conversationId: command.conversationId,
      actorId: command.actorId,
      expectedRevision: command.expectedRevision,
      message: command.message,
    });
    const existing = this.#operations.get(command.operationKey);
    if (existing?.requestDigest !== undefined && existing.requestDigest !== requestDigest) return Object.freeze({ kind: "CONFLICT" });
    if (existing?.state === "COMPLETED" && existing.snapshot) {
      return Object.freeze({ kind: "REPLAY", snapshot: cloneSnapshot(existing.snapshot) });
    }
    if (existing?.state === "CLAIMED") return Object.freeze({ kind: "BUSY" });

    const key = conversationKey(command);
    let conversation = this.#conversations.get(key);
    if (!conversation) {
      // Local pages can begin from an already rendered historical revision.
      // The PostgreSQL store permits creation only at expectedRevision=0.
      conversation = {
        tenantId: command.tenantId,
        projectId: command.projectId,
        conversationId: command.conversationId,
        revision: command.expectedRevision,
        messages: [],
        result: null,
        specRevisionId: null,
        specDigest: null,
        testPlanRevisionId: null,
        testPlanDigest: null,
        state: "DRAFT",
      };
      this.#conversations.set(key, conversation);
    }
    if (conversation.revision !== command.expectedRevision || conversation.state !== "DRAFT") return Object.freeze({ kind: "CONFLICT" });
    const claimToken = randomUUID();
    this.#operations.set(command.operationKey, { requestDigest, state: "CLAIMED", claimToken, snapshot: null });
    return Object.freeze({
      kind: "ACQUIRED",
      claim: Object.freeze({
        claimToken,
        command,
        history: Object.freeze(conversation.messages.map((message) => Object.freeze({ ...message }))),
        current: conversation.result ? parseSpecModelResult(conversation.result) : null,
      }),
    });
  }

  async complete(claim: SpecDialogueClaim, generated: SpecModelResult): Promise<SpecDialogueSnapshot> {
    const operation = this.#operations.get(claim.command.operationKey);
    if (operation?.state === "COMPLETED" && operation.snapshot) return cloneSnapshot(operation.snapshot);
    if (!operation || operation.state !== "CLAIMED" || operation.claimToken !== claim.claimToken) throw new Error("Specification dialogue claim was lost");
    const conversation = this.#conversations.get(conversationKey(claim.command));
    if (!conversation || conversation.state !== "DRAFT" || conversation.revision !== claim.command.expectedRevision) throw new Error("Specification dialogue revision changed concurrently");
    const result = parseSpecModelResult(generated);
    const now = new Date().toISOString();
    const next = conversation.revision + 1;
    conversation.messages.push(
      Object.freeze({ id: randomUUID(), sequence: conversation.messages.length + 1, role: "user", text: claim.command.message, createdAt: now }),
      Object.freeze({ id: randomUUID(), sequence: conversation.messages.length + 2, role: "assistant", text: result.assistantMessage, createdAt: now }),
    );
    conversation.revision = next;
    conversation.result = result;
    conversation.specRevisionId = randomUUID();
    conversation.specDigest = digest(result.spec);
    conversation.testPlanRevisionId = randomUUID();
    conversation.testPlanDigest = digest(result.testPlan);
    const snapshot = snapshotOf(conversation);
    Object.assign(operation, { state: "COMPLETED", claimToken: null, snapshot });
    return cloneSnapshot(snapshot);
  }

  async release(claim: SpecDialogueClaim): Promise<void> {
    const operation = this.#operations.get(claim.command.operationKey);
    if (operation?.state === "CLAIMED" && operation.claimToken === claim.claimToken) {
      this.#operations.delete(claim.command.operationKey);
    }
  }

  async approve(command: SpecApprovalCommand): Promise<SpecApprovalReceipt> {
    const requestDigest = digest(command);
    const existing = this.#approvals.get(command.operationKey);
    if (existing) {
      if (existing.digest !== requestDigest) throw new Error("Specification approval idempotency conflict");
      return structuredClone(existing.receipt);
    }
    const conversation = this.#conversations.get(conversationKey(command));
    if (!conversation || conversation.state !== "DRAFT" || conversation.revision !== command.expectedRevision
      || conversation.specRevisionId !== command.specRevisionId || conversation.testPlanRevisionId !== command.testPlanRevisionId
      || !conversation.result) throw new Error("Specification approval binding is invalid");
    const revision = conversation.revision + 1;
    conversation.revision = revision;
    conversation.state = "APPROVED";
    conversation.specRevisionId = randomUUID();
    conversation.specDigest = digest({ schemaVersion: "deviludo.game-spec.v1", conversationId: command.conversationId, revision, spec: conversation.result.spec });
    conversation.testPlanRevisionId = randomUUID();
    conversation.testPlanDigest = digest({ schemaVersion: "deviludo.test-plan.v1", conversationId: command.conversationId, revision, testPlan: conversation.result.testPlan });
    const receipt: SpecApprovalReceipt = Object.freeze({
      operationKey: command.operationKey, tenantId: command.tenantId, projectId: command.projectId,
      conversationId: command.conversationId, revision, state: "APPROVED",
      specRevisionId: conversation.specRevisionId, specDigest: conversation.specDigest,
      testPlanRevisionId: conversation.testPlanRevisionId, testPlanDigest: conversation.testPlanDigest,
      targetMatrix: Object.freeze([...conversation.result.spec.targetPlatforms]),
      godotVersion: conversation.result.spec.godotVersion,
      approvedAt: new Date().toISOString(),
    });
    this.#approvals.set(command.operationKey, { digest: requestDigest, receipt });
    return structuredClone(receipt);
  }

  async read(input: { readonly tenantId: string; readonly projectId: string; readonly conversationId: string }): Promise<SpecDialogueSnapshot | null> {
    const conversation = this.#conversations.get(conversationKey(input));
    return conversation ? cloneSnapshot(snapshotOf(conversation)) : null;
  }

  async probe(): Promise<void> { /* in-process store is ready */ }
}

function snapshotOf(conversation: Conversation): SpecDialogueSnapshot {
  return Object.freeze({
    tenantId: conversation.tenantId,
    projectId: conversation.projectId,
    conversationId: conversation.conversationId,
    revision: conversation.revision,
    state: conversation.state,
    specRevisionId: conversation.specRevisionId,
    specDigest: conversation.specDigest,
    testPlanRevisionId: conversation.testPlanRevisionId,
    testPlanDigest: conversation.testPlanDigest,
    messages: Object.freeze(conversation.messages.map((message) => Object.freeze({ ...message }))),
    result: conversation.result ? parseSpecModelResult(conversation.result) : null,
  });
}

function cloneSnapshot(snapshot: SpecDialogueSnapshot): SpecDialogueSnapshot {
  return structuredClone(snapshot) as SpecDialogueSnapshot;
}

function conversationOf(snapshot: SpecDialogueSnapshot): Conversation {
  return {
    tenantId: snapshot.tenantId,
    projectId: snapshot.projectId,
    conversationId: snapshot.conversationId,
    revision: snapshot.revision,
    messages: snapshot.messages.map((message) => Object.freeze({ ...message })),
    result: snapshot.result ? parseSpecModelResult(snapshot.result) : null,
    specRevisionId: snapshot.specRevisionId,
    specDigest: snapshot.specDigest,
    testPlanRevisionId: snapshot.testPlanRevisionId,
    testPlanDigest: snapshot.testPlanDigest,
    state: snapshot.state,
  };
}

export function parseInMemorySpecDialogueState(value: unknown): InMemorySpecDialogueState {
  const body = exactStateObject(value, ["approvals", "conversations", "operations", "schemaVersion"]);
  if (body.schemaVersion !== "deviludo.in-memory-spec-dialogue.v1") invalidState();
  const conversations = stateArray(body.conversations, 0, 10_000).map(parseSnapshot);
  const conversationKeys = new Set<string>();
  const current = new Map<string, SpecDialogueSnapshot>();
  for (const snapshot of conversations) {
    const key = conversationKey(snapshot);
    if (conversationKeys.has(key)) invalidState();
    conversationKeys.add(key);
    current.set(key, snapshot);
  }
  const operationKeys = new Set<string>();
  const operations = stateArray(body.operations, 0, 50_000).map((value) => {
    const operation = exactStateObject(value, ["operationKey", "requestDigest", "snapshot"]);
    const operationKey = stateSha(operation.operationKey);
    if (operationKeys.has(operationKey)) invalidState();
    operationKeys.add(operationKey);
    const snapshot = parseSnapshot(operation.snapshot);
    const active = current.get(conversationKey(snapshot));
    if (!active || snapshot.revision > active.revision) invalidState();
    return Object.freeze({ operationKey, requestDigest: stateSha(operation.requestDigest), snapshot });
  });
  const approvalKeys = new Set<string>();
  const approvals = stateArray(body.approvals, 0, 10_000).map((value) => {
    const approval = exactStateObject(value, ["digest", "operationKey", "receipt"]);
    const operationKey = stateSha(approval.operationKey);
    if (approvalKeys.has(operationKey)) invalidState();
    approvalKeys.add(operationKey);
    const receipt = parseApprovalReceipt(approval.receipt);
    if (receipt.operationKey !== operationKey) invalidState();
    const active = current.get(conversationKey(receipt));
    if (!active || active.state !== "APPROVED" || active.revision !== receipt.revision
      || active.specRevisionId !== receipt.specRevisionId || active.specDigest !== receipt.specDigest
      || active.testPlanRevisionId !== receipt.testPlanRevisionId || active.testPlanDigest !== receipt.testPlanDigest) invalidState();
    return Object.freeze({ operationKey, digest: stateSha(approval.digest), receipt });
  });
  return Object.freeze({
    schemaVersion: "deviludo.in-memory-spec-dialogue.v1",
    conversations: Object.freeze(conversations),
    operations: Object.freeze(operations),
    approvals: Object.freeze(approvals),
  });
}

function parseSnapshot(value: unknown): SpecDialogueSnapshot {
  const body = exactStateObject(value, [
    "conversationId", "messages", "projectId", "result", "revision", "specDigest",
    "specRevisionId", "state", "tenantId", "testPlanDigest", "testPlanRevisionId",
  ]);
  const revision = stateInteger(body.revision, 0, 1_000_000);
  if (body.state !== "DRAFT" && body.state !== "APPROVED") invalidState();
  const messages = stateArray(body.messages, 0, 20_000).map((value, index) => {
    const message = exactStateObject(value, ["createdAt", "id", "role", "sequence", "text"]);
    if (message.role !== "user" && message.role !== "assistant") invalidState();
    const sequence = stateInteger(message.sequence, 1, 20_000);
    if (sequence !== index + 1) invalidState();
    return Object.freeze({
      id: stateId(message.id), sequence, role: message.role,
      text: stateText(message.text, 4_000), createdAt: stateTimestamp(message.createdAt),
    });
  });
  const result = body.result === null ? null : parseSpecModelResult(body.result);
  const specRevisionId = nullableStateId(body.specRevisionId);
  const specDigest = nullableStateSha(body.specDigest);
  const testPlanRevisionId = nullableStateId(body.testPlanRevisionId);
  const testPlanDigest = nullableStateSha(body.testPlanDigest);
  if ((result === null) !== (messages.length === 0)) invalidState();
  if (body.state === "APPROVED" && (!result || !specRevisionId || !specDigest || !testPlanRevisionId || !testPlanDigest)) invalidState();
  const hasAnyBinding = [specRevisionId, specDigest, testPlanRevisionId, testPlanDigest].some((item) => item !== null);
  const hasEveryBinding = [specRevisionId, specDigest, testPlanRevisionId, testPlanDigest].every((item) => item !== null);
  if (hasAnyBinding && !hasEveryBinding) invalidState();
  return Object.freeze({
    tenantId: stateId(body.tenantId), projectId: stateId(body.projectId), conversationId: stateId(body.conversationId),
    revision, state: body.state, specRevisionId, specDigest, testPlanRevisionId, testPlanDigest,
    messages: Object.freeze(messages), result,
  });
}

function parseApprovalReceipt(value: unknown): SpecApprovalReceipt {
  const body = exactStateObject(value, [
    "approvedAt", "conversationId", "godotVersion", "operationKey", "projectId", "revision",
    "specDigest", "specRevisionId", "state", "targetMatrix", "tenantId", "testPlanDigest", "testPlanRevisionId",
  ]);
  if (body.state !== "APPROVED") invalidState();
  const targetMatrix = stateArray(body.targetMatrix, 1, 3).map((platform) => {
    if (platform !== "windows" && platform !== "linux" && platform !== "macos") invalidState();
    return platform;
  });
  if (new Set(targetMatrix).size !== targetMatrix.length) invalidState();
  const godotVersion = stateText(body.godotVersion, 80);
  if (!/^4\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9]+)*$/.test(godotVersion)) invalidState();
  return Object.freeze({
    operationKey: stateSha(body.operationKey), tenantId: stateId(body.tenantId), projectId: stateId(body.projectId),
    conversationId: stateId(body.conversationId), revision: stateInteger(body.revision, 1, 1_000_000), state: "APPROVED",
    specRevisionId: stateId(body.specRevisionId), specDigest: stateSha(body.specDigest),
    testPlanRevisionId: stateId(body.testPlanRevisionId), testPlanDigest: stateSha(body.testPlanDigest),
    targetMatrix: Object.freeze(targetMatrix), godotVersion, approvedAt: stateTimestamp(body.approvedAt),
  });
}

function exactStateObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidState();
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalidState();
  return body;
}

function stateArray(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalidState();
  return value;
}

function stateInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalidState();
  return value as number;
}

function stateId(value: unknown): string {
  const result = stateText(value, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(result)) invalidState();
  return result;
}

function stateText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) invalidState();
  return value;
}

function stateSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalidState();
  return value;
}

function nullableStateId(value: unknown): string | null { return value === null ? null : stateId(value); }
function nullableStateSha(value: unknown): string | null { return value === null ? null : stateSha(value); }
function stateTimestamp(value: unknown): string {
  const result = stateText(value, 40);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== result) invalidState();
  return result;
}
function invalidState(): never { throw new Error("In-memory specification state is invalid"); }

function conversationKey(input: { tenantId: string; projectId: string; conversationId: string }): string {
  return `${input.tenantId}\0${input.projectId}\0${input.conversationId}`;
}

export function canonicalSpecJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalSpecJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalSpecJson(child)}`)
    .join(",")}}`;
}

export function specDigest(value: unknown): string { return digest(value); }
function digest(value: unknown): string { return createHash("sha256").update(canonicalSpecJson(value)).digest("hex"); }
