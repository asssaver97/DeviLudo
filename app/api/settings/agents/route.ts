import { GET as localAdminGet } from "@/app/api/admin/[...segments]/route";
import { forwardScopedAgentRequest, localAdminRequest, scopedAccessProblem } from "@/lib/admin/scoped-agent-proxy";
import { tenantAgentPrincipal } from "@/lib/admin/scoped-agent-access";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function GET(request: Request) {
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
