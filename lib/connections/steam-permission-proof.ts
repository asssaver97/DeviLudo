const REQUIRED_PERMISSIONS = Object.freeze(["EditAppMetadata", "PublishAppChanges"] as const);
const ACCOUNT_NAME = /^[A-Za-z0-9_-]{3,64}$/;
const APP_ID = /^[1-9][0-9]{0,19}$/;
const MAX_SESSION_MS = 180 * 24 * 60 * 60_000;

export interface SteamLeastPrivilegeProof {
  readonly accountName: string;
  readonly allowedAppIds: readonly string[];
  readonly permissions: typeof REQUIRED_PERMISSIONS;
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

/**
 * Treats the Broker projection as a permission proof only when its complete,
 * exact allow-list is present. This intentionally proves the publishing
 * session exposed to DeviLudo, not every privilege held by the Steam account.
 */
export function steamLeastPrivilegeProof(value: unknown, nowMs = Date.now()): SteamLeastPrivilegeProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isFinite(nowMs)) return null;
  const status = value as Record<string, unknown>;
  if (status.state !== "READY" || typeof status.accountName !== "string" || !ACCOUNT_NAME.test(status.accountName)) return null;
  if (!Array.isArray(status.allowedAppIds) || status.allowedAppIds.length < 1 || status.allowedAppIds.length > 100
    || status.allowedAppIds.some((appId) => typeof appId !== "string" || !APP_ID.test(appId))
    || new Set(status.allowedAppIds).size !== status.allowedAppIds.length) return null;
  const permissions = status.permissions;
  if (!Array.isArray(permissions) || permissions.length !== REQUIRED_PERMISSIONS.length
    || new Set(permissions).size !== REQUIRED_PERMISSIONS.length
    || REQUIRED_PERMISSIONS.some((permission) => !permissions.includes(permission))) return null;
  if (typeof status.verifiedAt !== "string" || typeof status.expiresAt !== "string") return null;
  const verifiedAt = Date.parse(status.verifiedAt);
  const expiresAt = Date.parse(status.expiresAt);
  if (!Number.isFinite(verifiedAt) || verifiedAt > nowMs + 5 * 60_000
    || !Number.isFinite(expiresAt) || expiresAt <= nowMs || expiresAt > nowMs + MAX_SESSION_MS) return null;
  return Object.freeze({
    accountName: status.accountName,
    allowedAppIds: Object.freeze([...status.allowedAppIds] as string[]),
    permissions: REQUIRED_PERMISSIONS,
    verifiedAt: new Date(verifiedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });
}
