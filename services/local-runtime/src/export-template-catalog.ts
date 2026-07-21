export interface GodotExportTemplateRelease {
  readonly godotVersion: string;
  readonly templateVersion: string;
  readonly archiveName: string;
  readonly archiveUrl: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
}

const releases = Object.freeze({
  "4.6.2.stable": Object.freeze({
    godotVersion: "4.6.2.stable.official.71f334935",
    templateVersion: "4.6.2.stable",
    archiveName: "Godot_v4.6.2-stable_export_templates.tpz",
    archiveUrl: "https://github.com/godotengine/godot-builds/releases/download/4.6.2-stable/Godot_v4.6.2-stable_export_templates.tpz",
    archiveBytes: 1_251_900_388,
    archiveSha256: "942366dc4e27e7686a99da4d3cfb1b8ae8d3eb9444f6d8217eef16245b599ef2",
  }),
} satisfies Readonly<Record<string, GodotExportTemplateRelease>>);

export function templateVersionFromGodotVersion(godotVersion: string): string {
  const match = /^(\d+\.\d+\.\d+)\.(stable|rc\d+|beta\d+|dev\d+)\.official\.[a-f0-9]+$/.exec(godotVersion);
  if (!match) throw new Error("Godot version is not an exact official build");
  return `${match[1]}.${match[2]}`;
}

export function exportTemplateReleaseForGodot(godotVersion: string): GodotExportTemplateRelease {
  const templateVersion = templateVersionFromGodotVersion(godotVersion);
  const release = releases[templateVersion as keyof typeof releases];
  if (!release || release.godotVersion !== godotVersion) {
    throw new Error("Godot export templates are not pinned for this exact engine build");
  }
  return release;
}
