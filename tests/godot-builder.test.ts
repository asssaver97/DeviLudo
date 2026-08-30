import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadBuilder(): Promise<{
  godotProjectScripts: (directory: string) => Promise<readonly string[]>;
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
    assert.match(presets, /codesign\/codesign=1/);
    assert.match(presets, /name="Windows Desktop"[\s\S]*platform="Windows Desktop"/);
    assert.match(presets, /codesign\/enable=false/);
    const normalizedProject = await readFile(join(directory, "project.godot"), "utf8");
    assert.doesNotMatch(normalizedProject, /missing-icon\.svg/);
    assert.match(normalizedProject, /textures\/vram_compression\/import_s3tc_bptc=true/);
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

test("Godot Builder normalizes an Agent-generated Godot 4 project without a config header", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-godot-builder-no-version-"));
  try {
    const { prepareGodotProject } = await loadBuilder();
    await writeFile(join(directory, "project.godot"), [
      "[application]",
      'config/name="Generated Game"',
      'run/main_scene="res://main.tscn"',
      "",
      "[rendering]",
      'renderer/rendering_method="gl_compatibility"',
    ].join("\n"));

    await prepareGodotProject(directory, ["macos"]);

    const normalizedProject = await readFile(join(directory, "project.godot"), "utf8");
    assert.match(normalizedProject, /^config_version=5\n\n\[application\]/);
    assert.match(normalizedProject, /\[rendering\]\ntextures\/vram_compression\/import_s3tc_bptc=true/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Godot Builder overrides disabled desktop texture compression required by native exports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-godot-builder-textures-"));
  try {
    const { prepareGodotProject } = await loadBuilder();
    await writeFile(join(directory, "project.godot"), [
      "config_version=5",
      "[application]",
      'run/main_scene="res://main.tscn"',
      "[rendering]",
      "textures/vram_compression/import_s3tc_bptc=false",
    ].join("\n"));

    await prepareGodotProject(directory, ["macos"]);

    const normalizedProject = await readFile(join(directory, "project.godot"), "utf8");
    assert.match(normalizedProject, /textures\/vram_compression\/import_s3tc_bptc=true/);
    assert.doesNotMatch(normalizedProject, /import_s3tc_bptc=false/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Godot Builder still rejects projects that explicitly declare an older config version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-godot-builder-old-version-"));
  try {
    const { prepareGodotProject } = await loadBuilder();
    await writeFile(join(directory, "project.godot"), [
      "config_version=4",
      "[application]",
      'run/main_scene="res://main.tscn"',
    ].join("\n"));

    await assert.rejects(
      () => prepareGodotProject(directory, ["macos"]),
      /supported Godot 4 project/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Godot Builder discovers source scripts deterministically without generated caches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-godot-builder-scripts-"));
  try {
    const { godotProjectScripts } = await loadBuilder();
    await mkdir(join(directory, "src", "nested"), { recursive: true });
    await mkdir(join(directory, ".godot"), { recursive: true });
    await mkdir(join(directory, ".deviludo-export"), { recursive: true });
    await writeFile(join(directory, "main.gd"), "extends Node\n");
    await writeFile(join(directory, "src", "state.gd"), "extends RefCounted\n");
    await writeFile(join(directory, "src", "nested", "view.gd"), "extends Control\n");
    await writeFile(join(directory, ".godot", "generated.gd"), "invalid cache\n");
    await writeFile(join(directory, ".deviludo-export", "packaged.gd"), "invalid export\n");

    assert.deepEqual(await godotProjectScripts(directory), [
      "main.gd",
      "src/nested/view.gd",
      "src/state.gd",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
