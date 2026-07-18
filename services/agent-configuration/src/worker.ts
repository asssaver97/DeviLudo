import type { WorkflowTenantAssignmentSource } from "../../temporal/src/job-worker-host";
import type { AgentConfigurationService } from "./service";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class AgentConfigurationWorker {
  #running = false;
  #stopRequested = false;
  #loop: Promise<void> | null = null;

  constructor(
    private readonly service: Pick<AgentConfigurationService, "processTenantOnce">,
    private readonly tenants: WorkflowTenantAssignmentSource,
    private readonly pollIntervalMs = 1_000,
    private readonly onDiagnostic: (diagnostic: Readonly<Record<string, unknown>>) => void = () => undefined,
  ) {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
      throw new Error("Agent configuration poll interval is invalid");
    }
  }

  start(): void {
    if (this.#running) throw new Error("Agent configuration worker is already running");
    this.#running = true;
    this.#stopRequested = false;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
    await this.#loop;
  }

  async runCycle(): Promise<number> {
    const tenantIds = await this.tenants.listTenantIds("control-plane");
    if (JSON.stringify([...tenantIds].sort()) !== JSON.stringify(tenantIds)
      || new Set(tenantIds).size !== tenantIds.length || tenantIds.some((id) => !UUID.test(id))) {
      throw new Error("Agent configuration tenant assignment is invalid");
    }
    let completed = 0;
    for (const tenantId of tenantIds) {
      for (let index = 0; index < 20; index += 1) {
        const outcome = await this.service.processTenantOnce(tenantId);
        if (outcome === "COMPLETED") { completed += 1; continue; }
        break;
      }
    }
    return completed;
  }

  async #run(): Promise<void> {
    try {
      while (!this.#stopRequested) {
        try { await this.runCycle(); }
        catch (error) {
          this.onDiagnostic(Object.freeze({
            code: "AGENT_CONFIGURATION_CYCLE_FAILED",
            at: new Date().toISOString(),
            error: error instanceof Error ? error.name : "UnknownError",
          }));
        }
        if (!this.#stopRequested) await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    } finally {
      this.#running = false;
      this.#loop = null;
    }
  }
}
