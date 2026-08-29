import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PLATFORM_PRESETS = Object.freeze({
  linux: Object.freeze({ name: "Linux", platform: "Linux/X11", filename: "game.x86_64" }),
  windows: Object.freeze({ name: "Windows Desktop", platform: "Windows Desktop", filename: "game.exe" }),
  macos: Object.freeze({ name: "macOS", platform: "macOS", filename: "game.zip" }),
});

export async function prepareGodotProject(projectDirectory, requestedPlatforms) {
  const platforms = normalizeTargetPlatforms(requestedPlatforms);
  const projectFile = join(projectDirectory, "project.godot");
  let project;
  try {
    project = await readFile(projectFile, "utf8");
  } catch {
    throw new Error("Generated source is not a Godot project: project.godot is missing");
  }
  const declaredConfigVersion = project.match(/^\s*config_version\s*=\s*(\d+)\s*$/m)?.[1];
  if (declaredConfigVersion !== undefined && declaredConfigVersion !== "5") {
    throw new Error("Generated source is not a supported Godot 4 project");
  }
  if (!/^run\/main_scene\s*=\s*"res:\/\/.+"\s*$/m.test(project)) {
    throw new Error("Generated Godot project does not declare application/run/main_scene");
  }
  if (declaredConfigVersion === undefined) {
    // Agent-generated Godot projects can omit the editor-managed config header.
    // The remaining source is still valid Godot 4 input, so make the implicit
    // version explicit before asking the pinned Godot 4 Builder to import it.
    project = `config_version=5\n\n${project.trimStart()}`;
  }
  project = enableDesktopTextureCompression(project);
  project = await removeMissingOptionalResources(projectDirectory, project);
  await writeFile(projectFile, project, { encoding: "utf8", mode: 0o600 });

  // Export presets are build policy, not trusted project input. Replacing them
  // prevents generated source from selecting custom export templates or build
  // scripts. macOS validation builds use Godot's controlled built-in ad-hoc
  // signer so LaunchServices exercises the same native package boundary.
  await writeFile(
    join(projectDirectory, "export_presets.cfg"),
    controlledExportPresets(platforms),
    { encoding: "utf8", mode: 0o600 },
  );
  return platforms;
}

export async function godotProjectScripts(projectDirectory) {
  const scripts = [];
  await collectGodotScripts(projectDirectory, "", scripts);
  return Object.freeze(scripts);
}

function enableDesktopTextureCompression(project) {
  const setting = "textures/vram_compression/import_s3tc_bptc=true";
  if (/^textures\/vram_compression\/import_s3tc_bptc\s*=/m.test(project)) {
    return project.replace(/^textures\/vram_compression\/import_s3tc_bptc\s*=.*$/m, setting);
  }
  if (/^\[rendering\]\s*$/m.test(project)) {
    return project.replace(/^\[rendering\]\s*$/m, `[rendering]\n${setting}`);
  }
  return `${project.trimEnd()}\n\n[rendering]\n${setting}\n`;
}

async function collectGodotScripts(directory, relativeDirectory, scripts) {
  const ignoredDirectories = new Set([".deviludo-e2e", ".deviludo-export", ".git", ".godot"]);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await collectGodotScripts(join(directory, entry.name), relativePath, scripts);
      }
    } else if (entry.isFile() && entry.name.endsWith(".gd")) {
      scripts.push(relativePath);
    }
  }
}

async function removeMissingOptionalResources(projectDirectory, project) {
  const optionalKeys = new Set(["config/icon", "boot_splash/image"]);
  const normalized = [];
  for (const line of project.split("\n")) {
    const setting = line.match(/^\s*([a-z_]+\/[a-z_]+)\s*=\s*"res:\/\/([^"\\]+)"\s*$/i);
    if (!setting || !optionalKeys.has(setting[1])) {
      normalized.push(line);
      continue;
    }
    const relative = setting[2];
    if (relative.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error(`Generated Godot project has an invalid optional resource path: res://${relative}`);
    }
    try {
      await access(join(projectDirectory, relative));
      normalized.push(line);
    } catch {
      // Missing cosmetic resources must not make an otherwise playable build
      // unreleasable. Godot supplies its default application icon instead.
    }
  }
  return normalized.join("\n");
}

export function normalizeTargetPlatforms(value) {
  if (!Array.isArray(value) || value.length < 1
    || value.some(platform => !Object.hasOwn(PLATFORM_PRESETS, platform))) {
    throw new Error("Godot build targetPlatforms are required");
  }
  return Object.freeze([...new Set(value)]);
}

export function godotExportTarget(platform) {
  const target = PLATFORM_PRESETS[platform];
  if (!target) throw new Error(`Unsupported Godot export platform: ${platform}`);
  return target;
}

export function controlledExportPresets(platforms) {
  return `${platforms.map((platform, index) => {
    const target = godotExportTarget(platform);
    return [
      `[preset.${index}]`,
      "",
      `name="${target.name}"`,
      `platform="${target.platform}"`,
      "runnable=true",
      "advanced_options=false",
      "dedicated_server=false",
      'custom_features=""',
      'export_filter="all_resources"',
      'include_filter=""',
      'exclude_filter=".deviludo-export/*"',
      'export_path=""',
      "patches=PackedStringArray()",
      'encryption_include_filters=""',
      'encryption_exclude_filters=""',
      "seed=0",
      "encrypt_pck=false",
      "encrypt_directory=false",
      "script_export_mode=2",
      "",
      `[preset.${index}.options]`,
      "",
      'custom_template/debug=""',
      'custom_template/release=""',
      ...platformOptions(platform),
    ].join("\n");
  }).join("\n\n")}\n`;
}

function platformOptions(platform) {
  if (platform === "macos") {
    return [
      'binary_format/architecture="universal"',
      'application/icon=""',
      'application/bundle_identifier="io.deviludo.generated-game"',
      'application/short_version="1.0.0"',
      'application/version="1.0.0"',
      "codesign/codesign=1",
      "notarization/notarization=0",
    ];
  }
  return [
    'binary_format/architecture="x86_64"',
    "binary_format/embed_pck=false",
    "texture_format/bptc=true",
    "texture_format/s3tc=true",
    "texture_format/etc2=false",
    "texture_format/etc2_astc=false",
    ...(platform === "windows" ? ["codesign/enable=false"] : []),
  ];
}
