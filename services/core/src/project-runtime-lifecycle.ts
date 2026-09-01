import { PROJECT_RUNTIME_SCHEMA } from "@/lib/product/project-runtime";
import { freemem, totalmem } from "node:os";
import type { ProjectRuntimeRepository, RuntimeLifecycleClaim } from "./project-runtime-repository";
import type { ProjectRuntimeService } from "./project-runtime-service";
import type { CoreRepository } from "./repository";

export class ProjectRuntimeLifecycle {
  private reconciled = false;
  constructor(
    private readonly runtimes: ProjectRuntimeRepository,
    private readonly service: ProjectRuntimeService,
    private readonly repository: CoreRepository,
  ) {}

  async runOnce(): Promise<Readonly<Record<string, unknown>> | null> {
    if (!this.reconciled) {
      const result = await this.service.reconcileRuntimes();
      this.reconciled = true;
      return Object.freeze({ action: "RECONCILE", ...result });
    }
    const pressureClaim = totalmem() > 0 && freemem() / totalmem() < 0.1
      ? await this.runtimes.claimPressureLifecycle()
      : null;
    const claim = pressureClaim ?? await this.runtimes.claimLifecycle();
    if (!claim) return null;
    try {
      if (claim.action === "PAUSE") {
        if (!await this.compactAndPause(claim)) {
          await this.runtimes.failLifecycle(claim).catch(() => undefined);
          return Object.freeze({
            workspaceId: claim.workspaceId,
            projectId: claim.projectId,
            action: "INTERRUPTED",
            generation: claim.generation,
          });
        }
      } else await this.destroy(claim);
      if (!await this.runtimes.completeLifecycle(claim)) {
        throw new Error("Project Runtime lifecycle completion lease was rejected");
      }
      return Object.freeze({
        workspaceId: claim.workspaceId,
        projectId: claim.projectId,
        action: claim.action,
        generation: claim.generation,
      });
    } catch (error) {
      await this.runtimes.failLifecycle(claim).catch(() => undefined);
      throw error;
    }
  }

  private async compactAndPause(claim: RuntimeLifecycleClaim): Promise<boolean> {
    const settings = await this.repository.readAgentSettings();
    if (settings) {
      const context = await this.service.readContext(claim.workspaceId, claim.projectId);
      const roles = await this.runtimes.sessionRoles(claim.workspaceId, claim.projectId, claim.generation);
      for (const role of roles) {
        if (!await this.runtimes.lifecycleClaimActive(claim)) return false;
        try {
          await this.service.turn({
            workspaceId: claim.workspaceId,
            projectId: claim.projectId,
            role,
            mode: "COMPACT",
            prompt: "Create a concise structured session summary for durable restoration. Preserve decisions, open work, source checkpoints, test evidence, and handoffs. Do not start new work or change project state.",
            responseLanguage: context.language,
            settings,
            sourceRevision: context.source?.revision ?? null,
            sourceRelativePath: context.source?.relativePath ?? null,
            lifecycleLeaseToken: claim.leaseToken,
          });
        } catch {
          // The last valid context is authoritative. A failed summary must never
          // keep an idle Runtime consuming memory indefinitely.
        }
      }
    }
    if (!await this.runtimes.lifecycleClaimActive(claim)) return false;
    await this.service.pauseRuntime(control(claim));
    return true;
  }

  private async destroy(claim: RuntimeLifecycleClaim): Promise<void> {
    if (claim.containerId) await this.service.destroyRuntime(control(claim));
  }
}

function control(claim: RuntimeLifecycleClaim) {
  return Object.freeze({
    schemaVersion: PROJECT_RUNTIME_SCHEMA,
    workspaceId: claim.workspaceId,
    projectId: claim.projectId,
    runtime: claim.runtime,
    generation: claim.generation,
    fencingToken: claim.fencingToken,
  });
}
