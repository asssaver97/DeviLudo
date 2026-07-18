import type { ControlPlaneAdminPrincipal } from "@/lib/admin/control-plane-broker";
import { trustedGitHubSessionKeyFromEnvironment, verifyBrowserSession } from "@/lib/connections/github-broker";
import { projectRepositoryBrokerFromEnvironment } from "@/lib/projects/repository-broker";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const LOCAL_PROJECT = /^[a-z0-9][a-z0-9-]{0,99}$/;

export class ScopedAgentAccessProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function tenantAgentPrincipal(request: Request): Promise<ControlPlaneAdminPrincipal> {
  if (isLoopbackTestRequest(request)) return Object.freeze({
    role: "TenantAdmin", actorId: "user-local", sessionId: "local-tenant-agent-settings",
    tenantId: "tenant-local", projectId: null,
  });
  const session = await browserPrincipal(request);
  if (session.role !== "TenantAdmin" && session.role !== "Auditor") {
    throw new ScopedAgentAccessProblem(403, "TENANT_AGENT_FORBIDDEN", "当前账号不能管理租户 Agent 配置。");
  }
  return Object.freeze({
    role: session.role, actorId: session.userId, sessionId: session.sessionBinding,
    tenantId: session.tenantId, projectId: null,
  });
}

export async function projectAgentPrincipal(
  request: Request,
  projectId: string,
): Promise<ControlPlaneAdminPrincipal> {
  if (isLoopbackTestRequest(request)) {
    if (!LOCAL_PROJECT.test(projectId)) invalidProject();
    return Object.freeze({
      role: "ProjectOwner", actorId: "user-local", sessionId: "local-project-agent-settings",
      tenantId: "tenant-local", projectId,
    });
  }
  if (!UUID.test(projectId)) invalidProject();
  const session = await browserPrincipal(request);
  if (session.role !== "ProjectOwner" && session.role !== "Auditor") {
    throw new ScopedAgentAccessProblem(403, "PROJECT_AGENT_FORBIDDEN", "当前账号不能管理项目 Agent 配置。");
  }
  const broker = projectRepositoryBrokerFromEnvironment();
  if (!broker) {
    throw new ScopedAgentAccessProblem(503, "PROJECT_REPOSITORY_BROKER_REQUIRED", "项目权限校验服务尚未配置。");
  }
  let project;
  try {
    project = await broker.project({
      tenantId: session.tenantId,
      userId: session.userId,
      githubUserId: session.githubUserId,
    }, projectId);
  } catch {
    throw new ScopedAgentAccessProblem(502, "PROJECT_AUTHORITY_UNAVAILABLE", "暂时无法校验项目权限。");
  }
  if (!project) {
    throw new ScopedAgentAccessProblem(404, "PROJECT_NOT_FOUND", "项目不存在或当前账号无权访问。");
  }
  return Object.freeze({
    role: session.role, actorId: session.userId, sessionId: session.sessionBinding,
    tenantId: project.tenantId, projectId: project.projectId,
  });
}

async function browserPrincipal(request: Request) {
  try { return await verifyBrowserSession(request, trustedGitHubSessionKeyFromEnvironment()); }
  catch { throw new ScopedAgentAccessProblem(401, "AUTHENTICATION_REQUIRED", "需要有效的受邀 GitHub 会话。"); }
}

function invalidProject(): never {
  throw new ScopedAgentAccessProblem(400, "INVALID_PROJECT", "项目标识无效。");
}
