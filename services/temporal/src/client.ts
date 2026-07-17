import { Client, Connection, type WorkflowHandle } from "@temporalio/client";
import type {
  DeliverySignal,
  DeliverySnapshot,
  GameDeliveryWorkflowInput,
} from "./contracts";
import { DELIVERY_TASK_QUEUE } from "./contracts";
import {
  deliverySignal,
  deliverySnapshotQuery,
  gameDeliveryWorkflow,
} from "./workflows/game-delivery.workflow";

export interface TemporalClientOptions {
  readonly address?: string;
  readonly namespace?: string;
}

export interface ConnectedDeliveryClient {
  readonly client: Client;
  close(): Promise<void>;
}

export async function connectDeliveryClient(
  options: TemporalClientOptions = {},
): Promise<ConnectedDeliveryClient> {
  const connection = await Connection.connect({
    address: options.address ?? process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const client = new Client({
    connection,
    namespace: options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? "default",
  });
  return { client, close: () => connection.close() };
}

export async function startGameDelivery(
  client: Client,
  input: GameDeliveryWorkflowInput,
  taskQueue = process.env.DEVILUDO_TEMPORAL_TASK_QUEUE ?? DELIVERY_TASK_QUEUE,
): Promise<WorkflowHandle<typeof gameDeliveryWorkflow>> {
  return client.workflow.start(gameDeliveryWorkflow, {
    workflowId: input.workflowId,
    taskQueue,
    args: [input],
    memo: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      targetMatrix: [...input.targetMatrix],
    },
  });
}

export async function signalGameDelivery(
  client: Client,
  workflowId: string,
  signal: DeliverySignal,
): Promise<void> {
  await client.workflow.getHandle(workflowId).signal(deliverySignal, signal);
}

export async function queryGameDelivery(
  client: Client,
  workflowId: string,
): Promise<DeliverySnapshot> {
  return client.workflow.getHandle(workflowId).query(deliverySnapshotQuery);
}
