import type {
  DeliveryCommand,
  DeliverySignal,
  DeliverySnapshot,
} from "../../../lib/orchestration/game-delivery";
export { assertDeliverySignal } from "../../../lib/orchestration/game-delivery";
import type { TargetPlatform } from "../../../lib/domain/types";
import type {
  DeliveryProjectionReceipt,
  DeliveryProjectionRequest,
} from "../../../lib/orchestration/delivery-projection";

export const DELIVERY_TASK_QUEUE = "deviludo-game-delivery-v1";
export const DELIVERY_WORKFLOW_TYPE = "gameDeliveryWorkflow";

export type DispatchableDeliveryCommand = Exclude<DeliveryCommand, "NONE">;

export type DeliveryCommandDestination =
  | "control-plane"
  | "agent-worker"
  | "runner-control"
  | "scm-proxy"
  | "steam-publisher";

const COMMAND_DESTINATIONS = {
  CONTINUE_IDEA_DIALOGUE: "control-plane",
  REQUEST_SPEC_APPROVAL: "control-plane",
  RESOLVE_AGENT_RUN_CONFIGURATION: "control-plane",
  START_LOCKED_AGENT_RUN: "agent-worker",
  WAIT_FOR_PROVIDER: "control-plane",
  START_TARGET_MATRIX_E2E: "runner-control",
  REQUEST_USER_ACCEPTANCE: "control-plane",
  MERGE_DRAFT_PULL_REQUEST: "scm-proxy",
  START_MAIN_SHA_RELEASE_GATE: "runner-control",
  REQUEST_FRESH_MFA: "control-plane",
  UPLOAD_AND_ACTIVATE_PRIVATE_BETA: "steam-publisher",
  INSTALL_FROM_CLEAN_STEAM_CLIENT: "runner-control",
  WAIT_FOR_EXTERNAL_APPROVAL: "control-plane",
  PUBLISH_STEAM_DEFAULT_BRANCH: "steam-publisher",
} as const satisfies Record<DispatchableDeliveryCommand, DeliveryCommandDestination>;

export function deliveryCommandDestination(
  command: DispatchableDeliveryCommand,
): DeliveryCommandDestination {
  return COMMAND_DESTINATIONS[command];
}

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
  readonly destination: DeliveryCommandDestination;
  readonly command: DispatchableDeliveryCommand;
  readonly snapshot: DeliverySnapshot;
}

export interface CancelDeliveryInput {
  readonly idempotencyKey: string;
  readonly workflowId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly destination: "control-plane";
  readonly reason: string;
  readonly snapshot: DeliverySnapshot;
}

export interface DeliveryActivityReceipt {
  readonly receiptId: string;
  readonly acceptedAt: string;
  readonly destination: DeliveryCommandDestination;
  readonly workflowId: string;
  readonly idempotencyKey: string;
  readonly operation: DispatchableDeliveryCommand | "CANCEL_DELIVERY";
}

export interface DeliveryActivities {
  dispatchDeliveryCommand(input: DispatchDeliveryCommandInput): Promise<DeliveryActivityReceipt>;
  cancelDelivery(input: CancelDeliveryInput): Promise<DeliveryActivityReceipt>;
  persistDeliverySnapshot(input: DeliveryProjectionRequest): Promise<DeliveryProjectionReceipt>;
}

export type { DeliveryCommand, DeliverySignal, DeliverySnapshot };
