import type { WorkflowTenantAssignmentSource } from "../../temporal/src/job-worker-host";
import { parseProviderRecoveryRequest, validSchedulerSubject, type ProviderRecoveryRequest } from "./contracts";
import type { ProviderRecoveryService } from "./service";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface ProviderRecoveryCandidateSource {
  listDue(tenantId: string, limit: number): Promise<readonly ProviderRecoveryRequest[]>;
}

export interface ProviderRecoveryWorkerCycle {
  readonly attempted: number;
  readonly recovered: number;
}

/**
 * Scans only tenants in a freshly verified workload assignment. The store
 * applies RLS per tenant and re-derives every immutable Run binding when a
 * candidate is claimed, so this loop has no platform-wide database bypass.
 */
export class ProviderRecoveryWorker {
  constructor(
    private readonly candidates: ProviderRecoveryCandidateSource,
    private readonly service: Pick<ProviderRecoveryService, "check">,
    private readonly tenants: WorkflowTenantAssignmentSource,
    private readonly schedulerSubject: string,
    private readonly options: Readonly<{
      pollIntervalMs?: number;
      perTenantLimit?: number;
      onDiagnostic?: (diagnostic: Readonly<Record<string, unknown>>) => void;
    }> = {},
  ) {
    if (!validSchedulerSubject(schedulerSubject)) throw new Error("Provider recovery worker identity is invalid");
    interval(options.pollIntervalMs ?? 1_000);
    limit(options.perTenantLimit ?? 20);
  }

  async runCycle(): Promise<ProviderRecoveryWorkerCycle> {
    const tenantIds = await this.tenants.listTenantIds("control-plane");
    if (JSON.stringify([...tenantIds].sort()) !== JSON.stringify(tenantIds)
      || new Set(tenantIds).size !== tenantIds.length || tenantIds.some((id) => !UUID.test(id))) {
      throw new Error("Provider recovery tenant assignment is invalid");
    }
    let attempted = 0;
    let recovered = 0;
    for (const tenantId of tenantIds) {
      const due = await this.candidates.listDue(tenantId, limit(this.options.perTenantLimit ?? 20));
      const seen = new Set<string>();
      for (const value of due) {
        const request = parseProviderRecoveryRequest(value);
        if (request.tenantId !== tenantId.toLowerCase() || seen.has(request.actionId)) {
          throw new Error("Provider recovery candidate set is invalid");
        }
        seen.add(request.actionId);
        attempted += 1;
        try {
          await this.service.check(request, this.schedulerSubject);
          recovered += 1;
        } catch (error) {
          this.#diagnostic(Object.freeze({
            code: "PROVIDER_RECOVERY_ATTEMPT_FAILED",
            tenantId,
            actionId: request.actionId,
            error: error instanceof Error ? error.name : "UnknownError",
          }));
        }
      }
    }
    return Object.freeze({ attempted, recovered });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runCycle();
      } catch (error) {
        this.#diagnostic(Object.freeze({
          code: "PROVIDER_RECOVERY_CYCLE_FAILED",
          error: error instanceof Error ? error.name : "UnknownError",
        }));
      }
      await pause(interval(this.options.pollIntervalMs ?? 1_000), signal);
    }
  }

  #diagnostic(value: Readonly<Record<string, unknown>>): void {
    try { this.options.onDiagnostic?.(value); } catch { /* telemetry cannot stop recovery */ }
  }
}

function interval(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new Error("Provider recovery poll interval is invalid");
  }
  return value;
}
function limit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Provider recovery batch size is invalid");
  }
  return value;
}
function pause(delayMs: number, signal: AbortSignal): Promise<void> {
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
