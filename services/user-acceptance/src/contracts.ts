import type { WorkflowActionCompletionReceipt } from "../../control-plane/src/workflow-action-completion-postgres";
import type { SpecDialogueMessage, SpecDialogueSnapshot, SpecModelResult } from "../../spec-dialogue/src/contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export interface UserFeedbackCommand {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly feedback: string;
}

export interface UserFeedbackClaim {
  readonly command: UserFeedbackCommand;
  readonly claimToken: string;
  readonly workflowId: string;
  readonly actionId: string;
  readonly previousConversationId: string;
  readonly previousSpecRevisionId: string;
  readonly previousTestPlanRevisionId: string;
  readonly specAggregateId: string;
  readonly testPlanAggregateId: string;
  readonly previousRevision: number;
  readonly history: readonly SpecDialogueMessage[];
  readonly current: SpecModelResult;
  readonly evidenceInvalidationId: string;
  readonly signalId: string;
}

export interface UserFeedbackDraft {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly workflowId: string;
  readonly actionId: string;
  readonly previousSpecRevisionId: string;
  readonly evidenceInvalidationId: string;
  readonly signalId: string;
  readonly snapshot: SpecDialogueSnapshot;
}

export interface UserFeedbackReceipt extends UserFeedbackDraft {
  readonly state: "AWAITING_SPEC_APPROVAL";
  readonly delivery: WorkflowActionCompletionReceipt;
}

export type UserFeedbackBeginResult =
  | { readonly kind: "ACQUIRED"; readonly claim: UserFeedbackClaim }
  | { readonly kind: "DRAFT_READY"; readonly draft: UserFeedbackDraft }
  | { readonly kind: "COMPLETED"; readonly receipt: UserFeedbackReceipt }
  | { readonly kind: "BUSY" }
  | { readonly kind: "CONFLICT" };

export interface UserFeedbackStore {
  begin(command: UserFeedbackCommand): Promise<UserFeedbackBeginResult>;
  createDraft(claim: UserFeedbackClaim, result: SpecModelResult): Promise<UserFeedbackDraft>;
  release(claim: UserFeedbackClaim): Promise<void>;
  complete(draft: UserFeedbackDraft, delivery: WorkflowActionCompletionReceipt): Promise<UserFeedbackReceipt>;
  probe(): Promise<void>;
}

export function parseUserFeedbackCommand(value: unknown): UserFeedbackCommand {
  const body = exactObject(value, ["actorId", "feedback", "operationKey", "projectId", "tenantId"]);
  const operationKey = text(body.operationKey, 64, false);
  const tenantId = text(body.tenantId, 200, false);
  const projectId = text(body.projectId, 200, false);
  const actorId = text(body.actorId, 200, false);
  const feedback = text(body.feedback, 4_000, true);
  if (!SHA256.test(operationKey) || !SAFE_ID.test(tenantId) || !SAFE_ID.test(projectId) || !SAFE_ID.test(actorId)) invalid();
  return Object.freeze({ operationKey, tenantId, projectId, actorId, feedback });
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalid();
  return body;
}

function text(value: unknown, maximum: number, trim: boolean): string {
  if (typeof value !== "string") invalid();
  const result = trim ? value.trim() : value;
  if (!result || result.length > maximum || /\u0000/.test(result)) invalid();
  return result;
}

function invalid(): never { throw new UserFeedbackRequestError(); }

export class UserFeedbackRequestError extends Error {
  readonly code = "INVALID_USER_FEEDBACK_REQUEST";
  constructor() { super("User feedback request is invalid"); }
}
