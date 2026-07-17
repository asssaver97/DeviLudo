import type {
  DeliveryCommand,
  DeliverySignal,
  DeliverySnapshot,
} from "../../../lib/orchestration/game-delivery";
import type { TargetPlatform } from "../../../lib/domain/types";

export const DELIVERY_TASK_QUEUE = "deviludo-game-delivery-v1";
export const DELIVERY_WORKFLOW_TYPE = "gameDeliveryWorkflow";

export interface GameDeliveryWorkflowInput {
  readonly workflowId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly targetMatrix: readonly TargetPlatform[];
}

export interface DispatchDeliveryCommandInput {
  readonly idempotencyKey: string;
  readonly workflowId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly command: DeliveryCommand;
  readonly snapshot: DeliverySnapshot;
}

export interface CancelDeliveryInput {
  readonly idempotencyKey: string;
  readonly workflowId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly reason: string;
  readonly snapshot: DeliverySnapshot;
}

export interface DeliveryActivityReceipt {
  readonly receiptId: string;
  readonly acceptedAt: string;
}

export interface DeliveryActivities {
  dispatchDeliveryCommand(input: DispatchDeliveryCommandInput): Promise<DeliveryActivityReceipt>;
  cancelDelivery(input: CancelDeliveryInput): Promise<DeliveryActivityReceipt>;
}

export type { DeliveryCommand, DeliverySignal, DeliverySnapshot };
