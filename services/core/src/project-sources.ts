import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createTarGzip, type SourceFile } from "./project-import";
import { isSensitiveProjectPath, normalizeProjectPath } from "@/lib/product/source-archive";

export type PublishedSourceRevision = Readonly<{
  revision: number;
  relativePath: string;
  digest: string;
  fileCount: number;
  totalBytes: number;
}>;

export type SourceCheckpoint = Readonly<{
  digest: string;
  fileCount: number;
  totalBytes: number;
  state: "PARTIAL" | "AGENT_COMPLETE";
  originJobId: string | null;
  specificationDigest: string | null;
  sourceDigest: string | null;
  localDirectoryBaseDigest: string | null;
}>;

export class ProjectSourceStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async publishFiles(input: Readonly<{
    workspaceId: string;
    projectId: string;
    revision: number;
    files: readonly SourceFile[];
  }>): Promise<PublishedSourceRevision> {
    assertIdentity(input.workspaceId, "workspace");
    assertIdentity(input.projectId, "project");
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("Source revision is invalid");
    const files = validateFiles(input.files);
    const digest = sourceDigest(files);
    const project = this.projectPath(input.workspaceId, input.projectId);
    const revisions = join(project, "revisions");
    const stagingRoot = join(project, ".staging", "publish");
    await ensureProjectTree(this.root, input.workspaceId, input.projectId);
    const lock = join(project, ".source-write.lock");
    await acquireSourceLock(lock);
    try {
      const name = `r${String(input.revision).padStart(12, "0")}-${digest.slice(7, 23)}`;
      const target = join(revisions, name);
      const relativePath = relative(this.root, target).split(sep).join("/");
      const revisionPrefix = `r${String(input.revision).padStart(12, "0")}-`;
      const existingRevision = (await readdir(revisions)).find(entry => entry.startsWith(revisionPrefix));
      if (existingRevision && existingRevision !== name) throw new Error("Source revision is already published with different content");
      try {
        const existing = await lstat(target);
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Stored source revision is not a safe directory");
        const stored = await readSourceFiles(target);
        if (sourceDigest(stored) !== digest) throw new Error("Stored source revision content is corrupted");
        await resetStagingRoot(stagingRoot);
        return Object.freeze({ revision: input.revision, relativePath, digest, fileCount: files.length, totalBytes: sumBytes(files) });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      await resetStagingRoot(stagingRoot);
      const staging = join(stagingRoot, `${name}-${randomUUID()}`);
      await ensureSharedDirectory(staging);
      try {
        for (const file of files) {
          const output = resolve(staging, file.path);
          assertWithin(staging, output);
          await ensureSharedParents(staging, dirname(output));
          await writeFile(output, file.bytes, { flag: "wx", mode: SOURCE_FILE_MODE });
        }
        await rename(staging, target);
        const pointer = join(project, `.CURRENT-${randomUUID()}`);
        await writeFile(pointer, `${JSON.stringify({ revision: input.revision, relativePath, digest })}\n`, { flag: "wx", mode: SOURCE_FILE_MODE });
        await rename(pointer, join(project, "CURRENT"));
        return Object.freeze({ revision: input.revision, relativePath, digest, fileCount: files.length, totalBytes: sumBytes(files) });
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async archive(relativePath: string): Promise<Readonly<{ bytes: Buffer; digest: string; fileCount: number; totalBytes: number }>> {
    const directory = resolve(this.root, relativePath);
    assertWithin(this.root, directory);
    const files = await readSourceFiles(directory);
    return Object.freeze({
      bytes: createTarGzip(files),
      digest: sourceDigest(files),
      fileCount: files.length,
      totalBytes: sumBytes(files),
    });
  }

  /**
   * Read one bounded regular file from an immutable published revision. This is
   * used by Core to recover the canonical generated agent.json even while an
   * Agent job created before the runner upgrade still uploads legacy CLI stdout
   * as its object artifact.
   */
  async readRevisionFile(relativePath: string, filePath: string, maximumBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("Source file limit is invalid");
    const directory = resolve(this.root, relativePath);
    assertWithin(this.root, directory);
    const normalized = normalizeProjectPath(filePath);
    const target = resolve(directory, normalized);
    assertWithin(directory, target);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Source revision entry is not a regular file");
    if (info.size < 1 || info.size > maximumBytes) throw new Error("Source revision file size is invalid");
    const bytes = await readFile(target);
    if (bytes.length !== info.size) throw new Error("Source revision file changed while reading");
    return bytes;
  }

  async publishDirectory(input: Readonly<{
    workspaceId: string;
    projectId: string;
    revision: number;
    directory: string;
  }>): Promise<PublishedSourceRevision> {
    return this.publishFiles({ ...input, files: await readSourceFiles(resolve(input.directory)) });
  }

  async saveCheckpoint(input: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowId: string;
    files: readonly SourceFile[];
    state?: "PARTIAL" | "AGENT_COMPLETE";
    originJobId?: string | null;
    specificationDigest?: string | null;
    sourceDigest?: string | null;
    localDirectoryBaseDigest?: string | null;
  }>): Promise<SourceCheckpoint> {
    assertIdentity(input.workspaceId, "workspace");
    assertIdentity(input.projectId, "project");
    assertIdentity(input.workflowId, "workflow");
    const files = validateFiles(input.files);
    const project = this.projectPath(input.workspaceId, input.projectId);
    await ensureProjectTree(this.root, input.workspaceId, input.projectId);
    const checkpoints = join(project, ".staging", "checkpoints");
    await ensureSharedDirectory(checkpoints);
    const target = join(checkpoints, input.workflowId);
    const metadata = join(checkpoints, `${input.workflowId}.json`);
    const staging = join(checkpoints, `.${input.workflowId}-${randomUUID()}`);
    const stagingMetadata = join(checkpoints, `.${input.workflowId}-${randomUUID()}.json`);
    const details = checkpointDetails(files, checkpointMetadata(input));
    await ensureSharedDirectory(staging);
    try {
      for (const file of files) {
        const output = resolve(staging, file.path);
        assertWithin(staging, output);
        await ensureSharedParents(staging, dirname(output));
        await writeFile(output, file.bytes, { flag: "wx", mode: SOURCE_FILE_MODE });
      }
      await writeFile(stagingMetadata, `${JSON.stringify({
        schemaVersion: "deviludo.source-checkpoint.v1",
        state: details.state,
        originJobId: details.originJobId,
        specificationDigest: details.specificationDigest,
        sourceDigest: details.sourceDigest,
        localDirectoryBaseDigest: details.localDirectoryBaseDigest,
      })}\n`, { flag: "wx", mode: SOURCE_FILE_MODE });
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      await rm(metadata, { force: true });
      await rename(stagingMetadata, metadata);
      return details;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await rm(stagingMetadata, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async archiveCheckpoint(
    workspaceId: string,
    projectId: string,
    workflowId: string,
  ): Promise<Readonly<{ bytes: Buffer } & SourceCheckpoint> | null> {
    assertIdentity(workspaceId, "workspace");
    assertIdentity(projectId, "project");
    assertIdentity(workflowId, "workflow");
    const checkpoint = join(this.projectPath(workspaceId, projectId), ".staging", "checkpoints", workflowId);
    const metadata = join(this.projectPath(workspaceId, projectId), ".staging", "checkpoints", `${workflowId}.json`);
    assertWithin(this.root, checkpoint);
    try {
      const files = await readSourceFiles(checkpoint);
      let stored: ReturnType<typeof checkpointMetadata> | null = null;
      try {
        stored = parseCheckpointMetadata(JSON.parse(await readFile(metadata, "utf8")));
      } catch (error) {
        if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
      }
      return Object.freeze({ bytes: createTarGzip(files), ...checkpointDetails(files, stored ?? checkpointMetadata({})) });
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async deleteCheckpoint(workspaceId: string, projectId: string, workflowId: string): Promise<void> {
    assertIdentity(workspaceId, "workspace");
    assertIdentity(projectId, "project");
    assertIdentity(workflowId, "workflow");
    const checkpoint = join(this.projectPath(workspaceId, projectId), ".staging", "checkpoints", workflowId);
    const metadata = join(this.projectPath(workspaceId, projectId), ".staging", "checkpoints", `${workflowId}.json`);
    assertWithin(this.root, checkpoint);
    await rm(checkpoint, { recursive: true, force: true });
    await rm(metadata, { force: true });
  }

  /**
   * Remove a filesystem revision only after the caller has verified that no
   * matching durable database row exists. A sandbox can publish the directory
   * before Core commits its completion transaction; if a later verification
   * step fails, that directory is provisional and must not fence the retry.
   */
  async discardUnregisteredRevision(
    workspaceId: string,
    projectId: string,
    revision: number,
  ): Promise<boolean> {
    assertIdentity(workspaceId, "workspace");
    assertIdentity(projectId, "project");
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Source revision is invalid");
    const project = this.projectPath(workspaceId, projectId);
    const revisions = join(project, "revisions");
    await ensureProjectTree(this.root, workspaceId, projectId);
    const lock = join(project, ".source-write.lock");
    await acquireSourceLock(lock);
    try {
      const prefix = `r${String(revision).padStart(12, "0")}-`;
      const matches = (await readdir(revisions)).filter(entry => entry.startsWith(prefix));
      for (const entry of matches) {
        const target = join(revisions, entry);
        assertWithin(revisions, target);
        const info = await lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error("Stored source revision is not a safe directory");
        }
        await rm(target, { recursive: true, force: false });
      }
      if (matches.length > 0) await refreshCurrentPointer(this.root, project, revisions);
      return matches.length > 0;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async deleteProject(workspaceId: string, projectId: string): Promise<void> {
    const project = this.projectPath(workspaceId, projectId);
    assertWithin(this.root, project);
    await rm(project, { recursive: true, force: true });
  }

  async cleanupStaging(workspaceId: string, projectId: string): Promise<void> {
    const project = this.projectPath(workspaceId, projectId);
    await ensureProjectTree(this.root, workspaceId, projectId);
    const staging = join(project, ".staging", "publish");
    assertWithin(this.root, staging);
    await rm(staging, { recursive: true, force: true });
    await ensureSharedDirectory(staging);
    await rm(join(project, ".source-write.lock"), { recursive: true, force: true });
  }

  private projectPath(workspaceId: string, projectId: string): string {
    const value = resolve(this.root, "workspaces", workspaceId, "projects", projectId);
    assertWithin(this.root, value);
    return value;
  }
}

function validateFiles(input: readonly SourceFile[]): readonly SourceFile[] {
  if (input.length < 1) throw new Error("Source file count is invalid");
  const seen = new Set<string>();
  const files = input.map(file => {
    const path = normalizeProjectPath(file.path);
    if (isSensitiveProjectPath(path)) throw new Error(`Source contains a forbidden credential file: ${path}`);
    if (seen.has(path)) throw new Error(`Source contains a duplicate path: ${path}`);
    seen.add(path);
    const bytes = Buffer.from(file.bytes);
    return Object.freeze({ path, bytes });
  });
  return Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path)));
}

async function readSourceFiles(root: string): Promise<readonly SourceFile[]> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Source revision directory is invalid");
  const files: SourceFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("Source contains a link or special file");
      if (info.isDirectory()) await visit(absolute);
      else files.push(Object.freeze({ path: relative(root, absolute).split(sep).join("/"), bytes: await readFile(absolute) }));
    }
  };
  await visit(root);
  return validateFiles(files);
}

function sourceDigest(files: readonly SourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const path = Buffer.from(file.path, "utf8");
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(path).update("\0").update(size).update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function sumBytes(files: readonly SourceFile[]): number {
  return files.reduce((total, file) => total + file.bytes.length, 0);
}

function checkpointDetails(
  files: readonly SourceFile[],
  metadata: ReturnType<typeof checkpointMetadata>,
): SourceCheckpoint {
  return Object.freeze({ digest: sourceDigest(files), fileCount: files.length, totalBytes: sumBytes(files), ...metadata });
}

function checkpointMetadata(input: Readonly<{
  state?: "PARTIAL" | "AGENT_COMPLETE";
  originJobId?: string | null;
  specificationDigest?: string | null;
  sourceDigest?: string | null;
  localDirectoryBaseDigest?: string | null;
}>): Readonly<Omit<SourceCheckpoint, "digest" | "fileCount" | "totalBytes">> {
  const state = input.state ?? "PARTIAL";
  const originJobId = input.originJobId ?? null;
  const specificationDigest = input.specificationDigest ?? null;
  const baseSourceDigest = input.sourceDigest ?? null;
  const localDirectoryBaseDigest = input.localDirectoryBaseDigest ?? null;
  if (![originJobId].every(value => value === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))) {
    throw new Error("Source checkpoint job identity is invalid");
  }
  if (![specificationDigest, baseSourceDigest, localDirectoryBaseDigest]
    .every(value => value === null || /^sha256:[0-9a-f]{64}$/.test(value))) {
    throw new Error("Source checkpoint digest metadata is invalid");
  }
  return Object.freeze({ state, originJobId, specificationDigest, sourceDigest: baseSourceDigest, localDirectoryBaseDigest });
}

function parseCheckpointMetadata(value: unknown): ReturnType<typeof checkpointMetadata> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>).schemaVersion !== "deviludo.source-checkpoint.v1") {
    throw new Error("Source checkpoint metadata is invalid");
  }
  const metadata = value as Record<string, unknown>;
  if (!['PARTIAL', 'AGENT_COMPLETE'].includes(String(metadata.state))) {
    throw new Error("Source checkpoint state is invalid");
  }
  return checkpointMetadata({
    state: metadata.state as "PARTIAL" | "AGENT_COMPLETE",
    originJobId: typeof metadata.originJobId === "string" ? metadata.originJobId : null,
    specificationDigest: typeof metadata.specificationDigest === "string" ? metadata.specificationDigest : null,
    sourceDigest: typeof metadata.sourceDigest === "string" ? metadata.sourceDigest : null,
    localDirectoryBaseDigest: typeof metadata.localDirectoryBaseDigest === "string" ? metadata.localDirectoryBaseDigest : null,
  });
}

