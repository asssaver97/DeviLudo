// Asset manifest reads and mutations.
//
// Assets deliberately sit outside the serial delivery chain: the Agent plans them
// while generating source, generation and upload happen asynchronously, and the
// results reach the game through an ARTIFACT_BUILD rerun. Every query here runs
// inside `withWorkspace` so the tables' forced row-level security applies.

import type { Database } from "./database";
import type {
  AssetItem,
  AssetItemStatus,
  AssetManifest,
  AssetManifestStatus,
  AssetType,
} from "@/lib/product/asset-manifest";

type AssetManifestRow = Readonly<{
  id: string;
  workspace_id: string;
  project_id: string;
  auto_generate_enabled: boolean;
  planned_at: string;
}>;

type AssetItemRow = Readonly<{
  id: string;
  manifest_id: string;
  asset_key: string;
  asset_type: string;
  description: string;
  generation_prompt: string | null;
  frame_count: string | null;
  dimensions: string | null;
  status: string;
  object_key: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}>;

const MANIFEST_COLUMNS = `id::text, workspace_id::text, project_id::text,
        auto_generate_enabled, planned_at::text`;
const ITEM_COLUMNS = `id::text, manifest_id::text, asset_key, asset_type, description,
        generation_prompt, frame_count::text, dimensions, status,
        object_key, error_message, created_at::text, updated_at::text`;

export type AssetCompletion = Readonly<{
  total: number;
  uploaded: number;
  failed: number;
  complete: boolean;
}>;

export type AssetManifestView = Readonly<{
  manifest: AssetManifest;
  items: readonly AssetItem[];
  completion: AssetCompletion;
}>;

function itemFromRow(row: AssetItemRow): AssetItem {
  return Object.freeze({
    id: row.id,
    manifestId: row.manifest_id,
    assetKey: row.asset_key,
    assetType: row.asset_type as AssetType,
    description: row.description,
    ...(row.generation_prompt ? { generationPrompt: row.generation_prompt } : {}),
    ...(row.frame_count ? { frameCount: Number(row.frame_count) } : {}),
    ...(row.dimensions ? { dimensions: row.dimensions } : {}),
    status: row.status as AssetItemStatus,
    ...(row.object_key ? { objectKey: row.object_key } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Manifest status is derived rather than stored, so it can never disagree with
 * the items it summarizes.
 */
function manifestStatus(items: readonly AssetItem[]): AssetManifestStatus {
  if (items.length === 0) return "planning";
  const settled = items.filter(item => item.status === "generated" || item.status === "uploaded");
  if (settled.length === items.length) return "complete";
  return settled.length > 0 ? "partial" : "ready";
}

function completionOf(items: readonly AssetItem[]): AssetCompletion {
  const uploaded = items.filter(item => item.status === "generated" || item.status === "uploaded").length;
  return Object.freeze({
    total: items.length,
    uploaded,
    failed: items.filter(item => item.status === "failed").length,
    complete: items.length > 0 && uploaded === items.length,
  });
}

function manifestFromRow(row: AssetManifestRow, items: readonly AssetItem[]): AssetManifest {
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    schemaVersion: "deviludo.asset-manifest.v1",
    status: manifestStatus(items),
    autoGenerateEnabled: row.auto_generate_enabled,
    plannedAt: row.planned_at,
    items,
  });
}

export class AssetManifestStore {
  constructor(private readonly database: Database) {}

  async read(workspaceId: string, projectId: string): Promise<AssetManifestView | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const manifests = await client.query<AssetManifestRow>(
        `SELECT ${MANIFEST_COLUMNS}
           FROM deviludo.asset_manifests
          WHERE project_id = $1::uuid`,
        [projectId],
      );
      const row = manifests.rows[0];
      if (!row) return null;
      const items = await client.query<AssetItemRow>(
        `SELECT ${ITEM_COLUMNS}
           FROM deviludo.asset_items
          WHERE manifest_id = $1::uuid
          ORDER BY created_at ASC, asset_key ASC`,
        [row.id],
      );
      const mapped = Object.freeze(items.rows.map(itemFromRow));
      return Object.freeze({
        manifest: manifestFromRow(row, mapped),
        items: mapped,
        completion: completionOf(mapped),
      });
    });
  }

  async setAutoGenerate(workspaceId: string, projectId: string, enabled: boolean): Promise<boolean> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query(
        `UPDATE deviludo.asset_manifests
            SET auto_generate_enabled = $2, updated_at = clock_timestamp()
          WHERE project_id = $1::uuid`,
        [projectId, enabled],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * Attach a stored object to a planned asset. The schema requires bucket, key,
   * digest and size to arrive together with an `uploaded` status, so this is the
   * only supported way to mark an asset supplied.
   */
  async attachUpload(input: Readonly<{
    workspaceId: string;
    projectId: string;
    assetKey: string;
    bucket: string;
    objectKey: string;
    sha256: string;
    sizeBytes: number;
  }>): Promise<AssetItem | null> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<AssetItemRow>(
        `UPDATE deviludo.asset_items item
            SET status = 'uploaded', bucket = $3, object_key = $4, sha256 = $5,
                size_bytes = $6, error_message = NULL, updated_at = clock_timestamp()
          WHERE item.asset_key = $2
            AND item.manifest_id = (
              SELECT id FROM deviludo.asset_manifests WHERE project_id = $1::uuid
            )
        RETURNING ${ITEM_COLUMNS}`,
        [input.projectId, input.assetKey, input.bucket, input.objectKey,
          input.sha256, String(input.sizeBytes)],
      );
      return result.rows[0] ? itemFromRow(result.rows[0]) : null;
    });
  }
}
