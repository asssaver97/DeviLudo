// Asset manifest reads and mutations.
//
// The image calls run asynchronously, but an auto-generated manifest is a durable
// gate between Agent completion and artifact build. Every workspace-scoped query
// here runs inside `withWorkspace` so the tables' forced row-level security applies.

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

/** One leased asset awaiting generation. */
export type AssetGenerationLease = Readonly<{
  workspaceId: string;
  projectId: string;
  itemId: string;
  assetKey: string;
  assetType: string;
  description: string;
  generationPrompt: string;
  dimensions: string | null;
  frameCount: number | null;
  attempt: number;
}>;

type AssetGenerationLeaseRow = Readonly<{
  workspaceId: string;
  projectId: string;
  itemId: string;
  assetKey: string;
  assetType: string;
  description: string;
  generationPrompt: string;
  dimensions: string | null;
  frameCount: string | null;
  attempt: string;
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
   * Lease planned assets for generation.
   *
   * Runs on the pool rather than `withWorkspace`: the generator sweeps every
   * workspace, and the definer function it calls sets `row_security = off` for
   * exactly that reason. The lease is what keeps two scheduler replicas from
   * generating the same asset twice.
   */
  async claimGeneration(leaseSeconds: number, batchSize: number): Promise<readonly AssetGenerationLease[]> {
    const result = await this.database.pool.query<AssetGenerationLeaseRow>(
      `SELECT "workspaceId"::text, "projectId"::text, "itemId"::text, "assetKey",
              "assetType", "description", "generationPrompt", "dimensions",
              "frameCount"::text, "attempt"::text
         FROM deviludo.claim_asset_generation($1::integer, $2::integer)`,
      [leaseSeconds, batchSize],
    );
    return Object.freeze(result.rows.map(row => Object.freeze({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      itemId: row.itemId,
      assetKey: row.assetKey,
      assetType: row.assetType,
      description: row.description,
      generationPrompt: row.generationPrompt,
      dimensions: row.dimensions,
      frameCount: row.frameCount === null ? null : Number(row.frameCount),
      attempt: Number(row.attempt),
    })));
  }

  /** Settle a leased item as generated. False means the lease no longer held it. */
  async completeGeneration(input: Readonly<{
    workspaceId: string;
    itemId: string;
    bucket: string;
    objectKey: string;
    sha256: string;
    sizeBytes: number;
  }>): Promise<boolean> {
    const result = await this.database.pool.query<{ settled: boolean }>(
      `SELECT deviludo.complete_asset_generation(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::bigint
       ) AS settled`,
      [input.workspaceId, input.itemId, input.bucket, input.objectKey, input.sha256, String(input.sizeBytes)],
    );
    return result.rows[0]?.settled === true;
  }

  /** Release a leased item after a failed attempt. */
  async failGeneration(workspaceId: string, itemId: string, error: string): Promise<boolean> {
    const result = await this.database.pool.query<{ released: boolean }>(
      "SELECT deviludo.fail_asset_generation($1::uuid, $2::uuid, $3::text) AS released",
      [workspaceId, itemId, error],
    );
    return result.rows[0]?.released === true;
  }

  /** Release asset-gated workflows whose images are now all supplied. */
  async advanceReadyWorkflows(batchSize = 20): Promise<number> {
    const result = await this.database.pool.query<{ advanced: string }>(
      "SELECT deviludo.advance_asset_workflows($1::integer)::text AS advanced",
      [batchSize],
    );
    return Number(result.rows[0]?.advanced ?? 0);
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
        // The lease has to be cleared alongside the status: the schema ties
        // `generation_lease_expires_at` to the 'generating' status, so leaving it
        // set while moving to 'uploaded' violates that CHECK. An upload landing
        // mid-generation wins — `complete_asset_generation` only settles items
        // still in 'generating', so the generator's result is dropped rather than
        // overwriting the file the user chose.
        `UPDATE deviludo.asset_items item
            SET status = 'uploaded', bucket = $3, object_key = $4, sha256 = $5,
                size_bytes = $6, error_message = NULL,
                generation_lease_expires_at = NULL, updated_at = clock_timestamp()
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
