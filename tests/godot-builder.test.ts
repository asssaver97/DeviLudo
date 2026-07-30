import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadBuilder(): Promise<{
  prepareGodotProject: (directory: string, platforms: unknown) => Promise<readonly string[]>;
}> {
  // The runtime consumes this as native ESM inside the fixed Builder image.
  // @ts-expect-error the runtime JavaScript module intentionally has no TypeScript declaration
  return import("../services/sandbox-executor/godot-build.mjs");
}

test("Godot Builder supplies controlled export presets when Agent output omits them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-godot-builder-"));
  try {
    const { prepareGodotProject } = await loadBuilder();
    await writeFile(join(directory, "project.godot"), [
      "config_version=5",
      "[application]",
      'run/main_scene="res://main.tscn"',
      'config/icon="res://assets/missing-icon.svg"',
    ].join("\n"));
    const platforms = await prepareGodotProject(directory, ["macos", "windows", "macos"]);
    assert.deepEqual(platforms, ["macos", "windows"]);
    const presets = await readFile(join(directory, "export_presets.cfg"), "utf8");
    assert.match(presets, /name="macOS"[\s\S]*platform="macOS"/);
    assert.match(presets, /codesign\/codesign=0/);
    assert.match(presets, /name="Windows Desktop"[\s\S]*platform="Windows Desktop"/);
    assert.match(presets, /codesign\/enable=false/);
    const normalizedProject = await readFile(join(directory, "project.godot"), "utf8");
    assert.doesNotMatch(normalizedProject, /missing-icon\.svg/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Godot Builder rejects incomplete generated projects before export", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-godot-builder-invalid-"));
  try {
    const { prepareGodotProject } = await loadBuilder();
    await writeFile(join(directory, "project.godot"), "config_version=5\n");
    await assert.rejects(
      () => prepareGodotProject(directory, ["macos"]),
      /application\/run\/main_scene/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
