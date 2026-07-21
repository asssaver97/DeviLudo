import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { AgentSupplyChain } from "./agent-supply-chain";
import { AdminStore } from "./admin.store";

/** Mesh-only readiness endpoint used by the production Web control plane. */
export class HealthController {
  constructor(
    private readonly store: AdminStore,
    private readonly supplyChain: AgentSupplyChain,
  ) {}

  async readiness(): Promise<Readonly<Record<string, string>>> {
    try {
      await Promise.all([
        this.store.read(() => undefined),
        this.supplyChain.probe(),
      ]);
    } catch {
      throw new ServiceUnavailableException({
        status: "unavailable",
        service: "deviludo-admin-control-plane",
      });
    }
    return Object.freeze({ status: "ok", service: "deviludo-admin-control-plane" });
  }
}

Inject(AdminStore)(HealthController, undefined, 0);
Inject(AgentSupplyChain)(HealthController, undefined, 1);
Get("healthz")(HealthController.prototype, "readiness", Object.getOwnPropertyDescriptor(HealthController.prototype, "readiness")!);
Controller()(HealthController);
