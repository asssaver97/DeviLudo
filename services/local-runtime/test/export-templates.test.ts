import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportTemplateReleaseForGodot, templateVersionFromGodotVersion } from "../src/export-template-catalog";
import { cleanupTemplateStaging, mountExportTemplates, validateTemplateArchiveEntries } from "../src/export-templates";

const godotVersion = "4.6.2.stable.official.71f334935";

test("Godot export template catalog pins the exact official engine and archive", () => {
  assert.equal(templateVersionFromGodotVersion(godotVersion), "4.6.2.stable");
  const release = exportTemplateReleaseForGodot(godotVersion);
  assert.equal(release.archiveBytes, 1_251_900_388);
  assert.equal(release.archiveSha256, "942366dc4e27e7686a99da4d3cfb1b8ae8d3eb9444f6d8217eef16245b599ef2");
  assert.throws(() => exportTemplateReleaseForGodot("4.6.2.stable.official.bad"), /not pinned|not an exact/);
});

test("template archive paths must be flat, complete and traversal-free", () => {
  assert.deepEqual(validateTemplateArchiveEntries(["templates/version.txt", "templates/macos.zip"]), [
    "templates/macos.zip",
    "templates/version.txt",
  ]);
  assert.throws(() => validateTemplateArchiveEntries(["templates/version.txt", "../macos.zip"]), /unsafe path/);
  assert.throws(() => validateTemplateArchiveEntries(["templates/version.txt"]), /missing templates\/macos.zip/);
  assert.throws(() => validateTemplateArchiveEntries(["templates/version.txt", "templates/nested/macos.zip"]), /flat templates/);
});

test("verified templates mount into an isolated macOS HOME and detect tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deviludo-template-mount-"));
  try {
    const release = exportTemplateReleaseForGodot(godotVersion);
    const templatesRoot = path.join(root, "templates-root");
    const source = path.join(templatesRoot, release.templateVersion);
    const runtimeHome = path.join(root, "runtime-home");
    await mkdir(source, { recursive: true });
    const macosBytes = Buffer.from("fixed-macos-template");
    const macosDigest = createHash("sha256").update(macosBytes).digest("hex");
    await writeFile(path.join(source, "macos.zip"), macosBytes);
    await writeFile(path.join(source, "version.txt"), `${release.templateVersion}\n`);
    await writeFile(path.join(source, ".deviludo-export-templates.json"), JSON.stringify({
      schemaVersion: 1,
      godotVersion,
      templateVersion: release.templateVersion,
      archiveUrl: release.archiveUrl,
      archiveBytes: release.archiveBytes,
      archiveSha256: release.archiveSha256,
      files: [
        { path: "macos.zip", bytes: macosBytes.byteLength, sha256: macosDigest },
        { path: "version.txt", bytes: Buffer.byteLength(`${release.templateVersion}\n`), sha256: createHash("sha256").update(`${release.templateVersion}\n`).digest("hex") },
      ],
      installedAt: "2026-07-21T00:00:00.000Z",
    }));

    const mounted = await mountExportTemplates({ runtimeHome, templatesRoot, godotVersion, platform: "darwin" });
    assert.equal(mounted?.macosTemplateSha256, macosDigest);
    const link = path.join(runtimeHome, "Library", "Application Support", "Godot", "export_templates", release.templateVersion);
    assert.equal(await realpath(link), await realpath(source));
    assert.equal(await readFile(path.join(link, "macos.zip"), "utf8"), "fixed-macos-template");

    await writeFile(path.join(source, "macos.zip"), "tampered");
    await assert.rejects(
      mountExportTemplates({ runtimeHome: path.join(root, "second-home"), templatesRoot, godotVersion, platform: "darwin" }),
      /integrity verification/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("template staging cleanup handles both read-only and already-moved template directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deviludo-template-cleanup-"));
  const first = path.join(root, "first");
  const firstTemplates = path.join(first, "extracted", "templates");
  await mkdir(firstTemplates, { recursive: true });
  await writeFile(path.join(firstTemplates, "macos.zip"), "temporary");
  await chmod(firstTemplates, 0o555);
  await cleanupTemplateStaging(first, firstTemplates);
  await assert.rejects(realpath(first), /ENOENT/);

  const second = path.join(root, "second");
  const movedTemplates = path.join(second, "extracted", "templates");
  await mkdir(path.dirname(movedTemplates), { recursive: true });
  await cleanupTemplateStaging(second, movedTemplates);
  await assert.rejects(realpath(second), /ENOENT/);
  await assert.rejects(cleanupTemplateStaging(root, path.join(root, "..", "escape")), /escapes/);
  await rm(root, { recursive: true, force: true });
});
