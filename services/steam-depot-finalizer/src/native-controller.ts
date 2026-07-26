import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createEvidencePackage, type EvidencePackageEntry } from "../../godot-testkit/src/evidence-package";
import { canonicalJson } from "../../runner-control/src/canonical";
import {
  notarizationEvidenceObjectKey,
  signedDepotObjectKey,
  signingEvidenceObjectKey,
  type SteamDepotSigningScheme,
} from "../../steam-publisher/src/depot-finalization";
import { validateSteamDepotFinalizationReceipt } from "./contract";
import type {
  SteamDepotFinalizationReceipt,
  SteamDepotFinalizationRequest,
  SteamDepotNativeFinalizer,
} from "./contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const TAR_BLOCK = 512;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 100_000;
const FORBIDDEN_EVIDENCE = /api.?key|authorization|bearer|password|secret|token|config\.vdf|private.?key/i;

export interface SteamDepotArtifactStore {
  probe(): Promise<void>;
  download(input: Readonly<{ objectKey: string; artifactDigest: string; maximumBytes: number }>): Promise<Buffer>;
  putImmutable(input: Readonly<{
    objectKey: string;
    artifactDigest: string;
    contentType: "application/json" | "application/octet-stream";
    body: Buffer;
  }>): Promise<void>;
}

export interface SteamDepotSigningResult {
  readonly signingIdentityDigest: string;
  readonly signingEvidence: Buffer;
  readonly notarizationEvidence: Buffer | null;
}

export interface SteamDepotPlatformSigner {
  readonly platform: SteamDepotFinalizationRequest["platform"];
  readonly signingScheme: SteamDepotSigningScheme;
  probe(): Promise<void>;
  sign(input: Readonly<{
    request: SteamDepotFinalizationRequest;
    exportRoot: string;
    signingTarget: string;
  }>): Promise<SteamDepotSigningResult>;
}

type ExportManifest = Readonly<{
  schemaVersion: "deviludo.production-export-evidence.v1";
  jobDigest: string;
  platform: SteamDepotFinalizationRequest["platform"];
  files: readonly Readonly<{ index: number; path: string; sha256: string; sizeBytes: number }>[];
}>;

/** Content-addressed controller around one platform-native signing adapter. */
export class NativeSteamDepotController implements SteamDepotNativeFinalizer {
  readonly #artifacts: SteamDepotArtifactStore;
  readonly #signer: SteamDepotPlatformSigner;
  readonly #workRoot: string;

