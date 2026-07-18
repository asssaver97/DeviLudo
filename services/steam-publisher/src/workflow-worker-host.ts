import type { SteamWorkflowOperationStatus } from "./workflow-broker-http";
import type { SteamWorkflowOperationSource } from "./postgres-workflow-dispatch";
import type { SteamWorkflowOperationWorker } from "./workflow-broker-operations";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export type SteamWorkflowWorkerCycle =
  | Readonly<{ kind: "IDLE" }>
  | Readonly<{ kind: "CONTENDED"; operationId: string }>
  | Readonly<{ kind: "TERMINAL"; operationId: string; status: "COMPLETED" | "FAILED" }>;

export class SteamWorkflowOperationProcessor {
  constructor(
    private readonly source: SteamWorkflowOperationSource,
    private readonly worker: Pick<SteamWorkflowOperationWorker, "execute" | "probe">,
  ) {}

  async processOne(tenantId: string): Promise<SteamWorkflowWorkerCycle> {
    validateTenant(tenantId);
    const item = await this.source.next(tenantId);
    if (!item) return Object.freeze({ kind: "IDLE" as const });
    if (item.tenantId !== tenantId || !UUID.test(item.operationId)) invalid();
    const status = await this.worker.execute(item);
    validateStatusIdentity(status, item.operationId);
    if (status.status === "RUNNING") {
      return Object.freeze({ kind: "CONTENDED" as const, operationId: item.operationId });
    }
    return Object.freeze({ kind: "TERMINAL" as const, operationId: item.operationId, status: status.status });
  }

  async probe(): Promise<void> {
    await Promise.all([this.source.probe(), this.worker.probe()]);
  }
}

export class PollingSteamWorkflowWorkerHost {
  constructor(
    private readonly processor: SteamWorkflowOperationProcessor,
    private readonly tenantIds: readonly string[],
    private readonly options: Readonly<{
      pollIntervalMs?: number;
      retryIntervalMs?: number;
      wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
      diagnostic?: (event: "READY" | "CYCLE_FAILED" | "STOPPED") => void;
    }> = {},
  ) {
    validateTenants(tenantIds);
    interval(options.pollIntervalMs ?? 1_000);
    interval(options.retryIntervalMs ?? 5_000);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!(signal instanceof AbortSignal)) invalid();
    await this.processor.probe();
    this.options.diagnostic?.("READY");
    const wait = this.options.wait ?? waitFor;
    const pollIntervalMs = this.options.pollIntervalMs ?? 1_000;
    const retryIntervalMs = this.options.retryIntervalMs ?? 5_000;
    try {
      while (!signal.aborted) {
        let worked = false;
        let failed = false;
        for (const tenantId of this.tenantIds) {
          if (signal.aborted) break;
          try {
            const cycle = await this.processor.processOne(tenantId);
            if (cycle.kind !== "IDLE" && cycle.kind !== "CONTENDED") worked = true;
          } catch {
            failed = true;
            this.options.diagnostic?.("CYCLE_FAILED");
          }
        }
        if (!signal.aborted && (!worked || failed)) {
          await wait(failed ? retryIntervalMs : pollIntervalMs, signal);
        }
      }
    } finally {
      this.options.diagnostic?.("STOPPED");
    }
  }
}

function validateStatusIdentity(status: SteamWorkflowOperationStatus, operationId: string): void {
  if (status.operationId !== operationId) invalid();
}

function validateTenants(value: readonly string[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000
    || value.some((tenantId) => !UUID.test(tenantId))
    || new Set(value).size !== value.length
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
}

function validateTenant(value: string): void { if (!UUID.test(value)) invalid(); }

function interval(value: number): void {
  if (!Number.isInteger(value) || value < 100 || value > 60_000) invalid();
}

async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function invalid(): never { throw new Error("Steam workflow Worker host is invalid"); }
