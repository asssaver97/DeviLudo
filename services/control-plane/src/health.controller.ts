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
        this.store.probe(),
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

  async p0Profile(): Promise<Readonly<Record<string, string>>> {
    try {
      return await this.store.read((state) => {
        const profile = state.profiles.get(state.defaults.get("platform") ?? "");
        const installation = profile ? state.installations.get(profile.installationId) : undefined;
        const provider = profile ? state.providers.get(profile.providerRevisionId) : undefined;
        const credential = profile ? state.credentials.get(profile.credentialVersionId) : undefined;
        const version = installation ? state.versions.get(installation.agentVersionId) : undefined;
        const model = provider?.models.primaryModel;
        if (!profile || profile.agent !== "claude-code" || profile.state !== "ACTIVE"
          || !installation || installation.agent !== "claude-code" || installation.state !== "ACTIVE"
          || installation.health !== "HEALTHY" || installation.selfUpdateDisabled !== true
          || (installation.fleetHealth?.readyWorkers ?? 0) < 1
          || !provider || provider.agent !== "claude-code" || provider.state !== "ACTIVE"
          || Object.values(provider.probe).some((probe) => probe !== "PASS")
          || !credential || credential.state !== "ACTIVE"
          || !version || version.agent !== "claude-code" || version.state !== "APPROVED"
          || !/^\d+\.\d+\.\d+$/.test(version.version)
          || typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(model)
          || /^(latest|default|sonnet)$/i.test(model)) throw new Error();
        return Object.freeze({
          schemaVersion: "deviludo.agent-profile-readiness.v1", status: "ready", agent: "claude-code",
          cliVersion: version.version, model, profileState: "READY", providerState: "READY",
          credentialState: "ACTIVE", installationState: "ACTIVE", workerState: "READY",
        });
      });
    } catch {
      throw new ServiceUnavailableException({ status: "blocked", service: "deviludo-agent-profile-readiness" });
    }
  }
}

Inject(AdminStore)(HealthController, undefined, 0);
Inject(SecretVault)(HealthController, undefined, 1);
Inject(ProviderProbe)(HealthController, undefined, 2);
Inject(AgentSupplyChain)(HealthController, undefined, 3);
Inject(InferenceRequestReconciler)(HealthController, undefined, 4);
Inject(SpecModelGenerationReconciler)(HealthController, undefined, 5);
Get("healthz")(HealthController.prototype, "readiness", Object.getOwnPropertyDescriptor(HealthController.prototype, "readiness")!);
Get("healthz/p0-profile")(HealthController.prototype, "p0Profile", Object.getOwnPropertyDescriptor(HealthController.prototype, "p0Profile")!);
Controller()(HealthController);