  constructor(options: Readonly<{
    artifacts: SteamDepotArtifactStore;
    signer: SteamDepotPlatformSigner;
    workRoot: string;
  }>) {
    this.#artifacts = options.artifacts;
    this.#signer = options.signer;
    this.#workRoot = absolute(options.workRoot);
    if (this.#signer.signingScheme !== scheme(this.#signer.platform)) invalid("signer scheme");
  }

  async probe(): Promise<void> {
    await verifyDirectory(this.#workRoot);
    await Promise.all([this.#artifacts.probe(), this.#signer.probe()]);
  }

  async finalize(request: SteamDepotFinalizationRequest): Promise<SteamDepotFinalizationReceipt> {
    if (request.platform !== this.#signer.platform) invalid("signer platform");
    await verifyDirectory(this.#workRoot);
    const source = await this.#artifacts.download({
      objectKey: request.sourceObjectKey,
      artifactDigest: request.sourceArtifactDigest,
      maximumBytes: MAX_PACKAGE_BYTES,
    });
    if (!Buffer.isBuffer(source) || source.byteLength < TAR_BLOCK * 3 || source.byteLength > MAX_PACKAGE_BYTES
      || digest(source) !== request.sourceArtifactDigest) invalid("source artifact");
    const runRoot = await mkdtemp(join(this.#workRoot, `finalize-${request.releaseId}-${request.platform}-`));
    try {
      const exportRoot = join(runRoot, "export");
      await mkdir(exportRoot, { mode: 0o700 });
      const manifest = await extractProductionExport(source, exportRoot, request.platform);
      const signingTarget = await platformSigningTarget(exportRoot, manifest);
      const result = await this.#signer.sign({ request, exportRoot, signingTarget });
      validateSigningResult(result, request, this.#signer.signingScheme);
      const entries = await finalizedEntries(exportRoot, manifest);
      const packagePath = join(runRoot, "finalized-production-export.tar");
      await createEvidencePackage(packagePath, entries);
      const finalized = await readBounded(packagePath, MAX_PACKAGE_BYTES);
      const artifactDigest = digest(finalized);
      const signingEvidenceDigest = digest(result.signingEvidence);
      const artifactObjectKey = signedDepotObjectKey(
        request.tenantId, request.projectId, request.releaseId, request.platform, artifactDigest,
      );
      const evidenceObjectKey = signingEvidenceObjectKey(
        request.tenantId, request.projectId, request.releaseId, request.platform, signingEvidenceDigest,
      );
      await this.#artifacts.putImmutable({
        objectKey: artifactObjectKey,
        artifactDigest,
        contentType: "application/octet-stream",
        body: finalized,
      });
      await this.#artifacts.putImmutable({
        objectKey: evidenceObjectKey,
        artifactDigest: signingEvidenceDigest,
        contentType: "application/json",
        body: result.signingEvidence,
      });
      let notarizationObjectKey: string | null = null;
      let notarizationDigest: string | null = null;
      if (result.notarizationEvidence) {
        notarizationDigest = digest(result.notarizationEvidence);
        notarizationObjectKey = notarizationEvidenceObjectKey(
          request.tenantId, request.projectId, request.releaseId, notarizationDigest,
        );
        await this.#artifacts.putImmutable({
          objectKey: notarizationObjectKey,
          artifactDigest: notarizationDigest,
          contentType: "application/json",
          body: result.notarizationEvidence,
        });
      }
      return validateSteamDepotFinalizationReceipt({
        schemaVersion: "deviludo.steam-depot-finalization-receipt.v1",
        operationKey: request.operationKey,
        requestDigest: request.requestDigest,
        tenantId: request.tenantId,
        projectId: request.projectId,
        releaseId: request.releaseId,
        mainCommitSha: request.mainCommitSha,
        evidenceBundleDigest: request.evidenceBundleDigest,
        platform: request.platform,
        sourceArtifactDigest: request.sourceArtifactDigest,
        artifactObjectKey,
        artifactDigest,
        signingScheme: this.#signer.signingScheme,
        signingIdentityDigest: result.signingIdentityDigest,
        signingEvidenceObjectKey: evidenceObjectKey,
        signingEvidenceDigest,
        notarizationEvidenceObjectKey: notarizationObjectKey,
        notarizationEvidenceDigest: notarizationDigest,
      }, request);
    } finally {
      await rm(runRoot, { recursive: true, force: true });
      source.fill(0);
    }
  }
}

export async function extractProductionExport(
  archive: Buffer,
  exportRoot: string,
  platform: SteamDepotFinalizationRequest["platform"],
): Promise<ExportManifest> {
  const entries = parseTar(archive);
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes || manifestBytes.byteLength > MAX_MANIFEST_BYTES) invalid("manifest");
  let parsed: unknown;
  try { parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown; } catch { invalid("manifest JSON"); }
  const manifest = productionExportManifest(parsed, platform);
  if (entries.size !== manifest.files.length + 1) invalid("archive entries");
  for (const file of manifest.files) {
    const name = `files/${String(file.index).padStart(6, "0")}.bin`;
    const body = entries.get(name);
    if (!body || body.byteLength !== file.sizeBytes || digest(body) !== file.sha256) invalid("archive file");
    const destination = childPath(exportRoot, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const output = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(body); await output.sync(); } finally { await output.close(); }
  }
  return manifest;
}

async function platformSigningTarget(exportRoot: string, manifest: ExportManifest): Promise<string> {
  if (manifest.platform === "windows") return exactManifestTarget(exportRoot, manifest, "DeviLudo.exe", 0o700);
  if (manifest.platform === "linux") return exactManifestTarget(exportRoot, manifest, "DeviLudo.x86_64", 0o700);
  const prefix = "DeviLudo.app/Contents/MacOS/";
  const executables = manifest.files.filter((file) => file.path.startsWith(prefix)
    && !file.path.slice(prefix.length).includes("/") && file.path.length > prefix.length);
  if (executables.length !== 1 || !manifest.files.some((file) => file.path.startsWith("DeviLudo.app/Contents/"))) {
    invalid("macOS bundle");
  }
  await chmod(childPath(exportRoot, executables[0]!.path), 0o700);
  return childPath(exportRoot, "DeviLudo.app");
}

async function exactManifestTarget(exportRoot: string, manifest: ExportManifest, path: string, mode: number): Promise<string> {
  if (!manifest.files.some((file) => file.path === path)) invalid("platform executable");
  const target = childPath(exportRoot, path);
  await chmod(target, mode);
  return target;
}

