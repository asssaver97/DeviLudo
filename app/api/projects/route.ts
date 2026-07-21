import { bodyObject, idempotencyKey, json } from "@/lib/control-plane/http";
import { trustedGitHubSessionKeyFromEnvironment, verifyTrustedPlatformSession } from "@/lib/connections/github-broker";
import { ProjectRepositoryBrokerError, projectRepositoryBrokerFromEnvironment } from "@/lib/projects/repository-broker";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function GET(request: Request) {
  if (isLoopbackTestRequest(request)) {
    return json({
      data: [{
        projectId: "ember-archipelago",
        tenantId: "tenant-local",
        slug: "ember-archipelago",
        name: "余烬群岛",
        repositoryBindingId: "local-fixture-binding",
        installationId: "9001",
        repositoryId: 7001,
        repositoryNodeId: "LOCAL_R_ember_archipelago",
        owner: "north-dock",
        repositoryName: "ember-archipelago",
        defaultBranch: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
      meta: { mode: "LOCAL_FIXTURE", authoritativeSource: "loopback-control-plane" },
    });
  }
  let broker: NonNullable<ReturnType<typeof projectRepositoryBrokerFromEnvironment>>;
  let sessionKey: Uint8Array;
  try {
    const configured = projectRepositoryBrokerFromEnvironment();
    if (!configured) return required("读取");
    broker = configured;
    sessionKey = trustedGitHubSessionKeyFromEnvironment();
  } catch { return required("读取"); }
  let principal: Awaited<ReturnType<typeof verifyTrustedPlatformSession>>;
  try { principal = await verifyTrustedPlatformSession(request, sessionKey); }
  catch { return json({ error: { code: "TRUSTED_SESSION_REQUIRED", message: "需要有效的平台会话。" } }, { status: 401 }); }
  try {
    const projects = await broker.projects({ tenantId: principal.tenantId, userId: principal.userId, githubUserId: principal.githubUserId });
    return json({ data: projects, meta: { mode: "PRODUCTION", authoritativeSource: "project-repository-broker" } });
  } catch {
    return json({ error: { code: "PROJECT_CATALOG_UNAVAILABLE", message: "暂时无法读取项目目录。" } }, { status: 502 });
  }
}

export async function POST(request: Request) {
  let broker: NonNullable<ReturnType<typeof projectRepositoryBrokerFromEnvironment>>;
  let sessionKey: Uint8Array;
  try {
    const configured = projectRepositoryBrokerFromEnvironment();
    if (!configured) return required("创建");
    broker = configured;
    sessionKey = trustedGitHubSessionKeyFromEnvironment();
  } catch { return required("创建"); }
  let principal: Awaited<ReturnType<typeof verifyTrustedPlatformSession>>;
  try { principal = await verifyTrustedPlatformSession(request, sessionKey); }
  catch { return json({ error: { code: "TRUSTED_SESSION_REQUIRED", message: "需要有效的平台会话。" } }, { status: 401 }); }
  let body: Record<string, unknown>;
  let requestKey: string;
  try {
    body = await bodyObject(request);
    requestKey = idempotencyKey(request);
  } catch {
    return json({ error: { code: "INVALID_PROJECT_CREATION", message: "项目创建请求格式无效。" } }, { status: 400 });
  }
  try {
    if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["installationId", "name", "repositoryId", "slug"])) {
      return json({ error: { code: "INVALID_PROJECT_CREATION", message: "项目创建请求格式无效。" } }, { status: 400 });
    }
    if (typeof body.slug !== "string" || typeof body.name !== "string"
      || typeof body.installationId !== "string" || !Number.isSafeInteger(body.repositoryId)) {
      return json({ error: { code: "INVALID_PROJECT_CREATION", message: "项目创建请求格式无效。" } }, { status: 400 });
    }
    const receipt = await broker.create({
      principal: { tenantId: principal.tenantId, userId: principal.userId, githubUserId: principal.githubUserId },
      slug: body.slug, name: body.name, installationId: body.installationId,
      repositoryId: body.repositoryId as number, idempotencyKey: requestKey,
    });
    return json({ data: receipt }, { status: 201 });
  } catch (error) {
    const brokerStatus = error instanceof ProjectRepositoryBrokerError ? error.status : 502;
    const conflict = brokerStatus === 409;
    const rejected = brokerStatus === 400;
    return json({
      error: {
        code: conflict ? "PROJECT_CREATION_CONFLICT" : "PROJECT_CREATION_REJECTED",
        message: conflict ? "项目标识或仓库已被绑定。" : "项目创建未通过权威仓库校验。",
      },
    }, { status: conflict ? 409 : rejected ? 400 : 502 });
  }
}

function required(operation: "读取" | "创建"): Response {
  return json({ error: { code: "PROJECT_REPOSITORY_BROKER_REQUIRED", message: `生产项目${operation}需要独立的项目仓库 Broker。` } }, { status: 503 });
}
