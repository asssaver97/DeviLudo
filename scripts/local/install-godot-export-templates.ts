#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { exportTemplateReleaseForGodot } from "../../services/local-runtime/src/export-template-catalog";
import { defaultGodotExportTemplatesRoot, installTemplateArchive } from "../../services/local-runtime/src/export-templates";

const execFileAsync = promisify(execFile);
const DEFAULT_GODOT = "/Applications/Godot.app/Contents/MacOS/Godot";
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

export interface InstallerOptions {
  readonly archivePath?: string;
  readonly godotBinary: string;
  readonly templatesRoot: string;
}

export function parseInstallerArguments(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): InstallerOptions | null {
  let archivePath: string | undefined;
  let godotBinary = environment.DEVILUDO_GODOT_BINARY || DEFAULT_GODOT;
  let templatesRoot = environment.DEVILUDO_GODOT_EXPORT_TEMPLATES_ROOT
    || defaultGodotExportTemplatesRoot(process.platform, os.homedir(), environment.APPDATA, environment.XDG_DATA_HOME);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return null;
    const next = argv[index + 1];
    if (!next) throw new Error(`${argument} requires a value`);
    if (argument === "--archive") archivePath = next;
    else if (argument === "--godot-binary") godotBinary = next;
    else if (argument === "--templates-root") templatesRoot = next;
    else throw new Error(`Unknown installer option: ${argument}`);
    index += 1;
  }
  for (const [label, value] of [["Godot binary", godotBinary], ["templates root", templatesRoot], ...(archivePath ? [["archive", archivePath]] : [])]) {
    if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  }
  return Object.freeze({ ...(archivePath ? { archivePath } : {}), godotBinary, templatesRoot });
}

export async function runInstaller(options: InstallerOptions): Promise<void> {
  const versionResult = await execFileAsync(options.godotBinary, ["--version"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024,
    timeout: 30_000,
    windowsHide: true,
    env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  const godotVersion = versionResult.stdout.trim();
  const release = exportTemplateReleaseForGodot(godotVersion);
  let temporary: string | null = null;
  try {
    let archivePath = options.archivePath;
    if (!archivePath) {
      temporary = await mkdtemp(path.join(os.tmpdir(), "deviludo-godot-templates-"));
      archivePath = path.join(temporary, release.archiveName);
      await downloadArchive(release.archiveUrl, archivePath);
    }
    const result = await installTemplateArchive({ archivePath, templatesRoot: options.templatesRoot, godotVersion });
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      godotVersion,
      templateVersion: result.manifest.templateVersion,
      archiveSha256: result.manifest.archiveSha256,
      installedFiles: result.manifest.files.length,
      directory: result.directory,
    })}\n`);
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function downloadArchive(url: string, destination: string): Promise<void> {
  const source = new URL(url);
  if (source.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(source.hostname)) throw new Error("Godot template download URL is not allowed");
  const response = await fetch(source, { redirect: "follow", signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Godot template download failed with status ${response.status}`);
  const final = new URL(response.url);
  if (final.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(final.hostname)) throw new Error("Godot template download redirected to an unapproved host");
  await pipeline(
    Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
}

function usage(): void {
  process.stdout.write(`Usage: npm run local:install-export-templates -- [options]\n\nOptions:\n  --archive <absolute-path>        Use an already downloaded official TPZ\n  --godot-binary <absolute-path>   Exact Godot executable\n  --templates-root <absolute-path> Override the standard Godot template root\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseInstallerArguments(process.argv.slice(2));
    if (!options) usage();
    else await runInstaller(options);
  } catch (error) {
    process.stderr.write(`[godot-template-installer] ${error instanceof Error ? error.message : "Installation failed"}\n`);
    process.exitCode = 1;
  }
}
