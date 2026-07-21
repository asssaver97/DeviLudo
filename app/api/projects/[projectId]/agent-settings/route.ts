import { GET as localAdminGet, PUT as localAdminPut } from "@/app/api/admin/[...segments]/route";
import { assertAllowedBodyFields, bodyObject, json } from "@/lib/control-plane/http";
import { projectAgentPrincipal } from "@/lib/admin/scoped-agent-access";
import { forwardScopedAgentRequest, localAdminRequest, rewrittenJsonRequest, scopedAccessProblem } from "@/lib/admin/scoped-agent-proxy";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const principal = await projectAgentPrincipal(request, projectId);
    if (isLoopbackTestRequest(request)) {
      return localAdminGet(localAdminRequest(request, "/admin/agents", principal.role, undefined, principal), {
        params: Promise.resolve({ segments: ["agents"] }),
      });
    }
    return forwardScopedAgentRequest(request, "/admin/agents", principal);
  } catch (error) { return scopedAccessProblem(error); }
}

export async function PUT(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const principal = await projectAgentPrincipal(request, projectId);
    if (principal.role === "Auditor") return json({ error: { code: "FORBIDDEN", message: "审计账号只能查看配置。" } }, { status: 403 });
    const body = await bodyObject(request);
    assertAllowedBodyFields(body, ["profileRevisionId"]);
    const forced = { profileRevisionId: body.profileRevisionId };
    const downstream = `/admin/agent-defaults/project:${principal.projectId}`;
    const rewritten = rewrittenJsonRequest(request, forced);
    if (isLoopbackTestRequest(request)) {
      return localAdminPut(localAdminRequest(rewritten, downstream, "ProjectOwner", forced, principal), {
        params: Promise.resolve({ segments: downstream.slice("/admin/".length).split("/") }),
      });
    }
    return forwardScopedAgentRequest(rewritten, downstream, principal);
  } catch (error) { return scopedAccessProblem(error); }
}
