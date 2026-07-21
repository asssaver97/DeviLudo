import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GodotExportTemplateRelease } from "./export-template-catalog";
import { exportTemplateReleaseForGodot } from "./export-template-catalog";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const INSTALL_MANIFEST = ".deviludo-export-templates.json";
const MAX_TEMPLATE_FILES = 100;
const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024 * 1024;

export interface InstalledExportTemplateFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface InstalledExportTemplateManifest {
  readonly schemaVersion: 1;
  readonly godotVersion: string;
  readonly templateVersion: string;
  readonly archiveUrl: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly files: readonly InstalledExportTemplateFile[];
  readonly installedAt: string;
}

export interface MountedExportTemplates {
  readonly templateVersion: string;
  readonly archiveSha256: string;
  readonly macosTemplateSha256: string;
  readonly sourceDirectory: string;
}

export function defaultGodotExportTemplatesRoot(
  platform = process.platform,
  homeDirectory = process.env.HOME,
  appData = process.env.APPDATA,
  xdgDataHome = process.env.XDG_DATA_HOME,
): string {
  if (platform === "darwin") {
    if (!homeDirectory || !path.isAbsolute(homeDirectory)) throw new Error("A valid home directory is required for Godot templates");
    return path.join(homeDirectory, "Library", "Application Support", "Godot", "export_templates");
  }
  if (platform === "win32") {
    if (!appData || !path.isAbsolute(appData)) throw new Error("APPDATA is required for Godot templates");
    return path.join(appData, "Godot", "export_templates");
  }
  if (!homeDirectory || !path.isAbsolute(homeDirectory)) throw new Error("A valid home directory is required for Godot templates");
  return path.join(xdgDataHome && path.isAbsolute(xdgDataHome) ? xdgDataHome : path.join(homeDirectory, ".local", "share"), "godot", "export_templates");
}

export function validateTemplateArchiveEntries(entries: readonly string[]): readonly string[] {
  if (!entries.length || entries.length > MAX_TEMPLATE_FILES || new Set(entries).size !== entries.length) {
    throw new Error("Godot export template archive file list is invalid");
  }
  const normalized = entries.map((entry) => {
    if (!entry.startsWith("templates/") || entry.endsWith("/") || entry.includes("\\") || entry.includes("\0") || entry.length > 300) {
      throw new Error("Godot export template archive contains an unsafe path");
    }
    const parts = entry.split("/");
    if (parts.length !== 2 || parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error("Godot export template archive must contain one flat templates directory");
    }
    return entry;
  });
  for (const required of ["templates/version.txt", "templates/macos.zip"]) {
    if (!normalized.includes(required)) throw new Error(`Godot export template archive is missing ${required}`);
  }
  return Object.freeze([...normalized].sort());
}

