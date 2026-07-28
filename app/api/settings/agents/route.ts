import { GET as localAdminGet } from "@/app/api/admin/[...segments]/route";
import { forwardScopedAgentRequest, localAdminRequest, scopedAccessProblem } from "@/lib/admin/scoped-agent-proxy";
import { tenantAgentPrincipal } from "@/lib/admin/scoped-agent-access";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";
import { platformManagedConfiguration } from "@/lib/config/platform-managed";
import { json } from "@/lib/control-plane/http";

export async function GET(request: Request) {
  if (platformManagedConfiguration()) return managedByPlatform();
  try {
    const principal = await tenantAgentPrincipal(request);
    if (isLoopbackTestRequest(request)) {
      return localAdminGet(localAdminRequest(request, "/admin/agents", principal.role, undefined, principal), {
        params: Promise.resolve({ segments: ["agents"] }),
      });
    }
    return forwardScopedAgentRequest(request, "/admin/agents", principal);
  }
  catch (error) { return scopedAccessProblem(error); }
}

function managedByPlatform(): Response {
  return json({ error: { code: "PLATFORM_MANAGED_CONFIGURATION", message: "Agent Provider 与凭据由平台统一管理。" } }, { status: 404 });
}
