// Asset manifest and item types for parallel asset generation

export const ASSET_MANIFEST_SCHEMA_VERSION = "deviludo.asset-manifest.v1" as const;

export const ASSET_TYPES = ["sprite", "animation", "background", "ui", "icon", "tileset"] as const;
export type AssetType = typeof ASSET_TYPES[number];

export const ASSET_ITEM_STATUSES = ["planned", "generating", "generated", "uploaded", "failed"] as const;
export type AssetItemStatus = typeof ASSET_ITEM_STATUSES[number];

export const ASSET_MANIFEST_STATUSES = ["planning", "ready", "partial", "complete"] as const;
export type AssetManifestStatus = typeof ASSET_MANIFEST_STATUSES[number];

export type AssetItem = Readonly<{
  id: string;
  manifestId: string;
  assetKey: string;
  assetType: AssetType;
  description: string;
  generationPrompt?: string;
  frameCount?: number;
  dimensions?: string;
  status: AssetItemStatus;
  objectKey?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type AssetManifest = Readonly<{
  id: string;
  workspaceId: string;
  projectId: string;
  schemaVersion: typeof ASSET_MANIFEST_SCHEMA_VERSION;
  status: AssetManifestStatus;
  autoGenerateEnabled: boolean;
  plannedAt: string;
  completedAt?: string;
  items?: readonly AssetItem[];
}>;

export function validateAssetManifest(value: unknown): value is AssetManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;

  return typeof manifest.id === "string"
    && typeof manifest.workspaceId === "string"
    && typeof manifest.projectId === "string"
    && manifest.schemaVersion === ASSET_MANIFEST_SCHEMA_VERSION
    && typeof manifest.status === "string"
    && ASSET_MANIFEST_STATUSES.includes(manifest.status as AssetManifestStatus)
    && typeof manifest.autoGenerateEnabled === "boolean"
    && typeof manifest.plannedAt === "string";
}

export function validateAssetItem(value: unknown): value is AssetItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;

  return typeof item.id === "string"
    && typeof item.manifestId === "string"
    && typeof item.assetKey === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(item.assetKey)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(item.assetKey)
    && !item.assetKey.endsWith("/")
    && typeof item.assetType === "string"
    && ASSET_TYPES.includes(item.assetType as AssetType)
    && typeof item.description === "string"
    && typeof item.status === "string"
    && ASSET_ITEM_STATUSES.includes(item.status as AssetItemStatus)
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string";
}
