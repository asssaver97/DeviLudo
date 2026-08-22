import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import {
  E2E_CLIENT_HEIGHT,
  E2E_CLIENT_WIDTH,
  E2E_EVIDENCE_SCHEMA,
  compareScreenshotRegion,
  compareScreenshots,
  captureAndInspectScreenshot,
  createEvidenceBundle,
  encodeRgbaPng,
  extractAndValidateEvidenceBundle,
  godotErrorLines,
  inspectScreenshot,
  inspectScreenshotRegion,
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

  test("waits for the native game frame to replace a transient solid launch frame", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deviludo-evidence-ready-"));
    try {
      const screenshot = join(directory, "capture.png");
      const blankPixels = Buffer.alloc(E2E_CLIENT_WIDTH * E2E_CLIENT_HEIGHT * 4, 127);
      for (let offset = 3; offset < blankPixels.length; offset += 4) blankPixels[offset] = 255;
      let captures = 0;
      const details = await captureAndInspectScreenshot(screenshot, async path => {
        captures += 1;
        await writeFile(path, captures === 1
          ? encodeRgbaPng(E2E_CLIENT_WIDTH, E2E_CLIENT_HEIGHT, blankPixels)
          : testImage());
      }, { attempts: 2, delayMs: 0 });
      assert.equal(captures, 2);
      assert.equal(details.width, E2E_CLIENT_WIDTH);
      await assert.rejects(captureAndInspectScreenshot(screenshot, async path => {
        await writeFile(path, encodeRgbaPng(E2E_CLIENT_WIDTH, E2E_CLIENT_HEIGHT, blankPixels));
      }, { attempts: 2, delayMs: 0 }), /blank or nearly solid/);
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

  test("measures change only inside the declared semantic UI region", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deviludo-evidence-region-"));
    try {
      const reference = join(directory, "reference.png");
      const actual = join(directory, "actual.png");
      const diff = join(directory, "region-diff.png");
      await writeFile(reference, testImage());
      await writeFile(actual, testImage(true));
      const changed = await compareScreenshotRegion(actual, reference, { x: 0, y: 0, width: 20, height: 720 }, diff);
      const unchanged = await compareScreenshotRegion(actual, reference, { x: 30, y: 0, width: 20, height: 720 });
      assert.equal(changed.differenceRatio, 1);
      assert.equal(unchanged.differenceRatio, 0);
      assert.ok((await readFile(diff)).length > 0);
      await assert.rejects(compareScreenshotRegion(actual, reference, { x: 1270, y: 0, width: 20, height: 720 }), /region is invalid/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("records nonblank pixel evidence for a planned asset's rendered control region", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deviludo-asset-region-"));
    try {
      const screenshot = join(directory, "asset.png");
      await writeFile(screenshot, testImage());
      const evidence = await inspectScreenshotRegion(screenshot, { x: 100, y: 120, width: 240, height: 96 });
      assert.ok(evidence.uniqueColorCount > 2);
      assert.ok(evidence.dominantPixelRatio < 0.9995);
      assert.match(evidence.pixelSha256, /^sha256:[0-9a-f]{64}$/);
      await assert.rejects(
        inspectScreenshotRegion(screenshot, { x: 1270, y: 0, width: 20, height: 20 }),
        /region is invalid/,
      );
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("creates and verifies a ZIP with HTML, JSON, logs, screenshot and digests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deviludo-evidence-test-"));
    try {
      const screenshot = join(directory, "capture.png");
      await writeFile(screenshot, testImage());
      const jobId = "11111111-1111-4111-8111-111111111111";
      const report = {
        schema: E2E_EVIDENCE_SCHEMA,
        jobId,
        platform: "macos",
        outcome: "PASSED",
        summary: "核心循环通过",
        performance: {
          schema: "deviludo.e2e-performance.v1", passed: true,
          thresholds: { criticalMinimumFps: 5, minimumMedianFps: 30, maximumP95InputResponseMs: 1500 },
          frameRate: { sampleCount: 12, minimumFps: 55, medianFps: 60 },
          inputResponse: { sampleCount: 4, p95Ms: 120 },
        },
        checkpoints: [{ checkpointId: "game-start", status: "PASSED", screenshot: "screenshots/game-start.png" }],
      };
      const bundle = await createEvidenceBundle({ outputRoot: directory, jobId, platform: "macos", report, stdout: "ok", stderr: "", screenshots: [{ id: "game-start", path: screenshot }] });
      const extracted = join(directory, "extracted");
      const validated = await extractAndValidateEvidenceBundle(bundle.outputPath, extracted);
      assert.equal(validated.report.outcome, "PASSED");
      const html = await readFile(validated.indexPath, "utf8");
      assert.match(html, /data:image\/png;base64/);
      assert.match(html, /Test Agent 自适应游玩与 Oracle/);
      assert.match(html, /Test Agent Adaptive Play & Oracles/);
      assert.match(html, /当前回归轨迹/);
      assert.match(html, /Current Regression Trace/);
      assert.match(html, /完整游戏视频/);
      assert.match(html, /Complete Gameplay Videos/);
      assert.match(html, /游戏流畅度/);
      assert.match(html, /Runtime Smoothness/);
      assert.match(html, /55/);
      assert.match(html, /data-i18n="completeVideos"/);
      assert.match(html, /p\.get\("locale"\)===\"en\"/);
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

  test("enforces the aggregate 768 MiB video budget before copying evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deviludo-evidence-video-budget-"));
    try {
      const first = join(directory, "first.mp4");
      const second = join(directory, "second.mp4");
      await Promise.all([writeFile(first, ""), writeFile(second, "")]);
      await truncate(first, 400 * 1024 * 1024);
      await truncate(second, 400 * 1024 * 1024);
      await assert.rejects(createEvidenceBundle({
        outputRoot: directory,
        jobId: "11111111-1111-4111-8111-111111111111",
        platform: "linux",
        report: { schema: E2E_EVIDENCE_SCHEMA, outcome: "FAILED" },
        videos: [{ id: "first", path: first }, { id: "second", path: second }],
      }), /aggregate target limit/);
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
