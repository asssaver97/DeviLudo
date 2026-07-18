import { trustedGitHubSessionKeyFromEnvironment, verifyBrowserSession } from "@/lib/connections/github-broker";
import { BROWSER_BINDING_COOKIE, SESSION_COOKIE, browserSessionCookies, clearCookie, identityBrokerFromEnvironment } from "@/lib/auth/identity-broker";
import { json } from "@/lib/control-plane/http";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function GET(request: Request) {
  if (isLoopbackTestRequest(request)) return json({ data: localPrincipal() }, { headers: { "cache-control": "no-store" } });
  try {
    const principal = await verifyBrowserSession(request, trustedGitHubSessionKeyFromEnvironment());
    return json({ data: publicPrincipal(principal) }, { headers: { "cache-control": "no-store" } });
  } catch { return json({ error: { code: "AUTHENTICATION_REQUIRED", message: "需要使用受邀 GitHub 账号登录。" } }, { status: 401, headers: { "cache-control": "no-store" } }); }
}

export async function DELETE(request: Request) {
  if (!isLoopbackTestRequest(request)) {
    try {
      const broker = identityBrokerFromEnvironment(); if (broker) await broker.revoke(browserSessionCookies(request));
    } catch { /* clearing the browser credential remains safe and idempotent */ }
  }
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", clearCookie(SESSION_COOKIE)); headers.append("set-cookie", clearCookie(BROWSER_BINDING_COOKIE));
  return new Response(null, { status: 204, headers });
}

function publicPrincipal(value: Awaited<ReturnType<typeof verifyBrowserSession>>) {
  return { tenantId: value.tenantId, tenantSlug: value.tenantSlug, tenantName: value.tenantName, userId: value.userId,
    role: value.role, githubUserId: value.githubUserId, githubLogin: value.githubLogin, displayName: value.displayName,
    avatarUrl: value.avatarUrl };
}
function localPrincipal() {
  return { tenantId: "tenant-local", tenantSlug: "north-dock", tenantName: "North Dock", userId: "user-local",
    role: "TenantAdmin", githubUserId: 1, githubLogin: "local-developer", displayName: "本地开发者", avatarUrl: null };
}
