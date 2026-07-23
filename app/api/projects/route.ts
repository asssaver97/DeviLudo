import { bodyObject, idempotencyKey, json } from "@/lib/control-plane/http";
import { trustedGitHubSessionKeyFromEnvironment, verifyTrustedPlatformSession } from "@/lib/connections/github-broker";
import { ProjectRepositoryBrokerError, projectRepositoryBrokerFromEnvironment } from "@/lib/projects/repository-broker";
import {
  createLocalProject,
  listLocalProjects,
  LocalProjectCatalogError,
} from "@/lib/projects/local-project-catalog";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function GET(request: Request) {
  if (isLoopbackTestRequest(request)) {
    return json({
      data: await listLocalProjects(),
      meta: { mode: "LOCAL_FIXTURE", authoritativeSource: "loopback-local-project-catalog" },
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
  if (isLoopbackTestRequest(request)) return createLocal(request);
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

async function createLocal(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  let requestKey: string;
  try {
    body = await bodyObject(request);
    requestKey = idempotencyKey(request);
  } catch {
    return json({ error: { code: "INVALID_PROJECT_CREATION", message: "本地项目创建请求格式无效。" } }, { status: 400 });
  }
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["installationId", "name", "repositoryId", "slug"])
    || typeof body.slug !== "string" || typeof body.name !== "string"
    || typeof body.installationId !== "string" || !Number.isSafeInteger(body.repositoryId)) {
    return json({ error: { code: "INVALID_PROJECT_CREATION", message: "本地项目创建请求格式无效。" } }, { status: 400 });
  }
  try {
    const result = await createLocalProject({
      slug: body.slug,
      name: body.name,
      installationId: body.installationId,
      repositoryId: body.repositoryId as number,
    }, requestKey);
    return json({ data: result.project, meta: { mode: "LOCAL_FIXTURE", idempotentReplay: result.replayed } }, {
      status: result.replayed ? 200 : 201,
    });
  } catch (error) {
    const code = error instanceof LocalProjectCatalogError ? error.code : "PROJECT_CATALOG_UNAVAILABLE";
    if (code === "INVALID_PROJECT") {
      return json({ error: { code: "INVALID_PROJECT_CREATION", message: "项目名称、标识或本地仓库选择无效。" } }, { status: 400 });
    }
    if (code === "IDEMPOTENCY_CONFLICT") {
      return json({ error: { code: "PROJECT_CREATION_IDEMPOTENCY_CONFLICT", message: "该操作键已用于不同的项目创建请求。" } }, { status: 409 });
    }
    if (code === "PROJECT_CONFLICT") {
      return json({ error: { code: "PROJECT_CREATION_CONFLICT", message: "项目标识已经存在。" } }, { status: 409 });
    }
    if (code === "PROJECT_LIMIT_REACHED") {
      return json({ error: { code: "LOCAL_PROJECT_LIMIT_REACHED", message: "本地测试项目数量已达到上限。" } }, { status: 409 });
    }
    return json({ error: { code: "PROJECT_CATALOG_UNAVAILABLE", message: "本地项目目录暂时不可用。" } }, { status: 503 });
  }
}

function required(operation: "读取" | "创建"): Response {
  return json({ error: { code: "PROJECT_REPOSITORY_BROKER_REQUIRED", message: `生产项目${operation}需要独立的项目仓库 Broker。` } }, { status: 503 });
}
