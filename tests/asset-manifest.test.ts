import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateAssetManifest,
  validateAssetItem,
  ASSET_TYPES,
  ASSET_ITEM_STATUSES,
  ASSET_MANIFEST_STATUSES,
} from "../lib/product/asset-manifest.js";

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
