import { json } from "@/lib/control-plane/http";
import { trustedGitHubSessionKeyFromEnvironment, verifyTrustedPlatformSession } from "@/lib/connections/github-broker";
import { projectRepositoryBrokerFromEnvironment } from "@/lib/projects/repository-broker";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  if (!UUID.test(projectId)) return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效。" } }, { status: 400 });
  let broker: NonNullable<ReturnType<typeof projectRepositoryBrokerFromEnvironment>>;
  let sessionKey: Uint8Array;
  try {
    const configured = projectRepositoryBrokerFromEnvironment();
    if (!configured) return required();
    broker = configured;
    sessionKey = trustedGitHubSessionKeyFromEnvironment();
  } catch { return required(); }
  let principal: Awaited<ReturnType<typeof verifyTrustedPlatformSession>>;
  try { principal = await verifyTrustedPlatformSession(request, sessionKey); }
  catch { return json({ error: { code: "TRUSTED_SESSION_REQUIRED", message: "需要有效的平台会话。" } }, { status: 401 }); }
  try {
    const project = await broker.project({ tenantId: principal.tenantId, userId: principal.userId, githubUserId: principal.githubUserId }, projectId);
    return project
      ? json({ data: project })
      : json({ error: { code: "PROJECT_NOT_FOUND", message: "项目不存在或当前账号无权访问。" } }, { status: 404 });
  } catch {
    return json({ error: { code: "PROJECT_LOOKUP_UNAVAILABLE", message: "暂时无法读取项目。" } }, { status: 502 });
  }
}

function required(): Response {
  return json({ error: { code: "PROJECT_REPOSITORY_BROKER_REQUIRED", message: "生产项目读取需要独立的项目仓库 Broker。" } }, { status: 503 });
}
