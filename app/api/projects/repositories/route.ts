import { json } from "@/lib/control-plane/http";
import { trustedGitHubSessionKeyFromEnvironment, verifyTrustedPlatformSession } from "@/lib/connections/github-broker";
import { projectRepositoryBrokerFromEnvironment } from "@/lib/projects/repository-broker";
import { localRepositoryCatalog } from "@/lib/projects/local-project-catalog";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";
import { LocalGitHubRuntimeClient, localGitHubImportEnabled } from "@/lib/connections/local-github-runtime";

export async function GET(request: Request) {
  if (localGitHubImportEnabled(request)) {
    try { return json({ data: await new LocalGitHubRuntimeClient().repositories(), meta: { mode: "LOCAL_GITHUB" } }); }
    catch { return json({ error: { code: "REPOSITORY_CATALOG_UNAVAILABLE", message: "暂时无法读取 GitHub App 可见仓库。" } }, { status: 502 }); }
  }
  if (isLoopbackTestRequest(request)) {
    return json({ data: localRepositoryCatalog(), meta: { mode: "LOCAL_FIXTURE" } });
  }
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
    return json({ data: await broker.catalog({ tenantId: principal.tenantId, userId: principal.userId, githubUserId: principal.githubUserId }) });
  } catch {
    return json({ error: { code: "REPOSITORY_CATALOG_UNAVAILABLE", message: "暂时无法读取 GitHub App 可见仓库。" } }, { status: 502 });
  }
}

function required(): Response { return json({ error: { code: "PROJECT_REPOSITORY_BROKER_REQUIRED", message: "生产仓库目录需要独立的项目仓库 Broker。" } }, { status: 503 }); }
