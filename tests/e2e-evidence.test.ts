import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import {
  E2E_CLIENT_HEIGHT,
  E2E_CLIENT_WIDTH,
  E2E_EVIDENCE_PROTOCOL,
  compareScreenshots,
  createEvidenceBundle,
  encodeRgbaPng,
  extractAndValidateEvidenceBundle,
  godotErrorLines,
  inspectScreenshot,
} from "../scripts/e2e-evidence.mjs";

const execute = promisify(execFile);

function testImage(changed = false): Buffer {
  const pixels = Buffer.alloc(E2E_CLIENT_WIDTH * E2E_CLIENT_HEIGHT * 4);
  for (let y = 0; y < E2E_CLIENT_HEIGHT; y += 1) {
    for (let x = 0; x < E2E_CLIENT_WIDTH; x += 1) {
      const offset = (y * E2E_CLIENT_WIDTH + x) * 4;
      pixels[offset] = (x + (changed && x < 20 ? 80 : 0)) % 256;
      pixels[offset + 1] = y % 256;
      pixels[offset + 2] = (x + y) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return encodeRgbaPng(E2E_CLIENT_WIDTH, E2E_CLIENT_HEIGHT, pixels);
}

describe("E2E evidence", () => {
  test("rejects blank or substantially transparent screenshots and accepts system window corners", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deviludo-evidence-test-"));
    try {
      const valid = join(directory, "valid.png");
      const blank = join(directory, "blank.png");
      const roundedCorners = join(directory, "rounded-corners.png");
      const translucent = join(directory, "translucent.png");
      await writeFile(valid, testImage());
      const pixels = Buffer.alloc(E2E_CLIENT_WIDTH * E2E_CLIENT_HEIGHT * 4, 127);
      for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
      await writeFile(blank, encodeRgbaPng(E2E_CLIENT_WIDTH, E2E_CLIENT_HEIGHT, pixels));
      const roundedCornerPixels = Buffer.from(testImagePixels());
      roundedCornerPixels[3] = 0;
      await writeFile(roundedCorners, encodeRgbaPng(E2E_CLIENT_WIDTH, E2E_CLIENT_HEIGHT, roundedCornerPixels));
      const translucentPixels = Buffer.from(testImagePixels());
      for (let offset = 3; offset < translucentPixels.length / 100; offset += 4) translucentPixels[offset] = 0;
      await writeFile(translucent, encodeRgbaPng(E2E_CLIENT_WIDTH, E2E_CLIENT_HEIGHT, translucentPixels));
      const details = await inspectScreenshot(valid);
      assert.equal(details.width, E2E_CLIENT_WIDTH);
      await inspectScreenshot(roundedCorners);
      await assert.rejects(inspectScreenshot(blank), /blank or nearly solid/);
      await assert.rejects(inspectScreenshot(translucent), /too many transparent or translucent/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("compares RGBA pixels and emits a diff PNG when the threshold fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deviludo-evidence-test-"));
    try {
      const reference = join(directory, "reference.png");
      const actual = join(directory, "actual.png");
      const diff = join(directory, "diff.png");
      await writeFile(reference, testImage());
      await writeFile(actual, testImage(true));
      const comparison = await compareScreenshots(actual, reference, diff, 0.001);
      assert.equal(comparison.passed, false);
      assert.ok((await readFile(diff)).length > 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("creates and verifies a ZIP with HTML, JSON, logs, screenshot and digests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deviludo-evidence-test-"));
    try {
      const screenshot = join(directory, "capture.png");
      await writeFile(screenshot, testImage());
      const jobId = "11111111-1111-4111-8111-111111111111";
      const report = {
        schemaVersion: E2E_EVIDENCE_PROTOCOL,
        jobId,
        platform: "macos",
        outcome: "PASSED",
        summary: "核心循环通过",
        checkpoints: [{ checkpointId: "game-start", status: "PASSED", screenshot: "screenshots/game-start.png" }],
      };
      const bundle = await createEvidenceBundle({ outputRoot: directory, jobId, platform: "macos", report, stdout: "ok", stderr: "", screenshots: [{ id: "game-start", path: screenshot }] });
      const extracted = join(directory, "extracted");
      const validated = await extractAndValidateEvidenceBundle(bundle.outputPath, extracted);
      assert.equal(validated.report.outcome, "PASSED");
      assert.match(await readFile(validated.indexPath, "utf8"), /data:image\/png;base64/);
      assert.ok((validated.manifest.files as unknown[]).length >= 5);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("detects Godot script errors even when a process exits zero", () => {
    assert.deepEqual(godotErrorLines("exit 0", "SCRIPT ERROR: Parse Error: Identifier missing"), ["SCRIPT ERROR: Parse Error: Identifier missing"]);
  });

  test("rejects symlinks before extracting an evidence ZIP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deviludo-evidence-test-"));
    try {
      const source = join(directory, "source");
      await mkdir(source);
      await symlink("/private/tmp", join(source, "escape"));
      const archive = join(directory, "unsafe.zip");
      await execute("zip", ["-q", "-y", archive, "escape"], { cwd: source });
      await assert.rejects(extractAndValidateEvidenceBundle(archive, join(directory, "output")), /symbolic links/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

function testImagePixels(): Buffer {
  const pixels = Buffer.alloc(E2E_CLIENT_WIDTH * E2E_CLIENT_HEIGHT * 4);
  for (let y = 0; y < E2E_CLIENT_HEIGHT; y += 1) {
    for (let x = 0; x < E2E_CLIENT_WIDTH; x += 1) {
      const offset = (y * E2E_CLIENT_WIDTH + x) * 4;
      pixels[offset] = x % 256;
      pixels[offset + 1] = y % 256;
      pixels[offset + 2] = (x + y) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}
