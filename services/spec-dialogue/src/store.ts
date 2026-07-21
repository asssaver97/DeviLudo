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

/** Loopback/test store. Production uses the PostgreSQL implementation. */
export class InMemorySpecDialogueStore extends SpecDialogueStore {
  readonly #conversations = new Map<string, Conversation>();
  readonly #operations = new Map<string, Operation>();
  readonly #approvals = new Map<string, { readonly digest: string; readonly receipt: SpecApprovalReceipt }>();

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
