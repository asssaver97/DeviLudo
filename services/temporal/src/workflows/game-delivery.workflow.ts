import {
  condition,
  defineQuery,
  defineSignal,
  patched,
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
import { deliveryCommandDestination } from "../contracts";
import {
  DELIVERY_PROJECTION_SCHEMA_VERSION,
  deliveryProjectionKey,
} from "../../../../lib/orchestration/delivery-projection";

export const deliverySignal = defineSignal<[DeliverySignal]>("deliverySignal");
export const deliverySnapshotQuery = defineQuery<DeliverySnapshot>("deliverySnapshot");
export const deliveryNextCommandQuery = defineQuery<DeliveryCommand>("deliveryNextCommand");
export const AUTOMATIC_REPAIR_SUCCESSOR_RUNS_PATCH = "automatic-repair-successor-runs-v1";

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
  const machine = new GameDeliveryWorkflow({
    ...input,
    automaticRepairSuccessorRuns: patched(AUTOMATIC_REPAIR_SUCCESSOR_RUNS_PATCH),
  });
  const queue: DeliverySignal[] = [];
  let lastDispatchedKey: string | null = null;
  let lastProjectedKey: string | null = null;

  const persist = async (snapshot: DeliverySnapshot) => {
    const projectionKey = deliveryProjectionKey(snapshot);
    if (projectionKey === lastProjectedKey) return;
    await activities.persistDeliverySnapshot({
      schemaVersion: DELIVERY_PROJECTION_SCHEMA_VERSION,
      projectionKey,
      snapshot,
    });
    lastProjectedKey = projectionKey;
  };

  setHandler(deliverySignal, (signal) => {
    queue.push(signal);
  });
  setHandler(deliverySnapshotQuery, () => machine.current() as DeliverySnapshot);
  setHandler(deliveryNextCommandQuery, () => machine.nextCommand());

  await persist(machine.current() as DeliverySnapshot);

  while (true) {
    while (queue.length > 0) {
      const signal = queue.shift();
      if (!signal) continue;
      const snapshot = machine.signal(signal) as DeliverySnapshot;
      await persist(snapshot);
      if (signal.type === "CANCEL") {
        await activities.cancelDelivery({
          idempotencyKey: dispatchKey(snapshot, "CANCEL_DELIVERY"),
          workflowId: snapshot.workflowId,
          tenantId: snapshot.tenantId,
          projectId: snapshot.projectId,
          destination: "control-plane",
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
        destination: deliveryCommandDestination(command),
        command,
        snapshot,
      });
      lastDispatchedKey = currentDispatchKey;
    }

    // A publish dispatch receipt only means the command was accepted. The
    // state reaches RELEASED exclusively after the STEAM_RELEASED signal binds
    // the resulting release and default-branch build identifiers.
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
