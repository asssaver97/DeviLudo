import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  removeRetiredSourceImages,
  retiredSourceImagePaths,
} from "../services/sandbox-executor/asset-garbage-collection.mjs";

function manifest(items: readonly Record<string, unknown>[]) {
  return { assetManifest: { schemaVersion: "deviludo.asset-manifest.v1", items } };
}

test("source cleanup retires only images removed from the accepted Manifest", () => {
  const previous = manifest([
    { assetKey: "ui/old-panel", status: "existing", sourcePath: "art/ui/old-panel.png" },
    { assetKey: "ui/keep-panel", status: "existing", sourcePath: "art/ui/keep-panel.png" },
    { assetKey: "unsafe", status: "existing", sourcePath: "../outside.png" },
  ]);
  const current = manifest([
    { assetKey: "ui/keep-panel" },
    { assetKey: "ui/new-panel" },
  ]);

  assert.deepEqual(retiredSourceImagePaths(previous, current), ["art/ui/old-panel.png"]);
  assert.deepEqual(retiredSourceImagePaths(previous, { invalid: true }), []);
});

test("source cleanup preserves an explicitly reused path after an asset rename", () => {
  const previous = manifest([
    { assetKey: "ui/old-key", status: "existing", sourcePath: "art/ui/shared.webp" },
  ]);
  const current = manifest([
    { assetKey: "ui/new-key", status: "existing", sourcePath: "art/ui/shared.webp" },
  ]);

  assert.deepEqual(retiredSourceImagePaths(previous, current), []);
});

test("source cleanup deletes only the retired files inventoried by the prior Manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-source-assets-"));
  try {
    await mkdir(join(root, "art/ui"), { recursive: true });
    await writeFile(join(root, "art/ui/old.png"), "old");
    await writeFile(join(root, "art/ui/keep.png"), "keep");
    await writeFile(join(root, "untracked.png"), "untracked");
    const previous = manifest([
      { assetKey: "ui/old", status: "existing", sourcePath: "art/ui/old.png" },
      { assetKey: "ui/keep", status: "existing", sourcePath: "art/ui/keep.png" },
    ]);
    const current = manifest([{ assetKey: "ui/keep" }]);

    assert.deepEqual(await removeRetiredSourceImages(root, previous, current), ["art/ui/old.png"]);
    await assert.rejects(access(join(root, "art/ui/old.png")), { code: "ENOENT" });
    await access(join(root, "art/ui/keep.png"));
    await access(join(root, "untracked.png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
