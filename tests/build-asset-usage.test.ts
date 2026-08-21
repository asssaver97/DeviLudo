import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertBuildAssetsReferenced,
  missingBuildAssetReferences,
} from "../services/sandbox-executor/build-asset-usage.mjs";

test("generated build assets must be referenced by runtime source", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-asset-usage-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "main.gd"), [
      "const MENU_ART = \"backgrounds/menu\"",
      "var badge = load(\"res://assets/generated/ui/badge.png\")",
      "# \"skills/comment-only\" must not count",
    ].join("\n"));
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "tests", "asset_test.gd"), "const UNUSED = \"skills/test-only\"\n");
    await writeFile(join(root, "agent.json"), JSON.stringify({ assetManifest: {
      items: [{ assetKey: "regions/manifest-only" }],
    } }));

    const missing = await missingBuildAssetReferences(root, [
      "backgrounds/menu", "ui/badge", "skills/comment-only", "skills/test-only", "regions/manifest-only",
    ]);
    assert.deepEqual(missing, ["regions/manifest-only", "skills/comment-only", "skills/test-only"]);
    await assert.rejects(
      assertBuildAssetsReferenced(root, ["backgrounds/menu", "regions/manifest-only"]),
      /Generated assets were materialized but are not referenced by runtime source: regions\/manifest-only/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