async function finalizedEntries(exportRoot: string, source: ExportManifest): Promise<readonly EvidencePackageEntry[]> {
  const files = await collectFinalizedFiles(exportRoot);
  const finalizedPaths = new Set(files.map((file) => file.path));
  if (source.files.some((file) => !finalizedPaths.has(file.path))) invalid("missing source file");
  const manifest = Buffer.from(canonicalJson({
    schemaVersion: source.schemaVersion,
    jobDigest: source.jobDigest,
    platform: source.platform,
    files: files.map(({ index, path, sha256, sizeBytes }) => ({ index, path, sha256, sizeBytes })),
  }));
  if (manifest.byteLength > MAX_MANIFEST_BYTES || estimatedPackageBytes(files, manifest.byteLength) > MAX_PACKAGE_BYTES) {
    invalid("finalized package size");
  }
  const entries: EvidencePackageEntry[] = [{ name: "manifest.json", body: manifest }];
  for (const file of files) entries.push({
    name: `files/${String(file.index).padStart(6, "0")}.bin`,
    sourcePath: file.sourcePath,
    expectedDigest: file.sha256,
  });
  return Object.freeze(entries.sort((left, right) => left.name.localeCompare(right.name)));
}

async function collectFinalizedFiles(exportRoot: string): Promise<readonly Readonly<{
  index: number;
  path: string;
  sha256: string;
  sizeBytes: number;
  sourcePath: string;
}>[]> {
  const boundary = await realpath(exportRoot);
  const paths: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeRelativePath(relativePath)) invalid("finalized path");
      const absolutePath = childPath(exportRoot, relativePath);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) invalid("finalized symlink");
      const canonical = await realpath(absolutePath);
      if (!canonical.startsWith(`${boundary}${sep}`)) invalid("finalized boundary");
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (metadata.isFile() && metadata.nlink === 1 && metadata.size >= 1 && metadata.size <= MAX_PACKAGE_BYTES) {
        paths.push(relativePath);
        if (paths.length > MAX_FILES) invalid("finalized file count");
      } else {
        invalid("finalized file");
      }
    }
  };
  await visit(exportRoot, "");
  if (paths.length < 1) invalid("finalized files");
  const files = [];
  for (const [index, relativePath] of paths.entries()) {
    const sourcePath = childPath(exportRoot, relativePath);
    const body = await readBounded(sourcePath, MAX_PACKAGE_BYTES);
    files.push(Object.freeze({
      index,
      path: relativePath,
      sha256: digest(body),
      sizeBytes: body.byteLength,
      sourcePath,
    }));
  }
  return Object.freeze(files);
}

function estimatedPackageBytes(
  files: readonly Readonly<{ sizeBytes: number }>[],
  manifestBytes: number,
): number {
  const entryBytes = (size: number) => TAR_BLOCK + size + (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
  return entryBytes(manifestBytes) + files.reduce((sum, file) => sum + entryBytes(file.sizeBytes), 0) + TAR_BLOCK * 2;
}

function productionExportManifest(value: unknown, platform: SteamDepotFinalizationRequest["platform"]): ExportManifest {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "jobDigest", "platform", "files"]);
  if (body.schemaVersion !== "deviludo.production-export-evidence.v1" || typeof body.jobDigest !== "string"
    || !SHA256.test(body.jobDigest) || body.platform !== platform || !Array.isArray(body.files)
    || body.files.length < 1 || body.files.length > MAX_FILES) invalid("manifest");
  const files = body.files.map((candidate, index) => {
    const file = record(candidate); exactKeys(file, ["index", "path", "sha256", "sizeBytes"]);
    if (file.index !== index || typeof file.path !== "string" || !safeRelativePath(file.path)
      || typeof file.sha256 !== "string" || !SHA256.test(file.sha256)
      || !Number.isSafeInteger(file.sizeBytes) || Number(file.sizeBytes) < 1 || Number(file.sizeBytes) > MAX_PACKAGE_BYTES) {
      invalid("manifest file");
    }
    return Object.freeze({ index, path: file.path, sha256: file.sha256, sizeBytes: Number(file.sizeBytes) });
  });
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length
    || JSON.stringify(paths) !== JSON.stringify([...paths].sort((left, right) => left.localeCompare(right)))) {
    invalid("manifest ordering");
  }
  return Object.freeze({
    schemaVersion: "deviludo.production-export-evidence.v1",
    jobDigest: body.jobDigest,
    platform,
    files: Object.freeze(files),
  });
}

