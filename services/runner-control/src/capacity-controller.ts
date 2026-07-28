import { decideP0FleetCapacity, type Fleet, type FleetCapacityDecision, type FleetDemand } from "../../../lib/runtime/fleet-capacity";

export interface FleetCapacityIntent extends FleetCapacityDecision {
  readonly id: string;
  readonly state: "REQUESTED" | "HOST_ALLOCATING" | "DRAINING";
  readonly requestedAt: string;
}

export interface FleetCapacityStore {
  loadDemand(at: Date): Promise<FleetDemand>;
  latestDesiredHosts(): Promise<Readonly<Record<Fleet, number | null>>>;
  createIntent(decision: FleetCapacityDecision, at: Date): Promise<FleetCapacityIntent>;
  markPublished(intent: FleetCapacityIntent, receipt: Readonly<Record<string, unknown>>, at: Date): Promise<void>;
}

export interface MacCapacityPublisher {
  publish(intent: FleetCapacityIntent): Promise<Readonly<Record<string, unknown>>>;
}

export class RunnerCapacityController {
  readonly #store: FleetCapacityStore;
  readonly #macPublisher: MacCapacityPublisher;

  constructor(options: Readonly<{ store: FleetCapacityStore; macPublisher: MacCapacityPublisher }>) {
    this.#store = options.store;
    this.#macPublisher = options.macPublisher;
  }

  async reconcile(at = new Date()): Promise<Readonly<{
    created: readonly FleetCapacityIntent[];
    unschedulableCapabilities: readonly string[];
  }>> {
    const [demand, latest] = await Promise.all([this.#store.loadDemand(at), this.#store.latestDesiredHosts()]);
    const decision = decideP0FleetCapacity(demand, at);
    const created: FleetCapacityIntent[] = [];
    for (const target of decision.decisions) {
      // Agent/Linux/Windows are pinned, persistent OpenTofu capacity in P0.
      // This controller owns only the on-demand AWS Mac lifecycle; recording
      // unactuated intents for static hosts would leave them REQUESTED forever.
      if (target.fleet !== "MACOS") continue;
      if (latest[target.fleet] === target.desiredHosts) continue;
      const intent = await this.#store.createIntent(target, at);
      created.push(intent);
      const receipt = await this.#macPublisher.publish(intent);
      await this.#store.markPublished(intent, receipt, at);
    }
    return Object.freeze({
      created: Object.freeze(created),
      unschedulableCapabilities: decision.unschedulableCapabilities,
    });
  }
}
