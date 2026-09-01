// Asset manifest reads and mutations.
//
// The image calls run asynchronously, but an auto-generated manifest is a durable
// gate between Agent completion and artifact build. Every workspace-scoped query
// here runs inside `withWorkspace` so the tables' forced row-level security applies.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "./database";
import {
  isMusicAsset,
  type AssetItem,
  type AssetItemStatus,
  type AssetManifest,
  type AssetManifestStatus,
  type AssetType,
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
  source_path: string | null;
  object_key: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}>;

const MANIFEST_COLUMNS = `id::text, workspace_id::text, project_id::text,
        auto_generate_enabled, planned_at::text`;
const ITEM_COLUMNS = `id::text, manifest_id::text, asset_key, asset_type, description,
        generation_prompt, frame_count::text, dimensions, status, source_path,
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
  leaseToken: string;
}>;

export type AssetRerunResult = Readonly<{
  accepted: boolean;
  queued: number;
  remaining: number;
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
  leaseToken: string;
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
    ...(row.source_path ? { sourcePath: row.source_path } : {}),
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
  const images = items.filter(item => !isMusicAsset(item));
  if (images.length === 0) return "planning";
  const settled = images.filter(item => ["generated", "uploaded", "existing"].includes(item.status));
  if (settled.length === images.length) return "complete";
  return settled.length > 0 ? "partial" : "ready";
}

function completionOf(items: readonly AssetItem[]): AssetCompletion {
  const images = items.filter(item => !isMusicAsset(item));
  const uploaded = images.filter(item => ["generated", "uploaded", "existing"].includes(item.status)).length;
  return Object.freeze({
    total: images.length,
    uploaded,
    failed: images.filter(item => item.status === "failed").length,
    complete: images.length > 0 && uploaded === images.length,
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
   * Requeue unresolved image work and atomically reopen the delivery at its
   * asset gate. Existing source images and supplied objects remain untouched;
   * the database supersedes Builder/E2E jobs derived from the older set.
   */
  async retryMissing(input: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowId: string;
    idempotencyKey: string;
    requestedBy: string;
    requestedByActorId: string;
  }>): Promise<AssetRerunResult> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<{ accepted: boolean; queued: number; remaining: number }>(
        `SELECT accepted, queued, remaining
           FROM deviludo.request_asset_rerun(
             $1::uuid, $2::uuid, $3::text,
             jsonb_build_object('requestedBy', $4::text, 'requestedByActorId', $5::text)
           )`,
        [input.workflowId, input.projectId, input.idempotencyKey, input.requestedBy, input.requestedByActorId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Asset rerun did not return a result");
      return Object.freeze({
        accepted: row.accepted,
        queued: Number(row.queued),
        remaining: Number(row.remaining),
      });
    });
  }

  /**
   * Backfill existing projects from their immutable current source revision.
   * The operation is idempotent: after the first read it performs one inventory
   * query and no row writes until the source revision changes.
   */
  async synchronizeSourceImages(input: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowId: string;
    sourcePaths: readonly string[];
  }>): Promise<number> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const manifest = await client.query<{ id: string }>(
        `INSERT INTO deviludo.asset_manifests(
           workspace_id, project_id, workflow_id, auto_generate_enabled
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, false)
         ON CONFLICT (workspace_id, project_id) DO UPDATE
           SET workflow_id = EXCLUDED.workflow_id, updated_at = clock_timestamp()
         RETURNING id::text`,
        [input.workspaceId, input.projectId, input.workflowId],
      );
      const manifestId = manifest.rows[0]?.id;
      if (!manifestId) return 0;
      const rows = await client.query<AssetItemRow>(
        `SELECT ${ITEM_COLUMNS}
           FROM deviludo.asset_items
          WHERE manifest_id = $1::uuid
          ORDER BY asset_key`,
        [manifestId],
      );
      const items = rows.rows.map(itemFromRow);
      const normalized = input.sourcePaths
        .filter(path => safeSourceImagePath(path))
        .slice(0, 500)
        .map(sourcePath => ({ sourcePath, strippedPath: sourcePath.replace(/\.(?:png|jpe?g|webp|svg)$/i, "") }));
      const baseCounts = new Map<string, number>();
      for (const source of normalized) {
        const basename = source.strippedPath.split("/").at(-1) ?? source.strippedPath;
        baseCounts.set(basename, (baseCounts.get(basename) ?? 0) + 1);
      }
      const occupied = new Set(items.map(item => item.assetKey));
      let changed = 0;
      for (const source of normalized) {
        const aliases = sourceImageAliases(source.strippedPath);
        const basename = source.strippedPath.split("/").at(-1) ?? source.strippedPath;
        // A planned GENERATED item must be fulfilled by the image-generation
        // queue. A Development-authored file at the expected generated path is
        // only a fallback and must never be promoted into accepted art.
        const candidates = items.filter(item => !["generated", "uploaded"].includes(item.status)
          && (item.status === "existing" || item.generationPrompt === undefined)
          && (aliases.has(item.assetKey)
            || (item.assetKey.split("/").at(-1) === basename && baseCounts.get(basename) === 1)));
        const matched = candidates.length === 1 ? candidates[0] : null;
        if (matched) {
          if (matched.status !== "existing" || matched.sourcePath !== source.sourcePath) {
            const result = await client.query(
              `UPDATE deviludo.asset_items
                  SET status = 'existing', source_path = $2,
                      bucket = NULL, object_key = NULL, sha256 = NULL, size_bytes = NULL,
                      error_message = NULL, generation_attempt = 0,
                      generation_lease_expires_at = NULL, updated_at = clock_timestamp()
                WHERE manifest_id = $1::uuid AND id = $3::uuid`,
              [manifestId, source.sourcePath, matched.id],
            );
            changed += result.rowCount ?? 0;
          }
          continue;
        }
        const assetKey = sourceInventoryKey(source.strippedPath);
        if (occupied.has(assetKey) || [...aliases].some(alias => occupied.has(alias))) continue;
        const result = await client.query(
          `INSERT INTO deviludo.asset_items(
             workspace_id, manifest_id, asset_key, asset_type, description,
             generation_prompt, status, source_path
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6, 'existing', $7
           ) ON CONFLICT (workspace_id, manifest_id, asset_key) DO NOTHING`,
          [input.workspaceId, manifestId, assetKey, inferSourceAssetType(source.sourcePath),
            `Existing project image: ${source.sourcePath}`,
            `Recreate the existing game image at ${source.sourcePath} while preserving its current visual role and style.`,
            source.sourcePath],
        );
        occupied.add(assetKey);
        changed += result.rowCount ?? 0;
      }
      return changed;
    });
  }

  /**
   * Persist the Development Agent's upload-only music brief beside visual
   * assets. Music deliberately has no generation prompt and is never an image
   * gate; this list exists so each requested cue has a durable description and
   * one stable upload target.
   */
  async synchronizeMusicPlan(input: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowId: string;
    items: readonly Readonly<{ assetKey: string; description: string }>[];
  }>): Promise<number> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const manifest = input.items.length > 0
        ? await client.query<{ id: string }>(
          `INSERT INTO deviludo.asset_manifests(
             workspace_id, project_id, workflow_id, auto_generate_enabled
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, false)
           ON CONFLICT (workspace_id, project_id) DO UPDATE
             SET workflow_id = EXCLUDED.workflow_id, updated_at = clock_timestamp()
           RETURNING id::text`,
          [input.workspaceId, input.projectId, input.workflowId],
        )
        : await client.query<{ id: string }>(
          `SELECT id::text
             FROM deviludo.asset_manifests
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
          [input.workspaceId, input.projectId],
        );
      const manifestId = manifest.rows[0]?.id;
      if (!manifestId) return 0;
      let changed = 0;
      for (const item of input.items) {
        const result = await client.query(
          `INSERT INTO deviludo.asset_items(
             workspace_id, manifest_id, asset_key, asset_type, description,
             generation_prompt, status
           ) VALUES ($1::uuid, $2::uuid, $3, 'music', $4, NULL, 'planned')
           ON CONFLICT (workspace_id, manifest_id, asset_key) DO UPDATE
             SET description = EXCLUDED.description, asset_type = 'music',
                 generation_prompt = NULL, frame_count = NULL, dimensions = NULL,
                 updated_at = clock_timestamp()
           WHERE deviludo.asset_items.asset_type = 'music'
         RETURNING id`,
          [input.workspaceId, manifestId, item.assetKey, item.description],
        );
        changed += result.rowCount ?? 0;
      }
      const removed = await client.query(
        `DELETE FROM deviludo.asset_items
          WHERE workspace_id = $1::uuid AND manifest_id = $2::uuid
            AND asset_type = 'music'
            AND NOT (asset_key = ANY($3::text[]))`,
        [input.workspaceId, manifestId, input.items.map(item => item.assetKey)],
      );
      changed += removed.rowCount ?? 0;
      return changed;
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
              "frameCount"::text, "attempt"::text, "leaseToken"::text
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
      leaseToken: row.leaseToken,
    })));
  }

  /** Settle a leased item as generated. False means the lease no longer held it. */
  async completeGeneration(input: Readonly<{
    workspaceId: string;
    itemId: string;
    leaseToken: string;
    bucket: string;
    objectKey: string;
    sha256: string;
    sizeBytes: number;
  }>): Promise<boolean> {
    const result = await this.database.pool.query<{ settled: boolean }>(
      `SELECT deviludo.complete_asset_generation(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::bigint
       ) AS settled`,
      [input.workspaceId, input.itemId, input.leaseToken, input.bucket, input.objectKey, input.sha256, String(input.sizeBytes)],
    );
    return result.rows[0]?.settled === true;
  }

  /** Release a leased item after a failed attempt. */
  async failGeneration(workspaceId: string, itemId: string, leaseToken: string, error: string): Promise<boolean> {
    const result = await this.database.pool.query<{ released: boolean }>(
      "SELECT deviludo.fail_asset_generation($1::uuid, $2::uuid, $3::uuid, $4::text) AS released",
      [workspaceId, itemId, leaseToken, error],
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
                size_bytes = $6, source_path = NULL, error_message = NULL,
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

/**
 * Reconcile the executor's deterministic source scan in the same transaction
 * that registers Agent completion. This prevents a scheduler tick from leasing
 * an image that is already present in the just-published source tree.
 */
export async function reconcileExistingSourceAssets(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  value: unknown,
): Promise<number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return 0;
  const existing = items.filter((item): item is Record<string, unknown> => Boolean(
    item && typeof item === "object" && !Array.isArray(item)
      && item.status === "existing"
      && typeof item.assetKey === "string"
      && typeof item.sourcePath === "string",
  ));
  let reconciled = 0;
  for (const item of existing) {
    const result = await client.query(
      `UPDATE deviludo.asset_items asset
          SET status = 'existing', source_path = $3,
              bucket = NULL, object_key = NULL, sha256 = NULL, size_bytes = NULL,
              error_message = NULL, generation_attempt = 0,
              generation_lease_expires_at = NULL, updated_at = clock_timestamp()
        WHERE asset.workspace_id = $1::uuid
          AND asset.asset_key = $2
          AND (asset.status = 'existing' OR asset.generation_prompt IS NULL)
          AND asset.manifest_id = (
            SELECT id FROM deviludo.asset_manifests
             WHERE workspace_id = $1::uuid AND project_id = $4::uuid
          )`,
      [workspaceId, item.assetKey, item.sourcePath, projectId],
    );
    reconciled += result.rowCount ?? 0;
  }
  if (reconciled !== existing.length) {
    throw new Error("Existing source image inventory did not match the registered asset manifest");
  }
  return reconciled;
}

function safeSourceImagePath(value: string): boolean {
  return value.length >= 5 && value.length <= 500
    && /\.(?:png|jpe?g|webp|svg)$/i.test(value)
    && !value.startsWith("/") && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value);
}