export async function verifyTemplateArchive(archivePath: string, release: GodotExportTemplateRelease): Promise<void> {
  requireAbsolute(archivePath, "archive path");
  const info = await lstat(archivePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== release.archiveBytes) {
    throw new Error("Godot export template archive size or type is invalid");
  }
  if (await sha256File(archivePath) !== release.archiveSha256) {
    throw new Error("Godot export template archive digest is invalid");
  }
  const result = await execFileAsync("/usr/bin/unzip", ["-Z1", archivePath], {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  validateTemplateArchiveEntries(result.stdout.split(/\r?\n/).filter(Boolean));
}

export async function installTemplateArchive(options: {
  readonly archivePath: string;
  readonly templatesRoot: string;
  readonly godotVersion: string;
}): Promise<{ readonly status: "INSTALLED" | "ALREADY_INSTALLED"; readonly manifest: InstalledExportTemplateManifest; readonly directory: string }> {
  const release = exportTemplateReleaseForGodot(options.godotVersion);
  requireAbsolute(options.templatesRoot, "templates root");
  await verifyTemplateArchive(options.archivePath, release);
  await mkdir(options.templatesRoot, { recursive: true, mode: 0o755 });
  await requireRealDirectory(options.templatesRoot, "templates root");
  const destination = path.join(options.templatesRoot, release.templateVersion);
  const existing = await readInstalledManifest(destination, release);
  if (existing) {
    await verifyInstalledFiles(destination, existing);
    await chmod(destination, 0o555);
    return Object.freeze({ status: "ALREADY_INSTALLED", manifest: existing, directory: destination });
  }
  if (await pathExists(destination)) throw new Error("An unverified Godot template installation already exists");

  const staging = path.join(options.templatesRoot, `.deviludo-${release.templateVersion}-${process.pid}-${Date.now()}`);
  const extracted = path.join(staging, "extracted");
  await mkdir(extracted, { recursive: true, mode: 0o700 });
  let outcome: { readonly status: "INSTALLED"; readonly manifest: InstalledExportTemplateManifest; readonly directory: string } | null = null;
  let installationError: unknown = null;
  try {
    await execFileAsync("/usr/bin/unzip", ["-q", options.archivePath, "-d", extracted], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: 15 * 60_000,
      windowsHide: true,
    });
    const templateDirectory = path.join(extracted, "templates");
    const files = await inspectExtractedTemplates(templateDirectory);
    const version = (await readFile(path.join(templateDirectory, "version.txt"), "utf8")).trim();
    if (version !== release.templateVersion) throw new Error("Extracted Godot template version does not match the engine");
    const manifest: InstalledExportTemplateManifest = Object.freeze({
      schemaVersion: 1,
      godotVersion: release.godotVersion,
      templateVersion: release.templateVersion,
      archiveUrl: release.archiveUrl,
      archiveBytes: release.archiveBytes,
      archiveSha256: release.archiveSha256,
      files,
      installedAt: new Date().toISOString(),
    });
    await writeFile(path.join(templateDirectory, INSTALL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o444,
    });
    for (const file of files) await chmod(path.join(templateDirectory, file.path), 0o444);
    await rename(templateDirectory, destination);
    await chmod(destination, 0o555);
    outcome = Object.freeze({ status: "INSTALLED", manifest, directory: destination });
  } catch (error) {
    installationError = error;
  }
  try {
    await cleanupTemplateStaging(staging, path.join(extracted, "templates"));
  } catch (cleanupError) {
    installationError ??= cleanupError;
  }
  if (installationError) throw installationError;
  if (!outcome) throw new Error("Godot export template installation did not produce a result");
  return outcome;
}

export async function cleanupTemplateStaging(staging: string, templateDirectory: string): Promise<void> {
  requireAbsolute(staging, "template staging path");
  requireAbsolute(templateDirectory, "template staging directory");
  const relative = path.relative(staging, templateDirectory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Template cleanup path escapes its staging directory");
  }
  try { await chmod(templateDirectory, 0o700); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(staging, { recursive: true, force: true });
}

export async function mountExportTemplates(options: {
  readonly runtimeHome: string;
  readonly templatesRoot: string;
  readonly godotVersion: string;
  readonly platform?: NodeJS.Platform;
}): Promise<MountedExportTemplates | null> {
  requireAbsolute(options.runtimeHome, "runtime home");
  requireAbsolute(options.templatesRoot, "templates root");
  const release = exportTemplateReleaseForGodot(options.godotVersion);
  const sourceDirectory = path.join(options.templatesRoot, release.templateVersion);
  const manifest = await readInstalledManifest(sourceDirectory, release);
  if (!manifest) return null;
  const macos = manifest.files.find((file) => file.path === "macos.zip");
  if (!macos || !SHA256.test(macos.sha256) || await sha256File(path.join(sourceDirectory, macos.path)) !== macos.sha256) {
    throw new Error("Installed macOS export template failed integrity verification");
  }
  const mountRoot = isolatedTemplatesRoot(options.runtimeHome, options.platform ?? process.platform);
  await mkdir(mountRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(mountRoot, release.templateVersion);
  if (await pathExists(destination)) {
    if (await realpath(destination) !== await realpath(sourceDirectory)) throw new Error("Isolated Godot template mount already points elsewhere");
  } else {
    await symlink(await realpath(sourceDirectory), destination, "dir");
  }
  return Object.freeze({
    templateVersion: release.templateVersion,
    archiveSha256: release.archiveSha256,
    macosTemplateSha256: macos.sha256,
    sourceDirectory: await realpath(sourceDirectory),
  });
}

async function readInstalledManifest(directory: string, release: GodotExportTemplateRelease): Promise<InstalledExportTemplateManifest | null> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path.join(directory, INSTALL_MANIFEST), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Installed Godot template manifest is invalid");
  }
  const item = raw as Partial<InstalledExportTemplateManifest>;
  if (item.schemaVersion !== 1 || item.godotVersion !== release.godotVersion || item.templateVersion !== release.templateVersion
    || item.archiveUrl !== release.archiveUrl || item.archiveBytes !== release.archiveBytes || item.archiveSha256 !== release.archiveSha256
    || !Array.isArray(item.files) || !item.files.length || typeof item.installedAt !== "string") {
    throw new Error("Installed Godot template manifest does not match the pinned release");
  }
  for (const file of item.files) {
    if (!file || typeof file.path !== "string" || !safeTemplateFile(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !SHA256.test(file.sha256)) {
      throw new Error("Installed Godot template manifest contains an invalid file");
    }
  }
  await requireRealDirectory(directory, "installed template directory");
  return item as InstalledExportTemplateManifest;
}

async function inspectExtractedTemplates(directory: string): Promise<readonly InstalledExportTemplateFile[]> {
  await requireRealDirectory(directory, "extracted template directory");
  const entries = await readdir(directory, { withFileTypes: true });
  if (!entries.length || entries.length > MAX_TEMPLATE_FILES) throw new Error("Extracted Godot template file count is invalid");
  let bytes = 0;
  const files: InstalledExportTemplateFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !safeTemplateFile(entry.name)) throw new Error("Extracted Godot templates contain an unsafe entry");
    const file = path.join(directory, entry.name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error("Extracted Godot template file is invalid");
    bytes += info.size;
    if (bytes > MAX_TEMPLATE_BYTES) throw new Error("Extracted Godot templates exceed the size limit");
    files.push(Object.freeze({ path: entry.name, bytes: info.size, sha256: await sha256File(file) }));
  }
  for (const required of ["version.txt", "macos.zip"]) {
    if (!files.some((file) => file.path === required)) throw new Error(`Extracted Godot templates are missing ${required}`);
  }
  return Object.freeze(files);
}

async function verifyInstalledFiles(directory: string, manifest: InstalledExportTemplateManifest): Promise<void> {
  for (const file of manifest.files) {
    const target = path.join(directory, file.path);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || await sha256File(target) !== file.sha256) {
      throw new Error("Installed Godot export template file failed integrity verification");
    }
  }
}

function isolatedTemplatesRoot(runtimeHome: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return path.join(runtimeHome, "Library", "Application Support", "Godot", "export_templates");
  if (platform === "win32") return path.join(runtimeHome, "AppData", "Roaming", "Godot", "export_templates");
  return path.join(runtimeHome, ".local", "share", "godot", "export_templates");
}

function safeTemplateFile(value: string): boolean {
  return Boolean(value) && value.length <= 200 && !value.includes("/") && !value.includes("\\") && !value.includes("\0") && value !== "." && value !== "..";
}

async function requireRealDirectory(directory: string, label: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function pathExists(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const input = createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => digest.update(chunk));
    input.on("end", () => resolve(digest.digest("hex")));
  });
}

function requireAbsolute(value: string, label: string): void {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${label} must be an absolute path`);
}
