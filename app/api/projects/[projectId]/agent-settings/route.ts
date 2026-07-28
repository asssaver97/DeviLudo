import { GET as localAdminGet, PUT as localAdminPut } from "@/app/api/admin/[...segments]/route";
import { assertAllowedBodyFields, bodyObject, json } from "@/lib/control-plane/http";
import { projectAgentPrincipal } from "@/lib/admin/scoped-agent-access";
import { forwardScopedAgentRequest, localAdminRequest, rewrittenJsonRequest, scopedAccessProblem } from "@/lib/admin/scoped-agent-proxy";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";
import { platformManagedConfiguration } from "@/lib/config/platform-managed";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const principal = await projectAgentPrincipal(request, projectId);
    if (isLoopbackTestRequest(request)) {
      const response = await localAdminGet(localAdminRequest(request, "/admin/agents", principal.role, undefined, principal), {
        params: Promise.resolve({ segments: ["agents"] }),
      });
      return platformManagedConfiguration() ? platformManagedProjectProjection(response) : response;
    }
    const response = await forwardScopedAgentRequest(request, "/admin/agents", principal);
    return platformManagedConfiguration() ? platformManagedProjectProjection(response) : response;
  } catch (error) { return scopedAccessProblem(error); }
}

async function platformManagedProjectProjection(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const payload = await response.json() as { data?: unknown; meta?: unknown };
  const source = record(Array.isArray(payload.data) ? payload.meta : payload.data);
  const data = records(Array.isArray(payload.data) ? payload.data : source.catalog).map(agentCatalogProjection);
  const profiles = records(source.profiles).map((profile) => ({
    id: profile.id,
    agent: profile.agent,
    scope: profile.scope,
    scopeId: profile.scopeId,
    state: profile.state,
    providerRevisionId: profile.providerRevisionId,
    budget: profile.budget,
    fallbackProfileRevisionId: profile.fallbackProfileRevisionId ?? null,
  }));
  const providers = records(source.providers).map((provider) => ({
    id: provider.id,
    agent: provider.agent,
    protocol: provider.protocol,
    models: provider.models,
    state: provider.state,
  }));
  const projection = { profiles, providers, defaults: record(source.defaults), configurationOwnership: "platform" };
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(Array.isArray(payload.data) ? { data, meta: projection } : { data: { ...projection, catalog: data } }), {
    status: response.status,
    headers,
  });
}

function agentCatalogProjection(value: Record<string, unknown>) {
  return {
    id: value.id,
    name: value.name,
    vendor: value.vendor,
    capabilities: value.capabilities,
    supportedWorkers: value.supportedWorkers,
    default: value.default,
  };
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
