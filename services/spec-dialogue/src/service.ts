import { parseSpecApprovalCommand, parseSpecDialogueCommand, parseSpecDialogueLookup, type SpecApprovalReceipt, type SpecDialogueSnapshot } from "./contracts";
import type { SpecDialogueModel } from "./model";
import type { SpecDialogueStore } from "./store";
import type { SpecWorkflowApprovalSink } from "./workflow-bridge";

export class SpecDialogueConflict extends Error {
  constructor(readonly code: "SPEC_DIALOGUE_BUSY" | "SPEC_DIALOGUE_REVISION_CONFLICT") {
    super("Specification dialogue command could not be accepted");
  }
}

export class SpecDialogueService {
  constructor(
    private readonly store: SpecDialogueStore,
    private readonly model: SpecDialogueModel,
    private readonly workflow: SpecWorkflowApprovalSink | null = null,
  ) {}

  async send(value: unknown): Promise<SpecDialogueSnapshot> {
    const command = parseSpecDialogueCommand(value);
    const outcome = await this.store.begin(command);
    if (outcome.kind === "REPLAY") return outcome.snapshot;
    if (outcome.kind === "BUSY") throw new SpecDialogueConflict("SPEC_DIALOGUE_BUSY");
    if (outcome.kind === "CONFLICT") throw new SpecDialogueConflict("SPEC_DIALOGUE_REVISION_CONFLICT");
    try {
      const result = await this.model.generate({
        operationKey: command.operationKey,
        tenantId: command.tenantId,
        projectId: command.projectId,
        conversationId: command.conversationId,
        history: outcome.claim.history,
        current: outcome.claim.current,
        userMessage: command.message,
      });
      return await this.store.complete(outcome.claim, result);
    } catch (error) {
      await this.store.release(outcome.claim).catch(() => undefined);
      throw error;
    }
  }

  snapshot(value: unknown): Promise<SpecDialogueSnapshot | null> {
    return this.store.read(parseSpecDialogueLookup(value));
  }

  async approve(value: unknown): Promise<SpecApprovalReceipt> {
    const command = parseSpecApprovalCommand(value);
    const receipt = await this.store.approve(command);
    if (this.workflow) await this.workflow.publish(command, receipt);
    return receipt;
  }

  async probe(): Promise<void> {
    await Promise.all([
      this.store.probe(),
      this.model.probe(),
      ...(this.workflow ? [this.workflow.probe()] : []),
    ]);
  }
}
