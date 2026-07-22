import type { WorkflowActionCompletionPort } from "../../control-plane/src/workflow-action-completion-postgres";
import type { SpecDialogueModel } from "../../spec-dialogue/src/model";
import {
  parseUserFeedbackCommand,
  type UserFeedbackReceipt,
  type UserFeedbackStore,
} from "./contracts";

export class UserFeedbackConflict extends Error {
  constructor(readonly code: "USER_FEEDBACK_BUSY" | "USER_FEEDBACK_CONFLICT") {
    super("User feedback could not be accepted");
  }
}

export class UserAcceptanceService {
  constructor(
    private readonly store: UserFeedbackStore,
    private readonly model: SpecDialogueModel,
    private readonly completions: WorkflowActionCompletionPort,
  ) {}

  async submit(value: unknown): Promise<UserFeedbackReceipt> {
    const command = parseUserFeedbackCommand(value);
    const outcome = await this.store.begin(command);
    if (outcome.kind === "COMPLETED") return outcome.receipt;
    if (outcome.kind === "BUSY") throw new UserFeedbackConflict("USER_FEEDBACK_BUSY");
    if (outcome.kind === "CONFLICT") throw new UserFeedbackConflict("USER_FEEDBACK_CONFLICT");

    let draft;
    if (outcome.kind === "DRAFT_READY") {
      draft = outcome.draft;
    } else {
      const { claim } = outcome;
      try {
        const generated = await this.model.generate({
          operationKey: command.operationKey,
          tenantId: command.tenantId,
          projectId: command.projectId,
          conversationId: claim.previousConversationId,
          history: claim.history,
          current: claim.current,
          userMessage: command.feedback,
        });
        draft = await this.store.createDraft(claim, generated);
      } catch (error) {
        await this.store.release(claim).catch(() => undefined);
        throw error;
      }
    }

    const delivery = await this.completions.complete({
      tenantId: draft.tenantId,
      projectId: draft.projectId,
      workflowId: draft.workflowId,
      actionId: draft.actionId,
      source: "USER_ACCEPTANCE_SERVICE",
      sourceReceiptId: draft.operationKey,
      signal: Object.freeze({
        signalId: draft.signalId,
        type: "USER_FEEDBACK" as const,
        nextSpecRevisionId: draft.snapshot.specRevisionId!,
        evidenceInvalidationId: draft.evidenceInvalidationId,
      }),
    });
    return this.store.complete(draft, delivery);
  }

  async probe(): Promise<void> { await Promise.all([this.store.probe(), this.model.probe()]); }
}
