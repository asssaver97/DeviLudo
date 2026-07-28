import { json } from "@/lib/control-plane/http";
import { getDemoStore } from "@/lib/control-plane/demo-store";
import { acquireLocalAdminState } from "@/lib/control-plane/local-admin-state";
import {
  inspectLocalProviderBindings, isLocalDevelopmentWorkerReady, reconcileLocalAgentHealth,
} from "@/lib/admin/local-agent-health";
import { checkLocalProviderBinding } from "@/lib/admin/local-provider-control";
import { evaluateLocalP0BootstrapReadiness } from "@/lib/health/local-p0-readiness";
import { evaluateProductionP0OperationalReadiness } from "@/lib/health/production-p0-readiness";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function GET(request: Request) {
  if (!isLoopbackTestRequest(request)) {
    const readiness = await evaluateProductionP0OperationalReadiness(process.env);
    return response(readiness.ready, "PRODUCTION_INTERNAL", {
      ...readiness.controlPlane.dependencies,
      p0Runtime: readiness.p0Runtime,
    });
  }
  const bootstrap = await evaluateLocalP0BootstrapReadiness();
  if (!bootstrap.ready) return response(false, "LOCAL", bootstrap.dependencies);
  let lease: Awaited<ReturnType<typeof acquireLocalAdminState>> | null = null;
  try {
    lease = await acquireLocalAdminState();
    const reconciliation = reconcileLocalAgentHealth(bootstrap.agentProbe, getDemoStore());
    const bindings = await inspectLocalProviderBindings(reconciliation.bindingCandidates, (candidate) => checkLocalProviderBinding({
      providerRevisionId: candidate.providerRevisionId,
      profileRevisionId: candidate.profileRevisionId,
      credentialVersionId: candidate.credentialVersionId,
      agent: candidate.agent,
      modelRoles: candidate.modelRoles,
    }));
    const claudeReady = bindings.some((binding) => binding.agent === "claude-code"
      && binding.state === "VERIFIED" && binding.runtimeState === "READY" && binding.selectionRole !== "FALLBACK");
    const workerReady = isLocalDevelopmentWorkerReady(bootstrap.agentProbe, reconciliation, bindings);
    return response(workerReady && claudeReady, "LOCAL", {
      ...bootstrap.dependencies,
      developmentWorker: workerReady ? "READY" : "BLOCKED",
      claudeProfile: claudeReady ? "READY" : "BLOCKED",
    });
  } catch {
    return response(false, "LOCAL", { ...bootstrap.dependencies, developmentWorker: "UNAVAILABLE", claudeProfile: "BLOCKED" });
  } finally { lease?.release(); }
}

function response(ready: boolean, mode: string, dependencies: Readonly<Record<string, unknown>>) {
  return json({
    schemaVersion: "deviludo.platform-operational-readiness.v1",
    status: ready ? "OPERATIONAL_READY" : "OPERATIONAL_BLOCKED",
    mode, ready, dependencies, time: new Date().toISOString(),
  }, { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } });
}
