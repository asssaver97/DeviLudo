import { pathToFileURL } from "node:url";
import type { TargetPlatform } from "../../../lib/domain/types";
import type { DeliverySignal } from "./contracts";
import {
  connectDeliveryClient,
  queryGameDelivery,
  signalGameDelivery,
  startGameDelivery,
} from "./client";

export async function runDeliveryClient(argv = process.argv.slice(2)): Promise<void> {
  const [action, workflowId] = argv;
  if (!action || !workflowId) throw usage();
  const connected = await connectDeliveryClient();
  try {
    if (action === "start") {
      const tenantId = argv[2];
      const projectId = argv[3];
      const targetMatrix = parseTargets(argv[4]);
      if (!tenantId || !projectId) throw usage();
      const handle = await startGameDelivery(connected.client, { workflowId, tenantId, projectId, targetMatrix });
      process.stdout.write(`${JSON.stringify({ workflowId: handle.workflowId, started: true })}\n`);
      return;
    }
    if (action === "signal") {
      const signal = parseSignal(argv[2]);
      await signalGameDelivery(connected.client, workflowId, signal);
      process.stdout.write(`${JSON.stringify({ workflowId, signaled: signal.type })}\n`);
      return;
    }
    if (action === "query") {
      const snapshot = await queryGameDelivery(connected.client, workflowId);
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
      return;
    }
    throw usage();
  } finally {
    await connected.close();
  }
}

function parseTargets(raw: string | undefined): readonly TargetPlatform[] {
  const values = (raw ?? "linux").split(",");
  if (values.length === 0 || values.some((value) => !["windows", "linux", "macos"].includes(value))) {
    throw new Error("Targets must be a comma-separated subset of windows,linux,macos");
  }
  return [...new Set(values)] as TargetPlatform[];
}

function parseSignal(raw: string | undefined): DeliverySignal {
  if (!raw) throw usage();
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || typeof (parsed as Record<string, unknown>).type !== "string") {
    throw new Error("Signal must be a JSON object with a type");
  }
  return parsed as DeliverySignal;
}

function usage(): Error {
  return new Error(
    "Usage: run-client start <workflowId> <tenantId> <projectId> <windows,linux,macos> | signal <workflowId> '<json>' | query <workflowId>",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDeliveryClient();
}
