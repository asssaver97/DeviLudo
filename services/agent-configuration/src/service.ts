import type { WorkflowActionCompletionPort } from "../../control-plane/src/workflow-action-completion-postgres";
import { sourceBaselineOperationKey } from "../../scm-proxy/src/source-baseline-contracts";
import { agentConfigurationSignalId } from "./postgres-store";
import type {
  AgentConfigurationClaim,
  AgentConfigurationStore,
  AgentConfigurationWork,
  LockedAgentConfiguration,
  SourceBaselinePort,
} from "./contracts";

export class AgentConfigurationService {
  constructor(
    private readonly store: AgentConfigurationStore,
    private readonly baselines: SourceBaselinePort,
    private readonly completions: WorkflowActionCompletionPort,
  ) {}

  async processTenantOnce(tenantId: string): Promise<"IDLE" | "COMPLETED"> {
    let work: AgentConfigurationWork | null = await this.store.claimNext(tenantId);
    if (!work) return "IDLE";
    try {
      if (work.kind === "CLAIMED") work = await this.#lock(work);
      const locked = work as LockedAgentConfiguration;
      const completion = await this.completions.complete({
        tenantId: locked.tenantId,
        projectId: locked.projectId,
        workflowId: locked.workflowId,
        actionId: locked.actionId,
        source: "AGENT_CONFIGURATION_SERVICE",
        sourceReceiptId: locked.resolutionDigest,
        signal: Object.freeze({
          signalId: agentConfigurationSignalId(locked.resolutionDigest),
          type: "RUN_CONFIGURATION_LOCKED" as const,
          lockedRunConfigurationId: locked.runId,
        }),
      });
      await this.store.complete(locked, completion.outboxId);
      return "COMPLETED";
    } catch (error) {
      if (work.kind === "CLAIMED") await this.store.release(work).catch(() => undefined);
      throw error;
    }
  }

  async probe(): Promise<void> { await Promise.all([this.store.probe(), this.baselines.probe()]); }

  async #lock(claim: AgentConfigurationClaim): Promise<LockedAgentConfiguration> {
    if (claim.repairContext) return this.store.lock(claim, null);
    const baseline = await this.baselines.resolve(Object.freeze({
      schemaVersion: "deviludo.source-baseline.v1",
      operationKey: sourceBaselineOperationKey(claim.actionId),
      tenantId: claim.tenantId,
      projectId: claim.projectId,
      workflowId: claim.workflowId,
      specRevisionId: claim.specRevisionId,
      testPlanRevisionId: claim.testPlanRevisionId,
      specApprovalReceiptId: claim.specApprovalReceiptId,
    }));
    return this.store.lock(claim, baseline);
  }
}
