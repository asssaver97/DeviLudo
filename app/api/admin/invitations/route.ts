import { identityAdminBrokerFromEnvironment } from "@/lib/auth/identity-broker";
import { requireInvitationTenant, verifyTrustedPlatformAdmin } from "@/lib/admin/trusted-principal";
import { trustedGitHubSessionKeyFromEnvironment, verifyBrowserSession } from "@/lib/connections/github-broker";
import { bodyObject, json } from "@/lib/control-plane/http";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

type InviteRole = "TenantAdmin" | "ProjectOwner" | "Auditor";

export async function POST(request: Request) {
  if (isLoopbackTestRequest(request)) {
    return json({ error: { code: "IDENTITY_ADMIN_BROKER_REQUIRED", message: "本地测试站不会签发可用的生产邀请；部署 Identity Broker 后再操作。" } }, { status: 503 });
  }
  if (!browserMutationIsSameOrigin(request)) {
    return json({ error: { code: "CROSS_ORIGIN_MUTATION_REJECTED", message: "浏览器邀请操作必须来自当前站点。" } }, { status: 403 });
  }
  const broker = identityAdminBrokerFromEnvironment();
  if (!broker) return json({ error: { code: "IDENTITY_ADMIN_BROKER_REQUIRED", message: "Identity Broker 尚未配置。" } }, { status: 503 });
  let body: Record<string, unknown>;
  try { body = await bodyObject(request); }
  catch { return invalid(); }
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["expiresAt", "role", "tenantId"])) return invalid();
  let tenantId: string; let role: InviteRole; let expiresAt: string;
  try {
    tenantId = requireInvitationTenant(body.tenantId);
    role = inviteRole(body.role);
    expiresAt = invitationExpiry(body.expiresAt);
  } catch { return invalid(); }

  let actorId: string;
  try {
    let tenantActor: string | null = null;
    if (request.headers.get("cookie")) try {
      const principal = await verifyBrowserSession(request, trustedGitHubSessionKeyFromEnvironment());
      if (principal.role === "TenantAdmin" && principal.tenantId === tenantId && role !== "TenantAdmin") tenantActor = principal.userId;
    } catch { /* a platform-admin assertion may be present instead */ }
    actorId = tenantActor ?? (await verifyTrustedPlatformAdmin(request)).actorId;
  } catch {
    return json({ error: { code: "INVITATION_ADMIN_REQUIRED", message: "需要平台管理员，或当前租户的 TenantAdmin 会话。" } }, { status: 403 });
  }

  try {
    const invitation = await broker.createInvitation({ tenantId, role, expiresAt, createdBy: actorId });
    const invitationUrl = new URL("/api/auth/github", request.url);
    invitationUrl.searchParams.set("invite", invitation.invitationToken);
    return json({ data: { invitationId: invitation.invitationId, invitationUrl: invitationUrl.href,
      tenantId, role, expiresAt: invitation.expiresAt, displayOnce: true } }, { status: 201,
      headers: { "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" } });
  } catch {
    return json({ error: { code: "INVITATION_ISSUANCE_FAILED", message: "邀请未签发；请检查租户状态和 Identity Broker 健康。" } }, { status: 502 });
  }
}

function inviteRole(value: unknown): InviteRole { if (value !== "TenantAdmin" && value !== "ProjectOwner" && value !== "Auditor") throw new Error(); return value; }
function invitationExpiry(value: unknown): string {
  if (typeof value !== "string") throw new Error(); const date = new Date(value); const now = Date.now();
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now + 5 * 60_000 || date.getTime() > now + 7 * 24 * 60 * 60_000) throw new Error();
  return date.toISOString();
}
function browserMutationIsSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin && !request.headers.has("cookie")) return true;
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}
function invalid(): Response { return json({ error: { code: "INVALID_INVITATION", message: "租户、角色或有效期无效；有效期须在 5 分钟到 7 天之间。" } }, { status: 400 }); }
