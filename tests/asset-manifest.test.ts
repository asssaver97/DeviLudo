import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateAssetManifest,
  validateAssetItem,
  ASSET_TYPES,
  ASSET_ITEM_STATUSES,
  ASSET_MANIFEST_STATUSES,
} from "../lib/product/asset-manifest.js";
import { AssetManifestStore } from "@/services/core/src/asset-manifest";
import type { Database } from "@/services/core/src/database";

describe("Asset manifest validation", () => {
  it("accepts valid asset manifest", () => {
    const manifest = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      workspaceId: "ws-1",
      projectId: "proj-1",
      schemaVersion: "deviludo.asset-manifest.v1",
      status: "planning",
      autoGenerateEnabled: false,
      plannedAt: "2024-01-01T00:00:00Z",
    };
    assert.ok(validateAssetManifest(manifest));
  });

  it("rejects invalid schema version", () => {
    const manifest = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      workspaceId: "ws-1",
      projectId: "proj-1",
      schemaVersion: "v2",
      status: "planning",
      autoGenerateEnabled: false,
      plannedAt: "2024-01-01T00:00:00Z",
    };
    assert.ok(!validateAssetManifest(manifest));
  });

  it("rejects invalid status", () => {
    const manifest = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      workspaceId: "ws-1",
      projectId: "proj-1",
      schemaVersion: "deviludo.asset-manifest.v1",
      status: "invalid",
      autoGenerateEnabled: false,
      plannedAt: "2024-01-01T00:00:00Z",
    };
    assert.ok(!validateAssetManifest(manifest));
  });

  it("accepts valid asset item", () => {
    const item = {
      id: "item-1",
      manifestId: "manifest-1",
      assetKey: "sprites/player_idle",
      assetType: "animation",
      description: "Player idle animation",
      generationPrompt: "pixel art character idle",
      frameCount: 4,
      dimensions: "32x32",
      status: "planned",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    assert.ok(validateAssetItem(item));
  });

  it("rejects invalid asset type", () => {
    const item = {
      id: "item-1",
      manifestId: "manifest-1",
      assetKey: "sprites/player_idle",
      assetType: "invalid",
      description: "Player idle animation",
      status: "planned",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    assert.ok(!validateAssetItem(item));
  });

  it("rejects invalid item status", () => {
    const item = {
      id: "item-1",
      manifestId: "manifest-1",
      assetKey: "sprites/player_idle",
      assetType: "sprite",
      description: "Player idle animation",
      status: "invalid",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    assert.ok(!validateAssetItem(item));
  });

  it("validates all asset types are recognized", () => {
    for (const assetType of ASSET_TYPES) {
      const item = {
        id: "item-1",
        manifestId: "manifest-1",
        assetKey: "test/asset",
        assetType,
        description: "Test asset",
        status: "planned",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      assert.ok(validateAssetItem(item), `Asset type ${assetType} should be valid`);
    }
  });

  it("validates all item statuses are recognized", () => {
    for (const status of ASSET_ITEM_STATUSES) {
      const item = {
        id: "item-1",
        manifestId: "manifest-1",
        assetKey: "test/asset",
        assetType: "sprite",
        description: "Test asset",
        status,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      assert.ok(validateAssetItem(item), `Status ${status} should be valid`);
    }
  });

  it("validates all manifest statuses are recognized", () => {
    for (const status of ASSET_MANIFEST_STATUSES) {
      const manifest = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        workspaceId: "ws-1",
        projectId: "proj-1",
        schemaVersion: "deviludo.asset-manifest.v1",
        status,
        autoGenerateEnabled: false,
        plannedAt: "2024-01-01T00:00:00Z",
      };
      assert.ok(validateAssetManifest(manifest), `Status ${status} should be valid`);
    }
  });

  it("rejects non-object values", () => {
    assert.ok(!validateAssetManifest(null));
    assert.ok(!validateAssetManifest("string"));
    assert.ok(!validateAssetManifest(123));
    assert.ok(!validateAssetManifest([]));

    assert.ok(!validateAssetItem(null));
    assert.ok(!validateAssetItem("string"));
    assert.ok(!validateAssetItem(123));
    assert.ok(!validateAssetItem([]));
  });
});

const workspaceId = "20000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000002";
const manifestId = "20000000-0000-4000-8000-000000000003";

type QueryCall = Readonly<{ text: string; values: readonly unknown[] }>;
type QueryResult = Readonly<{ rows: readonly unknown[]; rowCount?: number }>;

/**
 * Records the workspace every query ran under so the tests can prove the store
 * never reaches the asset tables outside a workspace transaction: their forced
 * row-level security only applies inside one.
 */
function fakeDatabase(respond: (call: QueryCall) => QueryResult) {
  const calls: QueryCall[] = [];
  const workspaces: string[] = [];
  const database = {
    pool: {} as never,
    async withWorkspace<T>(id: string, callback: (client: never) => Promise<T>): Promise<T> {
      workspaces.push(id);
      const client = {
        async query(text: string, values: readonly unknown[] = []) {
          const call = Object.freeze({ text, values });
          calls.push(call);
          return respond(call);
        },
      };
      return callback(client as never);
    },
    close: async () => undefined,
  };
  return { database: database as unknown as Database, calls, workspaces };
}

function itemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "item-1",
    manifest_id: manifestId,
    asset_key: "sprites/player_idle",
    asset_type: "animation",
    description: "Player idle animation",
    generation_prompt: "pixel art character idle",
    frame_count: "4",
    dimensions: "32x32",
    status: "planned",
    object_key: null,
    error_message: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

const manifestRow = {
  id: manifestId,
  workspace_id: workspaceId,
  project_id: projectId,
  auto_generate_enabled: false,
  planned_at: "2024-01-01T00:00:00Z",
};

describe("Asset manifest store", () => {
  it("maps stored rows to the browser shape and derives status from the items", async () => {
    const { database, workspaces } = fakeDatabase(call => call.text.includes("asset_manifests")
      ? { rows: [manifestRow] }
      : {
        rows: [
          itemRow(),
          itemRow({ id: "item-2", asset_key: "ui/button", asset_type: "ui", status: "uploaded", object_key: "assets/ui/button.png", frame_count: null, generation_prompt: null, dimensions: null }),
        ],
      });
    const view = await new AssetManifestStore(database).read(workspaceId, projectId);
    assert.ok(view);
    // Half the assets are settled, so the manifest is partial rather than ready.
    assert.equal(view.manifest.status, "partial");
    assert.equal(view.manifest.schemaVersion, "deviludo.asset-manifest.v1");
    assert.equal(view.manifest.autoGenerateEnabled, false);
    assert.deepEqual(view.completion, { total: 2, uploaded: 1, failed: 0, complete: false });
    assert.ok(validateAssetManifest(view.manifest));
    for (const item of view.items) assert.ok(validateAssetItem(item));
    // Numeric columns arrive as text from pg and absent ones stay absent rather
    // than becoming null, which the item validator would reject.
    assert.equal(view.items[0].frameCount, 4);
    assert.equal(view.items[0].generationPrompt, "pixel art character idle");
    assert.equal("frameCount" in view.items[1], false);
    assert.equal("generationPrompt" in view.items[1], false);
    assert.equal(view.items[1].objectKey, "assets/ui/button.png");
    assert.deepEqual(workspaces, [workspaceId]);
  });

  it("reports a fully supplied manifest as complete", async () => {
    const { database } = fakeDatabase(call => call.text.includes("asset_manifests")
      ? { rows: [{ ...manifestRow, auto_generate_enabled: true }] }
      : { rows: [itemRow({ status: "uploaded", object_key: "assets/a.png" })] });
    const view = await new AssetManifestStore(database).read(workspaceId, projectId);
    assert.equal(view?.manifest.status, "complete");
    assert.equal(view?.manifest.autoGenerateEnabled, true);
    assert.deepEqual(view?.completion, { total: 1, uploaded: 1, failed: 0, complete: true });
  });

  it("treats a project with no manifest as empty rather than an error", async () => {
    const { database, calls } = fakeDatabase(() => ({ rows: [] }));
    assert.equal(await new AssetManifestStore(database).read(workspaceId, projectId), null);
    // No manifest means no item lookup at all.
    assert.equal(calls.length, 1);
  });

  it("reports whether the auto-generate toggle found a manifest to update", async () => {
    const found = fakeDatabase(() => ({ rows: [], rowCount: 1 }));
    assert.equal(await new AssetManifestStore(found.database).setAutoGenerate(workspaceId, projectId, true), true);
    assert.deepEqual(found.calls[0].values, [projectId, true]);
    const missing = fakeDatabase(() => ({ rows: [], rowCount: 0 }));
    assert.equal(await new AssetManifestStore(missing.database).setAutoGenerate(workspaceId, projectId, true), false);
  });

  it("attaches an upload with the object metadata the schema requires together", async () => {
    const { database, calls, workspaces } = fakeDatabase(() => ({
      rows: [itemRow({ status: "uploaded", object_key: "assets/sprites/player_idle.png" })],
    }));
    const item = await new AssetManifestStore(database).attachUpload({
      workspaceId,
      projectId,
      assetKey: "sprites/player_idle",
      bucket: "deviludo",
      objectKey: "assets/sprites/player_idle.png",
      sha256: `sha256:${"a".repeat(64)}`,
      sizeBytes: 2048,
    });
    assert.equal(item?.status, "uploaded");
    assert.equal(item?.objectKey, "assets/sprites/player_idle.png");
    // Status and object metadata move together, and a prior failure is cleared.
    assert.match(calls[0].text, /SET status = 'uploaded'[\s\S]*error_message = NULL/);
    // size_bytes is bigint, so it travels as text rather than a JS number.
    assert.deepEqual(calls[0].values, [
      projectId, "sprites/player_idle", "deviludo", "assets/sprites/player_idle.png",
      `sha256:${"a".repeat(64)}`, "2048",
    ]);
    assert.deepEqual(workspaces, [workspaceId]);
  });

  it("returns null when the uploaded asset key was never planned", async () => {
    const { database } = fakeDatabase(() => ({ rows: [] }));
    const item = await new AssetManifestStore(database).attachUpload({
      workspaceId,
      projectId,
      assetKey: "sprites/unknown",
      bucket: "deviludo",
      objectKey: "assets/sprites/unknown.png",
      sha256: `sha256:${"b".repeat(64)}`,
      sizeBytes: 16,
    });
    assert.equal(item, null);
  });
});