function sourceImageAliases(strippedPath: string): ReadonlySet<string> {
  const aliases = new Set([strippedPath]);
  for (const prefix of ["assets/generated/", "assets/", "art/", "images/", "data/sprites/", "data/generated_assets/"]) {
    if (strippedPath.startsWith(prefix)) aliases.add(strippedPath.slice(prefix.length));
  }
  return aliases;
}

function sourceInventoryKey(strippedPath: string): string {
  if (strippedPath.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(strippedPath)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(strippedPath) && !strippedPath.endsWith("/")) return strippedPath;
  return `existing/${createHash("sha256").update(strippedPath).digest("hex").slice(0, 32)}`;
}

function inferSourceAssetType(sourcePath: string): AssetType {
  const path = sourcePath.toLowerCase();
  if (/(^|[\/_-])(tile|tileset)/.test(path)) return "tileset";
  if (/(^|[\/_-])(background|backdrop|bg)([\/_-]|\.)/.test(path)) return "background";
  if (/(^|[\/_-])(icon|favicon)([\/_-]|\.)/.test(path)) return "icon";
  if (/(^|[\/_-])(ui|hud|button|panel|menu)([\/_-]|\.)/.test(path)) return "ui";
  if (/(^|[\/_-])(animation|anim|sheet)([\/_-]|\.)/.test(path)) return "animation";
  return "sprite";
}
