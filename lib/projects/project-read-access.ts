import {
  trustedGitHubSessionKeyFromEnvironment,
  verifyTrustedPlatformSession,
  type TrustedPlatformSession,
} from "@/lib/connections/github-broker";
import { json } from "@/lib/control-plane/http";
import { projectRepositoryBrokerFromEnvironment } from "@/lib/projects/repository-broker";

export class ProjectReadAccessError extends Error {
  constructor(
    readonly status: 401 | 404 | 502 | 503,
    readonly code: "PROJECT_ACCESS_BROKER_REQUIRED" | "PROJECT_ACCESS_SESSION_REQUIRED" | "PROJECT_ACCESS_NOT_FOUND" | "PROJECT_ACCESS_UNAVAILABLE",
    message: string,
  ) { super(message); }
}

/**
 * Production project projections are tenant-scoped internally, but the Web
 * route must first prove that this exact GitHub user can still access the
 * project's active App installation. This prevents a tenant member from using
 * a discovered UUID to read another member's project state.
 */
export async function authorizeProjectRead(
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
    if (error instanceof ProjectReadAccessError) throw error;
    required();
  }
  let principal: TrustedPlatformSession;
  try { principal = await verifyTrustedPlatformSession(request, sessionKey); }
  catch {
    throw new ProjectReadAccessError(401, "PROJECT_ACCESS_SESSION_REQUIRED", "需要有效的平台项目会话。");
  }
  try {
    const project = await broker.project({
      tenantId: principal.tenantId,
      userId: principal.userId,
      githubUserId: principal.githubUserId,
    }, projectId);
    if (!project) {
      throw new ProjectReadAccessError(404, "PROJECT_ACCESS_NOT_FOUND", "项目不存在或当前账号无权查看。");
    }
    return principal;
  } catch (error) {
    if (error instanceof ProjectReadAccessError) throw error;
    throw new ProjectReadAccessError(502, "PROJECT_ACCESS_UNAVAILABLE", "暂时无法验证项目访问权。");
  }
}

export function projectReadAccessResponse(error: unknown): Response {
  if (!(error instanceof ProjectReadAccessError)) throw error;
  return json({ error: { code: error.code, message: error.message } }, {
    status: error.status,
    headers: { "cache-control": "no-store" },
  });
}

function required(): never {
  throw new ProjectReadAccessError(503, "PROJECT_ACCESS_BROKER_REQUIRED", "生产项目读取需要独立的项目仓库 Broker。");
}
