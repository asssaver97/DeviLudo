import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { AgentSupplyChain } from "./agent-supply-chain";
import { AdminStore } from "./admin.store";
import { InferenceRequestReconciler } from "./inference-reconciliation";
import { ProviderProbe } from "./provider-probe";
import { SecretVault } from "./secret-vault";
import { SpecModelGenerationReconciler } from "./spec-model-reconciliation";

/** Mesh-only readiness endpoint used by the production Web control plane. */
export class HealthController {
  constructor(
    private readonly store: AdminStore,
    private readonly vault: SecretVault,
    private readonly providerProbe: ProviderProbe,
    private readonly supplyChain: AgentSupplyChain,
    private readonly inferenceReconciler: InferenceRequestReconciler,
    private readonly specModelReconciler: SpecModelGenerationReconciler,
  ) {}

  async readiness(): Promise<Readonly<Record<string, string>>> {
    try {
      await Promise.all([
        this.store.read(() => undefined),
        this.vault.probe(),
        this.providerProbe.probe(),
        this.supplyChain.probe(),
        this.inferenceReconciler.probe(),
        this.specModelReconciler.probe(),
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
Inject(SecretVault)(HealthController, undefined, 1);
Inject(ProviderProbe)(HealthController, undefined, 2);
Inject(AgentSupplyChain)(HealthController, undefined, 3);
Inject(InferenceRequestReconciler)(HealthController, undefined, 4);
Inject(SpecModelGenerationReconciler)(HealthController, undefined, 5);
Get("healthz")(HealthController.prototype, "readiness", Object.getOwnPropertyDescriptor(HealthController.prototype, "readiness")!);
Controller()(HealthController);