async function resetStagingRoot(stagingRoot: string): Promise<void> {
  await rm(stagingRoot, { recursive: true, force: true });
  await ensureSharedDirectory(stagingRoot);
}

async function refreshCurrentPointer(root: string, project: string, revisions: string): Promise<void> {
  const current = join(project, "CURRENT");
  await rm(current, { force: true });
  const entries = (await readdir(revisions))
    .map(name => ({ name, match: /^r([0-9]{12})-[0-9a-f]{16}$/.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => Number(right.match[1]) - Number(left.match[1]) || right.name.localeCompare(left.name));
  const latest = entries[0];
  if (!latest) return;
  const target = join(revisions, latest.name);
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Stored source revision is not a safe directory");
  const digest = sourceDigest(await readSourceFiles(target));
  const revision = Number(latest.match[1]);
  const relativePath = relative(root, target).split(sep).join("/");
  const pointer = join(project, `.CURRENT-${randomUUID()}`);
  await writeFile(pointer, `${JSON.stringify({ revision, relativePath, digest })}\n`, { flag: "wx", mode: SOURCE_FILE_MODE });
  await rename(pointer, current);
}

async function ensureProjectTree(root: string, workspaceId: string, projectId: string): Promise<void> {
  await ensureSharedDirectory(root, true);
  const directories = [
    join(root, "workspaces"),
    join(root, "workspaces", workspaceId),
    join(root, "workspaces", workspaceId, "projects"),
    join(root, "workspaces", workspaceId, "projects", projectId),
    join(root, "workspaces", workspaceId, "projects", projectId, "revisions"),
    join(root, "workspaces", workspaceId, "projects", projectId, ".staging"),
    join(root, "workspaces", workspaceId, "projects", projectId, ".staging", "publish"),
    join(root, "workspaces", workspaceId, "projects", projectId, ".staging", "checkpoints"),
  ];
  for (const directory of directories) {
    assertWithin(root, directory);
    await ensureSharedDirectory(directory);
  }
}

async function ensureSharedDirectory(directory: string, recursive = false): Promise<void> {
  let created = false;
  try {
    const firstCreated = await mkdir(directory, { recursive, mode: SOURCE_DIRECTORY_MODE });
    created = recursive ? firstCreated !== undefined : true;
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  if (created) await chmod(directory, SOURCE_DIRECTORY_MODE);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Projects root contains an unsafe path component");
}

async function ensureSharedParents(root: string, parent: string): Promise<void> {
  const relativeParent = relative(root, parent);
  if (!relativeParent) return;
  let current = root;
  for (const component of relativeParent.split(sep)) {
    current = join(current, component);
    assertWithin(root, current);
    await ensureSharedDirectory(current);
  }
}

function assertWithin(root: string, value: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (value !== root && !value.startsWith(prefix)) throw new Error("Source path escapes DEVILUDO_PROJECTS_ROOT");
}

function assertIdentity(value: string, kind: string): void {
  if (!UUID.test(value)) throw new Error(`${kind} id is invalid`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

async function acquireSourceLock(lock: string): Promise<void> {
  try { await mkdir(lock, { mode: SOURCE_DIRECTORY_MODE }); await chmod(lock, SOURCE_DIRECTORY_MODE); return; }
  catch (error) { if (!isExists(error)) throw error; }
  const info = await lstat(lock);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Source write lock is invalid");
  if (Date.now() - info.mtimeMs <= SOURCE_LOCK_STALE_MS) throw new Error("Another source write is already active for this project");
  await rm(lock, { recursive: true, force: true });
  try { await mkdir(lock, { mode: SOURCE_DIRECTORY_MODE }); await chmod(lock, SOURCE_DIRECTORY_MODE); }
  catch (error) { if (isExists(error)) throw new Error("Another source write is already active for this project"); throw error; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_LOCK_STALE_MS = 15 * 60_000;
const SOURCE_DIRECTORY_MODE = 0o2770;
const SOURCE_FILE_MODE = 0o640;
