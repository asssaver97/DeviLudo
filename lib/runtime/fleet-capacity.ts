import { createHash } from "node:crypto";

export type Fleet = "AGENT" | "LINUX" | "WINDOWS" | "MACOS";
export type CapacityReason = "MINIMUM_CAPACITY" | "QUEUE_BACKLOG" | "ACTIVE_WORK" | "IDLE_DRAIN" | "RECONCILIATION";

export interface FleetDemand {
  readonly queued: Readonly<Record<Fleet, number>>;
  readonly running: Readonly<Record<Fleet, number>>;
  readonly onlineHosts: Readonly<Record<Fleet, number>>;
  readonly gpuQueued: Readonly<{ linux: number; windows: number }>;
  readonly macReleaseEligible: boolean;
}

export interface FleetCapacityDecision {
  readonly fleet: Fleet;
  readonly desiredHosts: number;
  readonly reason: CapacityReason;
  readonly operationKey: string;
  readonly minimumReleaseAt: string | null;
}

export const P0_FLEET_POLICY = Object.freeze({
  minimumHosts: Object.freeze({ AGENT: 1, LINUX: 1, WINDOWS: 1, MACOS: 0 }),
  maximumHosts: Object.freeze({ AGENT: 1, LINUX: 1, WINDOWS: 1, MACOS: 1 }),
  exclusiveJobsPerHost: Object.freeze({ AGENT: 4, LINUX: 1, WINDOWS: 1, MACOS: 1 }),
  agentInteractiveReserve: Object.freeze({ minimumSlots: 2, resourceFraction: .20 }),
  macMinimumAllocationSeconds: 86_400,
  gpuSupported: Object.freeze({ linux: false, windows: false }),
});

export function decideP0FleetCapacity(demand: FleetDemand, at: Date): Readonly<{
  decisions: readonly FleetCapacityDecision[];
  unschedulableCapabilities: readonly string[];
}> {
  if (!Number.isFinite(at.valueOf())) throw new Error("Fleet capacity timestamp is invalid");
  for (const values of [demand.queued, demand.running, demand.onlineHosts]) {
    for (const fleet of ["AGENT", "LINUX", "WINDOWS", "MACOS"] as const) {
      if (!Number.isSafeInteger(values[fleet]) || values[fleet] < 0) throw new Error("Fleet demand is invalid");
    }
  }
  if (!Number.isSafeInteger(demand.gpuQueued.linux) || demand.gpuQueued.linux < 0
    || !Number.isSafeInteger(demand.gpuQueued.windows) || demand.gpuQueued.windows < 0) {
    throw new Error("GPU demand is invalid");
  }
  const decisions = (["AGENT", "LINUX", "WINDOWS", "MACOS"] as const).map((fleet) => {
    const activeWork = demand.queued[fleet] + demand.running[fleet];
    let desiredHosts: number;
    if (fleet === "MACOS") {
      desiredHosts = activeWork > 0 || (demand.onlineHosts.MACOS > 0 && !demand.macReleaseEligible) ? 1 : 0;
    } else {
      desiredHosts = Math.max(P0_FLEET_POLICY.minimumHosts[fleet], Math.ceil(activeWork / P0_FLEET_POLICY.exclusiveJobsPerHost[fleet]));
    }
    desiredHosts = Math.min(desiredHosts, P0_FLEET_POLICY.maximumHosts[fleet]);
    const reason: CapacityReason = desiredHosts === 0 ? "IDLE_DRAIN"
      : activeWork > 0 ? (demand.running[fleet] > 0 ? "ACTIVE_WORK" : "QUEUE_BACKLOG")
        : "MINIMUM_CAPACITY";
    const minimumReleaseAt = fleet === "MACOS" && desiredHosts > 0 && demand.onlineHosts.MACOS === 0
      ? new Date(at.valueOf() + P0_FLEET_POLICY.macMinimumAllocationSeconds * 1_000).toISOString()
      : null;
    const binding = `${fleet}\0${desiredHosts}\0${reason}\0${at.toISOString()}\0${minimumReleaseAt ?? ""}`;
    return Object.freeze({
      fleet,
      desiredHosts,
      reason,
      operationKey: `capacity:${createHash("sha256").update(binding).digest("hex")}`,
      minimumReleaseAt,
    });
  });
  const unschedulableCapabilities = Object.freeze([
    ...(demand.gpuQueued.linux > 0 ? ["linux:GPU"] : []),
    ...(demand.gpuQueued.windows > 0 ? ["windows:GPU"] : []),
  ]);
  return Object.freeze({ decisions: Object.freeze(decisions), unschedulableCapabilities });
}

export function mayReleaseMacHost(minimumReleaseAt: string, at: Date): boolean {
  const boundary = Date.parse(minimumReleaseAt);
  if (!Number.isFinite(boundary) || !Number.isFinite(at.valueOf())) throw new Error("Mac release timestamp is invalid");
  return at.valueOf() >= boundary;
}
