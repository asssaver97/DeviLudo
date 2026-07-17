import type { DeliveryCommandDestination } from "./contracts";
import type { WorkflowJobProcessor } from "./job-processor";

export type WorkflowJobProcessResult = Awaited<ReturnType<WorkflowJobProcessor["processOne"]>>;

export interface WorkflowJobProcessorPort {
  processOne(tenantId: string): Promise<WorkflowJobProcessResult>;
}

/**
 * Returns only tenants assigned to this workload by the trusted control plane.
 * The worker host never discovers tenants by bypassing RLS or scanning tables as
 * a database owner.
 */
export interface WorkflowTenantAssignmentSource {
  listTenantIds(destination: DeliveryCommandDestination): Promise<readonly string[]>;
}

export interface WorkflowWorkerHostDiagnostic {
  readonly code: "TENANT_ASSIGNMENT_FAILED" | "JOB_PROCESSOR_FAILED";
  readonly destination: DeliveryCommandDestination;
}

export type WorkflowWorkerHostPause = (delayMs: number, signal: AbortSignal) => Promise<void>;

/**
 * Long-running, destination-specific queue consumer. It drains productive
 * cycles immediately, backs off when idle or after infrastructure failures,
 * and resolves cleanly when the process abort signal fires.
 */
export class WorkflowJobWorkerHost {
  readonly #processor: WorkflowJobProcessorPort;
  readonly #tenants: WorkflowTenantAssignmentSource;
  readonly #destination: DeliveryCommandDestination;
  readonly #pause: WorkflowWorkerHostPause;
  readonly #idleDelayMs: number;
  readonly #errorDelayMs: number;
  readonly #onDiagnostic: (diagnostic: WorkflowWorkerHostDiagnostic) => void;
  #running = false;

  constructor(options: {
    readonly processor: WorkflowJobProcessorPort;
    readonly tenants: WorkflowTenantAssignmentSource;
    readonly destination: DeliveryCommandDestination;
    readonly pause?: WorkflowWorkerHostPause;
    readonly idleDelayMs?: number;
    readonly errorDelayMs?: number;
    readonly onDiagnostic?: (diagnostic: WorkflowWorkerHostDiagnostic) => void;
  }) {
    this.#processor = options.processor;
    this.#tenants = options.tenants;
    this.#destination = options.destination;
    this.#pause = options.pause ?? abortablePause;
    this.#idleDelayMs = validDelay(options.idleDelayMs ?? 1_000, "idle");
    this.#errorDelayMs = validDelay(options.errorDelayMs ?? 5_000, "error");
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) throw new Error("Workflow job worker host is already running");
    this.#running = true;
    try {
      while (!signal.aborted) {
        let tenants: readonly string[];
        try {
          tenants = normalizeTenantIds(await this.#tenants.listTenantIds(this.#destination));
        } catch {
          this.#diagnostic("TENANT_ASSIGNMENT_FAILED");
          await this.#pause(this.#errorDelayMs, signal);
          continue;
        }

        let productive = false;
        let infrastructureFailure = false;
        for (const tenantId of tenants) {
          if (signal.aborted) break;
          try {
            const result = await this.#processor.processOne(tenantId);
            if (result.kind !== "IDLE") productive = true;
          } catch {
            infrastructureFailure = true;
            this.#diagnostic("JOB_PROCESSOR_FAILED");
          }
        }
        if (signal.aborted) break;
        if (infrastructureFailure) {
          await this.#pause(this.#errorDelayMs, signal);
        } else if (!productive) {
          await this.#pause(this.#idleDelayMs, signal);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  #diagnostic(code: WorkflowWorkerHostDiagnostic["code"]): void {
    try {
      this.#onDiagnostic(Object.freeze({ code, destination: this.#destination }));
    } catch {
      // Telemetry must not terminate or hot-loop the workload consumer.
    }
  }
}

function normalizeTenantIds(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 10_000) throw new Error("Workflow tenant assignment set is invalid");
  const unique = new Set<string>();
  for (const value of values) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
      throw new Error("Workflow tenant assignment is invalid");
    }
    unique.add(value.toLowerCase());
  }
  return Object.freeze([...unique]);
}

function validDelay(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 10 || value > 60_000) {
    throw new Error(`Workflow worker ${label} delay is invalid`);
  }
  return value;
}

function abortablePause(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const complete = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", complete);
      resolve();
    };
    const timer = setTimeout(complete, delayMs);
    signal.addEventListener("abort", complete, { once: true });
  });
}
