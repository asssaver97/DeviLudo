import { GET as localAdminGet } from "@/app/api/admin/[...segments]/route";
import { forwardScopedAgentRequest, localAdminRequest, scopedAccessProblem } from "@/lib/admin/scoped-agent-proxy";
import { tenantAgentPrincipal } from "@/lib/admin/scoped-agent-access";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function GET(request: Request) {
  if (isLoopbackTestRequest(request)) {
    return localAdminGet(localAdminRequest(request, "/admin/agents", "TenantAdmin"), {
      params: Promise.resolve({ segments: ["agents"] }),
    });
  }
  try { return forwardScopedAgentRequest(request, "/admin/agents", await tenantAgentPrincipal(request)); }
  catch (error) { return scopedAccessProblem(error); }
}
