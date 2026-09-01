import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateAssetManifest,
  validateAssetItem,
  ASSET_TYPES,
  ASSET_ITEM_STATUSES,
  ASSET_MANIFEST_STATUSES,
  validateAssetUsageTargets,
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
      usageTargets: [{ targetId: "player-avatar", checkpointRole: "READY" }],
      status: "planned",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    assert.ok(validateAssetItem(item));
  });

  it("requires bounded unique stable control targets for planned asset placement", () => {
    assert.equal(validateAssetUsageTargets([
      { targetId: "start-dialog-frame", checkpointRole: "START" },
      { targetId: "pause-dialog-frame", checkpointRole: "ACTION" },
    ]), true);
    assert.equal(validateAssetUsageTargets([]), false);
    assert.equal(validateAssetUsageTargets([
      { targetId: "start-dialog-frame", checkpointRole: "START" },
      { targetId: "start-dialog-frame", checkpointRole: "START" },
    ]), false);
    assert.equal(validateAssetUsageTargets([
      { targetId: "Bad Control", checkpointRole: "START" },
    ]), false);
  });

  it("requires existing source images to use a safe project-relative path", () => {
    const item = {
      id: "item-1",
      manifestId: "manifest-1",
      assetKey: "portraits/hero",
      assetType: "sprite",
      description: "Existing hero portrait",
      status: "existing",
      sourcePath: "assets/portraits/hero.png",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    assert.equal(validateAssetItem(item), true);
    assert.equal(validateAssetItem({ ...item, sourcePath: "../hero.png" }), false);
    assert.equal(validateAssetItem({ ...item, sourcePath: "/tmp/hero.png" }), false);
    assert.equal(validateAssetItem({ ...item, sourcePath: undefined }), false);
    assert.equal(validateAssetItem({ ...item, status: "planned" }), false);
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

  it("accepts upload-only music and rejects image-generation fields on it", () => {
    const music = {
      id: "item-music",
      manifestId: "manifest-1",
      assetKey: "music/main-menu",
      assetType: "music",
      description: "Calm main-menu theme that establishes the game's tone.",
      status: "planned",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    assert.equal(validateAssetItem(music), true);
    assert.equal(validateAssetItem({ ...music, generationPrompt: "compose a theme" }), false);
    assert.equal(validateAssetItem({ ...music, dimensions: "32x32" }), false);
  });

  it("rejects an asset key that could escape the generated asset directory", () => {
    assert.equal(validateAssetItem({
      id: "item-1",
      manifestId: "manifest-1",
      assetKey: "../outside",
      assetType: "sprite",
      description: "Unsafe asset",
      status: "planned",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }), false);
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
        ...(status === "existing" ? { sourcePath: "assets/test/asset.png" } : {}),
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
    source_path: null,
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

  it("keeps upload-only music out of visual completion and generation status", async () => {
    const { database } = fakeDatabase(call => call.text.includes("asset_manifests")
      ? { rows: [{ ...manifestRow, auto_generate_enabled: true }] }
      : { rows: [
        itemRow({ status: "uploaded", object_key: "assets/a.png" }),
        itemRow({ id: "music-1", asset_key: "music/menu", asset_type: "music", description: "Menu theme", generation_prompt: null, frame_count: null, dimensions: null }),
      ] });
    const view = await new AssetManifestStore(database).read(workspaceId, projectId);
    assert.equal(view?.manifest.status, "complete");
    assert.deepEqual(view?.completion, { total: 1, uploaded: 1, failed: 0, complete: true });
    assert.equal(view?.items[1].assetType, "music");
    assert.ok(view?.items[1] && validateAssetItem(view.items[1]));
  });

  it("counts images discovered in the published source as complete", async () => {
    const { database } = fakeDatabase(call => call.text.includes("asset_manifests")
      ? { rows: [{ ...manifestRow, auto_generate_enabled: true }] }
      : { rows: [itemRow({ status: "existing", source_path: "assets/portraits/hero.png", generation_prompt: null })] });
    const view = await new AssetManifestStore(database).read(workspaceId, projectId);
    assert.equal(view?.manifest.status, "complete");
    assert.equal(view?.items[0].sourcePath, "assets/portraits/hero.png");
    assert.deepEqual(view?.completion, { total: 1, uploaded: 1, failed: 0, complete: true });
  });

  it("does not let a source placeholder satisfy a planned generated asset", async () => {
    const { database, calls } = fakeDatabase(call => {
      if (call.text.includes("INSERT INTO deviludo.asset_manifests")) {
        return { rows: [{ id: manifestId }], rowCount: 1 };
      }
      if (call.text.includes("SELECT") && call.text.includes("FROM deviludo.asset_items")) {
        return { rows: [itemRow({
          asset_key: "sprites/player_idle",
          asset_type: "sprite",
          generation_prompt: "Generate a finished authored player portrait for the production game.",
          status: "planned",
        })] };
      }
      return { rows: [], rowCount: 0 };
    });
    const changed = await new AssetManifestStore(database).synchronizeSourceImages({
      workspaceId,
      projectId,
      workflowId: "20000000-0000-4000-8000-000000000004",
      sourcePaths: ["assets/generated/sprites/player_idle.png"],
    });
    assert.equal(changed, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls.some(call => call.text.includes("SET status = 'existing'")), false);
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

  it("persists music descriptions as upload-only manifest items", async () => {
    const { database, calls } = fakeDatabase(call => {
      if (call.text.includes("INSERT INTO deviludo.asset_manifests")) return { rows: [{ id: manifestId }], rowCount: 1 };
      if (call.text.includes("DELETE FROM deviludo.asset_items")) return { rows: [], rowCount: 0 };
      return { rows: [{ id: "music-item" }], rowCount: 1 };
    });
    const changed = await new AssetManifestStore(database).synchronizeMusicPlan({
      workspaceId,
      projectId,
      workflowId: "20000000-0000-4000-8000-000000000004",
      items: [{ assetKey: "music/main-menu", description: "Measured strategy theme for the title screen." }],
    });
    assert.equal(changed, 1);
    assert.equal(calls.length, 3);
    assert.match(calls[0].text, /workflow_id = EXCLUDED\.workflow_id/);
    assert.match(calls[1].text, /'music'[\s\S]*generation_prompt[\s\S]*NULL/);
    assert.deepEqual(calls[1].values, [
      workspaceId, manifestId, "music/main-menu", "Measured strategy theme for the title screen.",
    ]);
    assert.deepEqual(calls[2].values, [workspaceId, manifestId, ["music/main-menu"]]);
  });

  it("removes obsolete music entries without creating an empty manifest", async () => {
    const { database, calls } = fakeDatabase(call => call.text.includes("SELECT id::text")
      ? { rows: [{ id: manifestId }], rowCount: 1 }
      : { rows: [], rowCount: 2 });
    const changed = await new AssetManifestStore(database).synchronizeMusicPlan({
      workspaceId,
      projectId,
      workflowId: "20000000-0000-4000-8000-000000000004",
      items: [],
    });
    assert.equal(changed, 2);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[0].text, /INSERT INTO deviludo\.asset_manifests/);
    assert.match(calls[1].text, /asset_type = 'music'/);
    assert.deepEqual(calls[1].values, [workspaceId, manifestId, []]);
  });

  it("atomically reopens the asset gate and preserves supplied images", async () => {
    const { database, calls } = fakeDatabase(() => ({
      rows: [{ accepted: true, queued: 2, remaining: 3 }],
    }));
    assert.deepEqual(await new AssetManifestStore(database).retryMissing({
      workspaceId,
      projectId,
      workflowId: "20000000-0000-4000-8000-000000000004",
      idempotencyKey: "asset-rerun:test-request",
      requestedBy: "Local operator",
      requestedByActorId: "20000000-0000-4000-8000-000000000005",
    }), {
      accepted: true,
      queued: 2,
      remaining: 3,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /deviludo\.request_asset_rerun/);
    assert.deepEqual(calls[0].values, [
      "20000000-0000-4000-8000-000000000004",
      projectId,
      "asset-rerun:test-request",
      "Local operator",
      "20000000-0000-4000-8000-000000000005",
    ]);
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

  it("clears the generation lease when an upload lands mid-generation", async () => {
    const { database, calls } = fakeDatabase(() => ({
      rows: [itemRow({ status: "uploaded", object_key: "assets/sprites/player_idle.png" })],
    }));
    await new AssetManifestStore(database).attachUpload({
      workspaceId,
      projectId,
      assetKey: "sprites/player_idle",
      bucket: "deviludo",
      objectKey: "assets/sprites/player_idle.png",
      sha256: `sha256:${"a".repeat(64)}`,
      sizeBytes: 2048,
    });
    // The schema ties the lease column to the 'generating' status, so leaving it
    // set while moving to 'uploaded' violates that CHECK.
    assert.match(calls[0].text, /generation_lease_expires_at = NULL/);
  });
});

describe("Asset generation leasing", () => {
  /**
   * The generation sweep spans every workspace, so unlike every other method here
   * it runs on the pool against definer functions rather than inside
   * `withWorkspace`. These tests assert exactly that.
   */
  function poolDatabase(respond: (call: QueryCall) => QueryResult) {
    const calls: QueryCall[] = [];
    const workspaces: string[] = [];
    const database = {
      pool: {
        async query(text: string, values: readonly unknown[] = []) {
          const call = Object.freeze({ text, values });
          calls.push(call);
          return respond(call);
        },
      },
      async withWorkspace<T>(id: string, callback: (client: never) => Promise<T>): Promise<T> {
        workspaces.push(id);
        return callback({ async query() { return { rows: [] }; } } as never);
      },
      close: async () => undefined,
    };
    return { database: database as unknown as Database, calls, workspaces };
  }

  it("claims leases on the pool and converts the numeric columns pg returns as text", async () => {
    const { database, calls, workspaces } = poolDatabase(() => ({
      rows: [{
        workspaceId,
        projectId,
        itemId: "item-1",
        assetKey: "sprites/player_idle",
        assetType: "animation",
        description: "Player idle animation",
        generationPrompt: "pixel art character idle",
        dimensions: "32x32",
        frameCount: "4",
        attempt: "1",
        leaseToken: "30000000-0000-4000-8000-000000000001",
      }, {
        workspaceId,
        projectId,
        itemId: "item-2",
        assetKey: "backgrounds/menu",
        assetType: "background",
        description: "Menu backdrop",
        generationPrompt: "painted landscape",
        dimensions: null,
        frameCount: null,
        attempt: "3",
        leaseToken: "30000000-0000-4000-8000-000000000002",
      }],
    }));
    const leases = await new AssetManifestStore(database).claimGeneration(300, 4);
    assert.match(calls[0].text, /deviludo\.claim_asset_generation/);
    assert.deepEqual(calls[0].values, [300, 4]);
    // A workspace transaction would scope the sweep to one workspace, which is the
    // opposite of what this does.
    assert.deepEqual(workspaces, []);
    assert.equal(leases[0].frameCount, 4);
    assert.equal(leases[0].attempt, 1);
    assert.equal(leases[0].leaseToken, "30000000-0000-4000-8000-000000000001");
    // An absent frame count stays null rather than becoming 0, which would be a
    // request for zero animation frames.
    assert.equal(leases[1].frameCount, null);
    assert.equal(leases[1].attempt, 3);
  });

  it("reports whether settling still held the lease", async () => {
    const settled = poolDatabase(() => ({ rows: [{ settled: true }] }));
    assert.equal(await new AssetManifestStore(settled.database).completeGeneration({
      workspaceId, itemId: "item-1", leaseToken: "30000000-0000-4000-8000-000000000001", bucket: "deviludo",
      objectKey: "assets/sprites/player_idle.png",
      sha256: `sha256:${"c".repeat(64)}`, sizeBytes: 4096,
    }), true);
    // size_bytes is bigint, so it travels as text.
    assert.equal(settled.calls[0].values.at(-1), "4096");

    // False is the case that matters: a user upload landed while generation was in
    // flight, so the generated image is dropped rather than replacing their art.
    const lost = poolDatabase(() => ({ rows: [{ settled: false }] }));
    assert.equal(await new AssetManifestStore(lost.database).completeGeneration({
      workspaceId, itemId: "item-1", leaseToken: "30000000-0000-4000-8000-000000000001", bucket: "deviludo",
      objectKey: "assets/sprites/player_idle.png",
      sha256: `sha256:${"c".repeat(64)}`, sizeBytes: 4096,
    }), false);
  });

  it("releases a lease with the failure reason", async () => {
    const { database, calls } = poolDatabase(() => ({ rows: [{ released: true }] }));
    assert.equal(
      await new AssetManifestStore(database).failGeneration(
        workspaceId, "item-1", "30000000-0000-4000-8000-000000000001", "Provider 429",
      ),
      true,
    );
    assert.match(calls[0].text, /deviludo\.fail_asset_generation/);
    assert.deepEqual(calls[0].values, [
      workspaceId, "item-1", "30000000-0000-4000-8000-000000000001", "Provider 429",
    ]);
  });

  it("advances asset-ready workflows through the cross-workspace scheduler primitive", async () => {
    const { database, calls, workspaces } = poolDatabase(() => ({ rows: [{ advanced: "2" }] }));
    assert.equal(await new AssetManifestStore(database).advanceReadyWorkflows(12), 2);
    assert.match(calls[0].text, /deviludo\.advance_asset_workflows/);
    assert.deepEqual(calls[0].values, [12]);
    assert.deepEqual(workspaces, []);
  });
});
