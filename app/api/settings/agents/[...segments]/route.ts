import { POST as localAdminPost, PUT as localAdminPut } from "@/app/api/admin/[...segments]/route";
import { assertAllowedBodyFields, bodyObject, json } from "@/lib/control-plane/http";
import { forwardScopedAgentRequest, localAdminRequest, rewrittenJsonRequest, scopedAccessProblem } from "@/lib/admin/scoped-agent-proxy";
import { tenantAgentPrincipal } from "@/lib/admin/scoped-agent-access";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

type Context = { params: Promise<{ segments: string[] }> };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const TENANT_PROFILE_DRAFT_FIELDS = Object.freeze([
  "agent", "installationId", "credentialVersionId", "baseUrl", "authentication",
  "primaryModel", "planningModel", "smallFastModel", "subagentModel",
  "inputUsdPerMillionTokens", "outputUsdPerMillionTokens",
  "dataRegion", "retentionPolicy", "trainingPolicy",
  "maxBudgetUsd", "maxTurns", "timeoutSeconds", "fallbackProfileRevisionId",
]);

export async function POST(request: Request, context: Context) {
  try {
    const principal = await tenantAgentPrincipal(request);
    if (principal.role === "Auditor") return forbidden();
    const { segments } = await context.params;
    const key = segments.join("/");
    const body = await bodyObject(request);
    let downstream: string;
    let forced = body;
    if (key === "credentials") {
      assertAllowedBodyFields(body, ["label", "apiKey"]);
      downstream = "/admin/credentials";
    }
    else if (key === "profiles") {
      assertAllowedBodyFields(body, TENANT_PROFILE_DRAFT_FIELDS);
      downstream = "/admin/agent-profiles";
      forced = { ...body, scope: "tenant", scopeId: principal.tenantId };
    } else if (segments.length === 3 && segments[0] === "profiles" && ID.test(segments[1] ?? "") && segments[2] === "validate") {
      assertAllowedBodyFields(body, []);
      downstream = `/admin/agent-profiles/${segments[1]}/validate`;
      forced = {};
    } else return notFound();
    const rewritten = rewrittenJsonRequest(request, forced);
    if (isLoopbackTestRequest(request)) {
      const localPath = downstream.slice("/admin/".length).split("/");
      return localAdminPost(localAdminRequest(rewritten, downstream, "TenantAdmin", forced), { params: Promise.resolve({ segments: localPath }) });
    }
    return forwardScopedAgentRequest(rewritten, downstream, principal);
  } catch (error) { return scopedAccessProblem(error); }
}

export async function PUT(request: Request, context: Context) {
  try {
    const principal = await tenantAgentPrincipal(request);
    if (principal.role === "Auditor") return forbidden();
    const { segments } = await context.params;
    if (segments.length !== 1 || segments[0] !== "default") return notFound();
    const body = await bodyObject(request);
    assertAllowedBodyFields(body, ["profileRevisionId"]);
    const forced = { profileRevisionId: body.profileRevisionId };
    const downstream = `/admin/agent-defaults/tenant:${principal.tenantId}`;
    const rewritten = rewrittenJsonRequest(request, forced);
    if (isLoopbackTestRequest(request)) {
      return localAdminPut(localAdminRequest(rewritten, downstream, "TenantAdmin", forced), {
        params: Promise.resolve({ segments: downstream.slice("/admin/".length).split("/") }),
      });
    }
    return forwardScopedAgentRequest(rewritten, downstream, principal);
  } catch (error) { return scopedAccessProblem(error); }
}

function forbidden(): Response { return json({ error: { code: "FORBIDDEN", message: "审计账号只能查看配置。" } }, { status: 403 }); }
function notFound(): Response { return json({ error: { code: "AGENT_SETTINGS_ROUTE_NOT_FOUND", message: "该租户 Agent 配置操作未开放。" } }, { status: 404 }); }
