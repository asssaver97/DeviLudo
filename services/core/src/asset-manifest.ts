// Asset manifest storage and retrieval

import { type Pool } from "pg";
import type { AssetManifest, AssetItem, AssetManifestStatus, AssetItemStatus } from "@/lib/product/asset-manifest";

export async function createAssetManifest(
  pool: Pool,
  workspaceId: string,
  projectId: string,
  autoGenerateEnabled: boolean
): Promise<AssetManifest> {
  const result = await pool.query<AssetManifest>(
    `INSERT INTO asset_manifests (workspace_id, project_id, status, auto_generate_enabled)
     VALUES ($1, $2, 'planning', $3)
     RETURNING *`,
    [workspaceId, projectId, autoGenerateEnabled]
  );
  return result.rows[0];
}

export async function getAssetManifest(
  pool: Pool,
  projectId: string,
  includeItems: boolean = false
): Promise<AssetManifest | null> {
  const result = await pool.query<AssetManifest>(
    `SELECT * FROM asset_manifests WHERE project_id = $1`,
    [projectId]
  );

  if (result.rows.length === 0) return null;

  const manifest = result.rows[0];

  if (includeItems) {
    const itemsResult = await pool.query<AssetItem>(
      `SELECT * FROM asset_items WHERE manifest_id = $1 ORDER BY created_at ASC`,
      [manifest.id]
    );
    return { ...manifest, items: itemsResult.rows };
  }

  return manifest;
}

export async function updateAssetManifestStatus(
  pool: Pool,
  manifestId: string,
  status: AssetManifestStatus
): Promise<void> {
  await pool.query(
    `UPDATE asset_manifests SET status = $1, updated_at = now() WHERE id = $2`,
    [status, manifestId]
  );
}

export async function toggleAutoGenerate(
  pool: Pool,
  manifestId: string,
  enabled: boolean
): Promise<void> {
  await pool.query(
    `UPDATE asset_manifests SET auto_generate_enabled = $1 WHERE id = $2`,
    [enabled, manifestId]
  );
}

export async function createAssetItems(
  pool: Pool,
  manifestId: string,
  items: Array<{
    assetKey: string;
    assetType: string;
    description: string;
    generationPrompt?: string;
    frameCount?: number;
    dimensions?: string;
  }>
): Promise<AssetItem[]> {
  const values = items.map((item, idx) => {
    const offset = idx * 7;
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
  }).join(", ");

  const params = items.flatMap(item => [
    manifestId,
    item.assetKey,
    item.assetType,
    item.description,
    item.generationPrompt || null,
    item.frameCount || null,
    item.dimensions || null
  ]);

  const result = await pool.query<AssetItem>(
    `INSERT INTO asset_items (manifest_id, asset_key, asset_type, description, generation_prompt, frame_count, dimensions, status)
     VALUES ${values}
     RETURNING *`,
    params
  );

  return result.rows;
}

export async function updateAssetItemStatus(
  pool: Pool,
  itemId: string,
  status: AssetItemStatus,
  objectKey?: string,
  errorMessage?: string
): Promise<void> {
  await pool.query(
    `UPDATE asset_items
     SET status = $1, object_key = $2, error_message = $3, updated_at = now()
     WHERE id = $4`,
    [status, objectKey || null, errorMessage || null, itemId]
  );
}

export async function getAssetItemsByManifest(
  pool: Pool,
  manifestId: string
): Promise<AssetItem[]> {
  const result = await pool.query<AssetItem>(
    `SELECT * FROM asset_items WHERE manifest_id = $1 ORDER BY created_at ASC`,
    [manifestId]
  );
  return result.rows;
}

export async function checkAssetCompletion(
  pool: Pool,
  manifestId: string
): Promise<{ total: number; uploaded: number; failed: number; complete: boolean }> {
  const result = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count
     FROM asset_items
     WHERE manifest_id = $1
     GROUP BY status`,
    [manifestId]
  );

  let total = 0;
  let uploaded = 0;
  let failed = 0;

  for (const row of result.rows) {
    const count = parseInt(row.count, 10);
    total += count;
    if (row.status === "uploaded" || row.status === "generated") {
      uploaded += count;
    }
    if (row.status === "failed") {
      failed += count;
    }
  }

  const complete = total > 0 && uploaded === total;

  return { total, uploaded, failed, complete };
}
