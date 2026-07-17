import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import { GameDeliveryWorkflow } from "../../../../lib/orchestration/game-delivery";
import type {
  DeliveryActivities,
  DeliveryCommand,
  DeliverySignal,
  DeliverySnapshot,
  GameDeliveryWorkflowInput,
} from "../contracts";

export const deliverySignal = defineSignal<[DeliverySignal]>("deliverySignal");
export const deliverySnapshotQuery = defineQuery<DeliverySnapshot>("deliverySnapshot");
export const deliveryNextCommandQuery = defineQuery<DeliveryCommand>("deliveryNextCommand");

const activities = proxyActivities<DeliveryActivities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "60 seconds",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 10,
  },
});

/**
 * Durable wrapper around the repository's deterministic state machine.
 * Every wait is a signal-backed Temporal condition: no timers, cron jobs or
 * database polling are used for user, Provider, MFA, Steam or Valve waits.
 */
export async function gameDeliveryWorkflow(
  input: GameDeliveryWorkflowInput,
): Promise<DeliverySnapshot> {
  const machine = new GameDeliveryWorkflow(input);
  const queue: DeliverySignal[] = [];
  let lastDispatchedKey: string | null = null;

  setHandler(deliverySignal, (signal) => {
    queue.push(signal);
  });
  setHandler(deliverySnapshotQuery, () => machine.current() as DeliverySnapshot);
  setHandler(deliveryNextCommandQuery, () => machine.nextCommand());

  while (true) {
    while (queue.length > 0) {
      const signal = queue.shift();
      if (!signal) continue;
      const snapshot = machine.signal(signal) as DeliverySnapshot;
      if (signal.type === "CANCEL") {
        await activities.cancelDelivery({
          idempotencyKey: dispatchKey(snapshot, "CANCEL_DELIVERY"),
          workflowId: snapshot.workflowId,
          tenantId: snapshot.tenantId,
          projectId: snapshot.projectId,
          reason: signal.reason,
          snapshot,
        });
        return snapshot;
      }
    }

    const snapshot = machine.current() as DeliverySnapshot;
    const command = machine.nextCommand();
    const currentDispatchKey = dispatchKey(snapshot, command);
    if (command !== "NONE" && currentDispatchKey !== lastDispatchedKey) {
      await activities.dispatchDeliveryCommand({
        idempotencyKey: currentDispatchKey,
        workflowId: snapshot.workflowId,
        tenantId: snapshot.tenantId,
        projectId: snapshot.projectId,
        command,
        snapshot,
      });
      lastDispatchedKey = currentDispatchKey;
    }

    // RELEASED means the external publish command above was accepted. The
    // immutable receipt remains in activity history and this workflow closes.
    if (snapshot.state === "RELEASED") return snapshot;

    await condition(() => queue.length > 0);
  }
}

export function dispatchKey(
  snapshot: Pick<DeliverySnapshot, "workflowId" | "state" | "history">,
  command: DeliveryCommand | "CANCEL_DELIVERY",
): string {
  return `${snapshot.workflowId}:${snapshot.history.length}:${snapshot.state}:${command}`;
}
