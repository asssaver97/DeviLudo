import type { Client } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { WorkflowActionCompletionPort } from "../../control-plane/src/workflow-action-completion-postgres";
import { queryGameDelivery, startGameDelivery } from "../../temporal/src/client";
import type { SpecWorkflowEvent } from "./contracts";
import type { PostgresSpecWorkflowBridgeStore, SpecDeliveryWorkflow } from "./postgres-store";

export interface SpecWorkflowTemporalPort {
  probe(): Promise<void>;
  ensureStarted(workflow: SpecDeliveryWorkflow): Promise<{ readonly temporalRunId: string }>;
}

export class TemporalSpecWorkflowPort implements SpecWorkflowTemporalPort {
  constructor(private readonly client: Client) {}

  async probe(): Promise<void> {
    const namespace = this.client.options.namespace;
    const [, described] = await Promise.all([
      this.client.workflowService.getSystemInfo({}),
      this.client.workflowService.describeNamespace({ namespace }),
    ]);
    if (described.namespaceInfo?.name !== namespace) {
      throw new Error("Specification workflow Temporal namespace identity is invalid");
    }
  }

  async ensureStarted(workflow: SpecDeliveryWorkflow): Promise<{ readonly temporalRunId: string }> {
    try {
      const handle = await startGameDelivery(this.client, {
        workflowId: workflow.workflowId,
        tenantId: workflow.tenantId,
        projectId: workflow.projectId,
        targetMatrix: workflow.targetMatrix,
      });
      return Object.freeze({ temporalRunId: handle.firstExecutionRunId });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      const [snapshot, description] = await Promise.all([
        queryGameDelivery(this.client, workflow.workflowId),
        this.client.workflow.getHandle(workflow.workflowId).describe(),
      ]);
      if (snapshot.tenantId !== workflow.tenantId || snapshot.projectId !== workflow.projectId
        || JSON.stringify(snapshot.targetMatrix) !== JSON.stringify(workflow.targetMatrix)
        || description.workflowId !== workflow.workflowId || !description.runId) {
        throw new Error("Existing Temporal delivery workflow binding is invalid");
      }
      return Object.freeze({ temporalRunId: description.runId });
    }
  }
}

export class SpecWorkflowBridgeService {
  constructor(
    private readonly store: PostgresSpecWorkflowBridgeStore,
    private readonly temporal: SpecWorkflowTemporalPort,
    private readonly completions: WorkflowActionCompletionPort,
  ) {}

  enqueue(value: unknown) { return this.store.enqueue(value); }

  async processTenantOnce(tenantId: string): Promise<"IDLE" | "WAITING_ACTION" | "COMPLETED"> {
    const event = await this.store.claimNext(tenantId);
    if (!event) return "IDLE";
    try {
      let workflow = await this.store.workflow(event.tenantId, event.projectId);
      if (workflow.state === "PENDING_START") {
        const started = await this.temporal.ensureStarted(workflow);
        workflow = await this.store.markStarted({
          tenantId: workflow.tenantId,
          projectId: workflow.projectId,
          workflowId: workflow.workflowId,
          temporalRunId: started.temporalRunId,
        });
      }
      if (workflow.state !== "ACTIVE" || workflow.workflowId !== event.workflowId) invalid();
      const actionId = await this.store.findWaitingAction(event);
      if (!actionId) {
        await this.store.release(event);
        return "WAITING_ACTION";
      }
      const completion = await this.completions.complete({
        tenantId: event.tenantId,
        projectId: event.projectId,
        workflowId: event.workflowId,
        actionId,
        source: "SPEC_SERVICE",
        sourceReceiptId: event.eventKey,
        signal: signalFor(event),
      });
      await this.store.completeEvent(event, actionId, completion.outboxId);
      return "COMPLETED";
    } catch (error) {
      await this.store.release(event).catch(() => undefined);
      throw error;
    }
  }

  async probe(): Promise<void> { await Promise.all([this.store.probe(), this.temporal.probe()]); }
}

function signalFor(event: SpecWorkflowEvent) {
  const signalId = `${event.eventType === "SPEC_READY" ? "spec-ready" : "spec-approved"}-${event.eventKey}`;
  if (event.eventType === "SPEC_READY") {
    return Object.freeze({
      signalId,
      type: "SPEC_READY" as const,
      specRevisionId: event.payload.draftSpecRevisionId,
    });
  }
  return Object.freeze({
    signalId,
    type: "SPEC_APPROVED" as const,
    approvedSpecRevisionId: event.payload.approvedSpecRevisionId,
    testPlanRevisionId: event.payload.approvedTestPlanRevisionId,
    approvalReceiptId: event.payload.operationKey,
  });
}

function invalid(): never { throw new Error("Specification workflow processing binding is invalid"); }
