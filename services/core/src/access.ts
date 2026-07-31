import type { FastifyRequest } from "fastify";
import type { UserRecord, WorkspaceRole, WorkspaceSummary } from "@/lib/product/contracts";
import type { CoreConfig } from "./config";

export const STANDALONE_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
export const STANDALONE_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";

export type AccessPrincipal = Readonly<{
  id: string;
  user: UserRecord;
  workspace: WorkspaceSummary;
  role: WorkspaceRole;
  csrfHash: string | null;
  expiresAt: string | null;
  platformAdminRoles: readonly string[];
}>;

export class AccessResolver {
  private readonly cache = new Map<string, Readonly<{ expiresAt: number; principal: AccessPrincipal }>>();

  constructor(private readonly config: CoreConfig) {}

  async resolve(request: FastifyRequest, forceRefresh = false): Promise<AccessPrincipal> {
    if (this.config.accessMode === "standalone") return standalonePrincipal();
    const token = platformSessionToken(request.headers.cookie);
    if (!token) throw accessError(401, "UNAUTHORIZED", "请先登录 DeviLudo Platform");
    const cached = this.cache.get(token);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.principal;
    const principal = await this.assertPlatformSession(token);
    this.cache.set(token, Object.freeze({ expiresAt: Date.now() + 30_000, principal }));
    return principal;
  }

  private async assertPlatformSession(sessionToken: string): Promise<AccessPrincipal> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${this.config.platformAccountApiUrl}/internal/v1/sessions/assert`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.platformInternalToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionToken }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw accessError(401, "PLATFORM_SESSION_INVALID", "Platform 会话已失效");
      }
      if (!response.ok) throw accessError(503, "PLATFORM_UNAVAILABLE", "Platform 账号服务暂时不可用");
      return platformPrincipal(await response.json());
    } catch (error) {
      if (isAccessError(error)) throw error;
      throw accessError(503, "PLATFORM_UNAVAILABLE", "Platform 账号服务暂时不可用");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function standalonePrincipal(): AccessPrincipal {
  return Object.freeze({
    id: "standalone",
    user: Object.freeze({
      id: STANDALONE_ACCOUNT_ID,
      username: "Local operator",
      instanceAdmin: true,
      createdAt: "1970-01-01T00:00:00.000Z",
    }),
    workspace: Object.freeze({
      id: STANDALONE_WORKSPACE_ID,
      name: "Local workspace",
      createdAt: "1970-01-01T00:00:00.000Z",
    }),
    role: "OWNER",
    csrfHash: null,
    expiresAt: null,
    platformAdminRoles: Object.freeze(["PlatformAgentAdmin", "SecurityAdmin"]),
  });
}

function platformPrincipal(value: unknown): AccessPrincipal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Platform assertion");
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Platform assertion");
  const assertion = data as Record<string, unknown>;
  const source = assertion.principal;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Invalid Platform principal");
  const item = source as Record<string, unknown>;
  for (const key of ["accountId", "displayName", "workspaceId", "workspaceName", "role", "sessionId"] as const) {
    if (typeof item[key] !== "string" || item[key].length < 1) throw new Error("Invalid Platform principal");
  }
  if (!UUID.test(String(item.accountId)) || !UUID.test(String(item.workspaceId))) throw new Error("Invalid Platform principal");
  const role = coreRole(String(item.role));
  const platformAdminRoles = Array.isArray(assertion.platformAdminRoles)
    ? assertion.platformAdminRoles.filter((entry): entry is string => typeof entry === "string")
    : [];
  return Object.freeze({
    id: String(item.sessionId),
    user: Object.freeze({
      id: String(item.accountId),
      username: String(item.displayName),
      instanceAdmin: platformAdminRoles.includes("PlatformAgentAdmin"),
      createdAt: "",
    }),
    workspace: Object.freeze({ id: String(item.workspaceId), name: String(item.workspaceName), createdAt: "" }),
    role,
    csrfHash: null,
    expiresAt: null,
    platformAdminRoles: Object.freeze(platformAdminRoles),
  });
}

function coreRole(role: string): WorkspaceRole {
  if (role === "Owner") return "OWNER";
  if (role === "Admin") return "ADMIN";
  return "MEMBER";
}

function platformSessionToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const item of header.split(";")) {
    const [name, ...parts] = item.trim().split("=");
    if (name === "__Host-deviludo-session" || name === "deviludo-session") return parts.join("=") || null;
  }
  return null;
}

function accessError(statusCode: number, code: string, message: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode, code });
}

function isAccessError(value: unknown): value is Error & { statusCode: number } {
  return value instanceof Error && "statusCode" in value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
