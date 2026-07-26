import type { AgentExecutionOperationSource } from "./postgres-dispatch";
import type { AgentExecutionOperationWorker } from "./operations";
import { parseAgentExecutionWorkerBinding, type AgentExecutionWorkerBinding } from "./worker-binding";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class AgentExecutionOperationProcessor {
  readonly #binding: AgentExecutionWorkerBinding;

  constructor(private readonly source: AgentExecutionOperationSource,
    private readonly worker: Pick<AgentExecutionOperationWorker, "execute" | "probe">,
    binding: AgentExecutionWorkerBinding) { this.#binding = parseAgentExecutionWorkerBinding(binding); }

  async processOne(tenantId: string): Promise<"IDLE" | "CONTENDED" | "TERMINAL"> {
    if (!UUID.test(tenantId)) invalid();
    const item = await this.source.next(tenantId, this.#binding);
    if (!item) return "IDLE";
    if (item.tenantId !== tenantId || !UUID.test(item.runId)) invalid();
    const status = await this.worker.execute(item);
    if (status === null || status.status === "RUNNING") return "CONTENDED";
    if (status.runId !== item.runId) invalid();
    return "TERMINAL";
  }

  async probe(): Promise<void> { await Promise.all([this.source.probe(), this.worker.probe()]); }
}

export class PollingAgentExecutionWorkerHost {
  constructor(private readonly processor: AgentExecutionOperationProcessor, private readonly tenantIds: readonly string[],
    private readonly options: Readonly<{ pollIntervalMs?: number; retryIntervalMs?: number;
      wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
      diagnostic?: (event: "READY" | "CYCLE_FAILED" | "STOPPED") => void }> = {}) {
    validateTenants(tenantIds); interval(options.pollIntervalMs ?? 1_000); interval(options.retryIntervalMs ?? 5_000);
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.processor.probe(); this.options.diagnostic?.("READY");
    const wait = this.options.wait ?? waitFor; const poll = this.options.pollIntervalMs ?? 1_000;
    const retry = this.options.retryIntervalMs ?? 5_000;
    try {
      while (!signal.aborted) {
        let terminal = false; let failed = false;
        for (const tenantId of this.tenantIds) {
          if (signal.aborted) break;
          try { if (await this.processor.processOne(tenantId) === "TERMINAL") terminal = true; }
          catch { failed = true; this.options.diagnostic?.("CYCLE_FAILED"); }
        }
        if (!signal.aborted && (!terminal || failed)) await wait(failed ? retry : poll, signal);
      }
    } finally { this.options.diagnostic?.("STOPPED"); }
  }
}

function validateTenants(value: readonly string[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000 || value.some((item) => !UUID.test(item))
    || new Set(value).size !== value.length || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
}
function interval(value: number): void { if (!Number.isInteger(value) || value < 100 || value > 60_000) invalid(); }
async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => { const timer = setTimeout(done, milliseconds);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true }); });
}
function invalid(): never { throw new Error("Agent execution Worker host is invalid"); }
