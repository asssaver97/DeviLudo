import type { Client } from "@temporalio/client";
import type { DeliverySignal } from "./contracts";
import { signalGameDelivery } from "./client";
import type { WorkflowSignalPort } from "./job-processor";

export class TemporalWorkflowSignalPort implements WorkflowSignalPort {
  constructor(private readonly client: Client) {}

  async signal(workflowId: string, signal: DeliverySignal): Promise<void> {
    await signalGameDelivery(this.client, workflowId, signal);
  }
}
