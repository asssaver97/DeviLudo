import {
  trustedGitHubSessionKeyFromEnvironment,
  verifyTrustedPlatformSession,
  type TrustedPlatformSession,
} from "@/lib/connections/github-broker";
import { HttpProblem, json } from "@/lib/control-plane/http";
import { readLocalProject, type LocalProjectCatalogItem } from "@/lib/projects/local-project-catalog";
import { projectRepositoryBrokerFromEnvironment } from "@/lib/projects/repository-broker";

export class ProjectAccessError extends HttpProblem {
  constructor(
    status: 401 | 404 | 502 | 503,
    code: "PROJECT_ACCESS_BROKER_REQUIRED" | "PROJECT_ACCESS_SESSION_REQUIRED" | "PROJECT_ACCESS_NOT_FOUND" | "PROJECT_ACCESS_UNAVAILABLE",
    message: string,
  ) { super(status, code, message); }
}

/**
 * The localhost product uses a durable project catalog instead of GitHub.
 * Every project-scoped preview route must still resolve its exact catalog row
 * before it reads or creates specification, delivery, Runner, or evidence
 * state. A syntactically valid slug is not project authority.
 */
export async function authorizeLocalProjectAccess(projectId: string): Promise<LocalProjectCatalogItem> {
  try {
    const project = await readLocalProject(projectId);
    if (!project) {
      throw new ProjectAccessError(404, "PROJECT_ACCESS_NOT_FOUND", "本地项目不存在或当前账号无权访问。");
    }
    return project;
  } catch (error) {
    if (error instanceof ProjectAccessError) throw error;
    throw new ProjectAccessError(503, "PROJECT_ACCESS_UNAVAILABLE", "暂时无法验证本地项目访问权。");
  }
}

/**
 * Production project services are tenant-scoped internally, but every Web
 * route must first prove that this exact GitHub user can still access the
 * project's active App installation. This prevents a tenant member from using
 * a discovered UUID to read or mutate another member's project state.
 */
export async function authorizeProjectAccess(
  request: Request,
  projectId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TrustedPlatformSession> {
  let broker: NonNullable<ReturnType<typeof projectRepositoryBrokerFromEnvironment>>;
  let sessionKey: Uint8Array;
  try {
    const configured = projectRepositoryBrokerFromEnvironment(env);
    if (!configured) required();
    broker = configured;
    sessionKey = trustedGitHubSessionKeyFromEnvironment(env);
  } catch (error) {
    if (error instanceof ProjectAccessError) throw error;
    required();
  }
  let principal: TrustedPlatformSession;
  try { principal = await verifyTrustedPlatformSession(request, sessionKey); }
  catch {
    throw new ProjectAccessError(401, "PROJECT_ACCESS_SESSION_REQUIRED", "需要有效的平台项目会话。");
  }
  try {
    const project = await broker.project({
      tenantId: principal.tenantId,
      userId: principal.userId,
      githubUserId: principal.githubUserId,
    }, projectId);
    if (!project) {
      throw new ProjectAccessError(404, "PROJECT_ACCESS_NOT_FOUND", "项目不存在或当前账号无权访问。");
    }
    return principal;
  } catch (error) {
    if (error instanceof ProjectAccessError) throw error;
    throw new ProjectAccessError(502, "PROJECT_ACCESS_UNAVAILABLE", "暂时无法验证项目访问权。");
  }
}

export function projectAccessResponse(error: unknown): Response {
  if (!(error instanceof ProjectAccessError)) throw error;
  return json({ error: { code: error.code, message: error.message } }, {
    status: error.status,
    headers: { "cache-control": "no-store" },
  });
}

function required(): never {
  throw new ProjectAccessError(503, "PROJECT_ACCESS_BROKER_REQUIRED", "生产项目操作需要独立的项目仓库 Broker。");
}
