import { parseSpecApprovalCommand, parseSpecDialogueCommand, parseSpecDialogueLookup, type SpecApprovalReceipt, type SpecDialogueSnapshot } from "./contracts";
import type { SpecDialogueModel } from "./model";
import type { SpecDialogueStore } from "./store";

export class SpecDialogueConflict extends Error {
  constructor(readonly code: "SPEC_DIALOGUE_BUSY" | "SPEC_DIALOGUE_REVISION_CONFLICT") {
    super("Specification dialogue command could not be accepted");
  }
}

export class SpecDialogueService {
  constructor(private readonly store: SpecDialogueStore, private readonly model: SpecDialogueModel) {}

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

  approve(value: unknown): Promise<SpecApprovalReceipt> { return this.store.approve(parseSpecApprovalCommand(value)); }

  probe(): Promise<void> { return this.store.probe(); }
}
