import { trustedGitHubSessionKeyFromEnvironment, verifyBrowserSession } from "@/lib/connections/github-broker";
import { BROWSER_BINDING_COOKIE, SESSION_COOKIE, browserSessionCookies, clearCookie, identityBrokerFromEnvironment } from "@/lib/auth/identity-broker";
import { LOCAL_SHELL_CAPABILITIES, adminShellCapabilities, tenantShellCapabilities } from "@/lib/auth/shell-capabilities";
import { verifyTrustedAdminBrowserSession } from "@/lib/admin/trusted-principal";
import { accountPlatformSessionFromRequest, type AccountPlatformSession } from "@/lib/auth/account-platform";
import { configurationOwnership, platformManagedConfiguration } from "@/lib/config/platform-managed";
import { json } from "@/lib/control-plane/http";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

const ADMIN_ASSERTION_HEADERS = [
  "x-deviludo-role",
  "x-deviludo-actor",
  "x-deviludo-admin-session",
  "x-deviludo-admin-issued-at",
  "x-deviludo-admin-signature",
] as const;

export async function GET(request: Request) {
  if (platformManagedConfiguration()) {
    try {
      const account = await accountPlatformSessionFromRequest(request);
      if (!account) return json({ error: { code: "ACCOUNT_PLATFORM_REQUIRED", message: "平台托管模式需要账号服务。" } }, { status: 503 });
      return json({ data: account.platformAdminRoles.length ? accountAdminPublicPrincipal(account) : accountPublicPrincipal(account) }, { headers: { "cache-control": "no-store" } });
    } catch {
      return json({ error: { code: "AUTHENTICATION_REQUIRED", message: "需要有效的 DeviLudo Platform 账号会话。" } }, { status: 401, headers: { "cache-control": "no-store" } });
    }
  }
  if (isLoopbackTestRequest(request)) return json({ data: localPrincipal() }, { headers: { "cache-control": "no-store" } });
  if (hasAdminAssertion(request)) {
    try {
      const principal = await verifyTrustedAdminBrowserSession(request);
      return json({ data: adminPublicPrincipal(principal) }, { headers: { "cache-control": "no-store" } });
    } catch {
      return json({ error: { code: "ADMIN_SESSION_INVALID", message: "需要有效的可信平台管理员会话。" } }, {
        status: 401, headers: { "cache-control": "no-store" },
      });
    }
  }
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
    avatarUrl: value.avatarUrl, authMode: "github-invite", canSignOut: true,
    capabilities: tenantShellCapabilities(value.role), configurationOwnership: configurationOwnership() };
}
function localPrincipal() {
  return { tenantId: "tenant-local", tenantSlug: "north-dock", tenantName: "North Dock", userId: "user-local",
    role: "TenantAdmin", githubUserId: 1, githubLogin: "local-developer", displayName: "本地开发者", avatarUrl: null,
    authMode: "local-fixture", canSignOut: false,
    capabilities: LOCAL_SHELL_CAPABILITIES, configurationOwnership: "workspace" };
}

function adminPublicPrincipal(value: Awaited<ReturnType<typeof verifyTrustedAdminBrowserSession>>) {
  return { tenantId: null, tenantSlug: "platform", tenantName: "DeviLudo Platform", userId: value.actorId,
    role: value.role, githubUserId: null, githubLogin: value.actorId, displayName: value.actorId, avatarUrl: null,
    authMode: "trusted-admin", canSignOut: false,
    capabilities: adminShellCapabilities(value.role), adminRoles: [value.role], configurationOwnership: configurationOwnership() };
}

function accountPublicPrincipal(value: AccountPlatformSession) {
  return { tenantId: value.tenantId, tenantSlug: value.tenantSlug, tenantName: value.tenantName, userId: value.userId,
    role: value.role, githubUserId: value.githubUserId, githubLogin: value.githubLinked ? `github-${value.githubUserId}` : `account-${value.userId.slice(0, 8)}`,
    displayName: value.displayName, avatarUrl: value.avatarUrl, authMode: "account-platform", canSignOut: true,
    capabilities: tenantShellCapabilities(value.role, { platformManagedConfiguration: true }), configurationOwnership: "platform" };
}

function accountAdminPublicPrincipal(value: AccountPlatformSession) {
  const role = value.platformAdminRoles[0]!;
  const capabilities = [...new Set(value.platformAdminRoles.flatMap((candidate) => adminShellCapabilities(candidate)))];
  return { tenantId: null, tenantSlug: "platform", tenantName: "DeviLudo Platform", userId: value.userId,
    role, githubUserId: value.githubUserId, githubLogin: value.githubLinked ? `github-${value.githubUserId}` : `account-${value.userId.slice(0, 8)}`,
    displayName: value.displayName, avatarUrl: value.avatarUrl, authMode: "account-platform-admin", canSignOut: true,
    capabilities, adminRoles: value.platformAdminRoles, configurationOwnership: "platform" };
}

function hasAdminAssertion(request: Request): boolean {
  return ADMIN_ASSERTION_HEADERS.some((name) => request.headers.has(name));
}