function parseTar(value: Buffer): Map<string, Buffer> {
  if (!Buffer.isBuffer(value) || value.byteLength < TAR_BLOCK * 3 || value.byteLength % TAR_BLOCK !== 0) invalid("tar");
  const entries = new Map<string, Buffer>();
  let offset = 0; let terminated = false;
  while (offset + TAR_BLOCK <= value.byteLength) {
    const header = value.subarray(offset, offset + TAR_BLOCK); offset += TAR_BLOCK;
    if (header.every((byte) => byte === 0)) {
      if (offset + TAR_BLOCK > value.byteLength || !value.subarray(offset, offset + TAR_BLOCK).every((byte) => byte === 0)) invalid("tar terminator");
      offset += TAR_BLOCK;
      if (!value.subarray(offset).every((byte) => byte === 0)) invalid("tar trailing data");
      terminated = true; break;
    }
    const name = asciiField(header.subarray(0, 100));
    if (!/^(?:manifest\.json|files\/[0-9]{6}\.bin)$/.test(name) || entries.has(name) || header[156] !== 48) invalid("tar entry");
    const expectedChecksum = octalField(header.subarray(148, 156));
    const checksumHeader = Buffer.from(header); checksumHeader.fill(32, 148, 156);
    if ([...checksumHeader].reduce((sum, byte) => sum + byte, 0) !== expectedChecksum) invalid("tar checksum");
    const size = octalField(header.subarray(124, 136));
    if (size < 1 || size > MAX_PACKAGE_BYTES || offset + size > value.byteLength) invalid("tar size");
    entries.set(name, Buffer.from(value.subarray(offset, offset + size)));
    offset += size;
    offset += (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
    if (entries.size > MAX_FILES + 1) invalid("tar entry count");
  }
  if (!terminated || entries.size < 2) invalid("tar terminator");
  return entries;
}

function validateSigningResult(
  value: SteamDepotSigningResult,
  request: SteamDepotFinalizationRequest,
  signingScheme: SteamDepotSigningScheme,
): void {
  if (!value || !SHA256.test(value.signingIdentityDigest)
    || !validEvidence(value.signingEvidence, request, signingScheme, "deviludo.native-steam-depot-signing-evidence.v1")) {
    invalid("signing result");
  }
  if (request.platform === "macos") {
    if (!value.notarizationEvidence || !validEvidence(
      value.notarizationEvidence, request, signingScheme, "deviludo.native-steam-depot-notarization-evidence.v1",
    )) invalid("notarization result");
  } else if (value.notarizationEvidence !== null) invalid("unexpected notarization");
}

function validEvidence(
  value: Buffer,
  request: SteamDepotFinalizationRequest,
  signingScheme: SteamDepotSigningScheme,
  schemaVersion: string,
): boolean {
  if (!Buffer.isBuffer(value) || value.byteLength < 2 || value.byteLength > MAX_MANIFEST_BYTES
    || FORBIDDEN_EVIDENCE.test(value.toString("utf8"))) return false;
  let parsed: unknown; try { parsed = JSON.parse(value.toString("utf8")) as unknown; } catch { return false; }
  const body = record(parsed);
  return body.schemaVersion === schemaVersion && body.requestDigest === request.requestDigest
    && body.platform === request.platform && body.signingScheme === signingScheme && body.status === "VERIFIED";
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) invalid("runtime file");
    const body = await file.readFile(); const after = await file.stat();
    if (body.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid("runtime file mutation");
    return body;
  } finally { await file.close(); }
}
async function verifyDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("work root");
}
function childPath(root: string, value: string): string {
  const target = resolve(root, ...value.split("/"));
  if (!target.startsWith(`${resolve(root)}${sep}`) && target !== resolve(root)) invalid("path boundary");
  return target;
}
function safeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !value.startsWith("/") && !value.endsWith("/")
    && !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== ".."
      && /^[A-Za-z0-9._+@()-][A-Za-z0-9 ._+@()-]{0,199}$/.test(part));
}
function asciiField(value: Buffer): string {
  const end = value.indexOf(0); const bytes = value.subarray(0, end < 0 ? value.length : end);
  if (bytes.length < 1 || [...bytes].some((byte) => byte < 32 || byte > 126)) invalid("tar text");
  return bytes.toString("ascii");
}
function octalField(value: Buffer): number {
  const text = value.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/.test(text)) invalid("tar number");
  const parsed = Number.parseInt(text, 8); if (!Number.isSafeInteger(parsed)) invalid("tar number"); return parsed;
}
function scheme(platform: SteamDepotFinalizationRequest["platform"]): SteamDepotSigningScheme {
  return platform === "windows" ? "WINDOWS_AUTHENTICODE" : platform === "linux" ? "LINUX_SIGSTORE" : "MACOS_DEVELOPER_ID";
}
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function absolute(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || value.includes("\0")) invalid("absolute path");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object"); return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid("fields");
}
function invalid(label: string): never { throw new Error(`Native Steam depot controller ${label} is invalid`); }
