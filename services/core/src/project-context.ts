import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { zstdCompress, zstdDecompress } from "node:zlib";
import {
  PROJECT_CONTEXT_SCHEMA,
  type ProjectRuntimeToolSummary,
} from "@/lib/product/project-runtime";
import {
  PROJECT_RUNTIME_ROLES,
  type ProjectRuntimeRole,
} from "@/lib/product/contracts";

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = /(?:credential|api.?key|auth.?token|password|secret|full.?prompt|raw.?log|image.?bytes)/i;
const EMPTY_ROLE_CONTEXT = Object.freeze({
  sessionId: null,
  summary: "",
  lastTurnId: null,
  updatedAt: null,
});

export type ProjectRoleContext = Readonly<{
  sessionId: string | null;
  summary: string;
  lastTurnId: string | null;
  updatedAt: string | null;
}>;

export type ProjectContext = Readonly<{
  schemaVersion: typeof PROJECT_CONTEXT_SCHEMA;
  workspaceId: string;
  projectId: string;
  revision: number;
  language: "en" | "zh";
  requirements: readonly Readonly<Record<string, unknown>>[];
  projectDocument: Readonly<Record<string, unknown>>;
  source: Readonly<{ revision: number; sha256: string; relativePath: string }> | null;
  assetPlan: readonly Readonly<Record<string, unknown>>[];
  e2e: Readonly<{
    goalRevision: number;
    goals: readonly Readonly<Record<string, unknown>>[];
    planRevision: number | null;
    plan: Readonly<Record<string, unknown>> | null;
  }>;
  buildSummary: Readonly<Record<string, unknown>> | null;
  testSummary: Readonly<Record<string, unknown>> | null;
  workflow: Readonly<Record<string, unknown>>;
  pendingChange: Readonly<Record<string, unknown>> | null;
  roles: Readonly<Record<ProjectRuntimeRole, ProjectRoleContext>>;
  handoffs: readonly Readonly<Record<string, unknown>>[];
  recentConversation: readonly Readonly<Record<string, unknown>>[];
  recentTools: readonly ProjectRuntimeToolSummary[];
  updatedAt: string;
}>;

export type StoredProjectContext = Readonly<{
  context: ProjectContext;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}>;

export function createProjectContext(input: Readonly<{
  workspaceId: string;
  projectId: string;
  language?: "en" | "zh";
  concept?: string;
}>): ProjectContext {
  assertId(input.workspaceId, "workspace");
  assertId(input.projectId, "project");
  const roles = Object.fromEntries(PROJECT_RUNTIME_ROLES.map(role => [role, EMPTY_ROLE_CONTEXT])) as
    Record<ProjectRuntimeRole, ProjectRoleContext>;
  return freezeContext({
    schemaVersion: PROJECT_CONTEXT_SCHEMA,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    revision: 1,
    language: input.language ?? "en",
    requirements: input.concept ? [Object.freeze({ id: "initial-concept", text: input.concept })] : [],
    projectDocument: Object.freeze({}),
    source: null,
    assetPlan: [],
    e2e: Object.freeze({ goalRevision: 0, goals: [], planRevision: null, plan: null }),
    buildSummary: null,
    testSummary: null,
    workflow: Object.freeze({ state: "DRAFT", stopped: false }),
    pendingChange: null,
    roles: Object.freeze(roles),
    handoffs: [],
    recentConversation: [],
    recentTools: [],
    updatedAt: new Date().toISOString(),
  });
}

export function updateProjectContext(
  current: ProjectContext,
  patch: Partial<Omit<ProjectContext, "schemaVersion" | "workspaceId" | "projectId" | "revision" | "updatedAt">>,
): ProjectContext {
  const candidate = {
    ...current,
    ...patch,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  return freezeContext(candidate);
}

export class ProjectContextStore {
  private readonly root: string;

  constructor(projectsRoot: string) {
    this.root = resolve(projectsRoot);
  }

  path(workspaceId: string, projectId: string): string {
    assertId(workspaceId, "workspace");
    assertId(projectId, "project");
    return join(this.root, "workspaces", workspaceId, "projects", projectId, "context", "project-context.json.zst");
  }

  async write(context: ProjectContext): Promise<StoredProjectContext> {
    const valid = freezeContext(context);
    const path = this.path(valid.workspaceId, valid.projectId);
    const bytes = Buffer.from(`${stableJson(valid)}\n`, "utf8");
    const packed = await compress(bytes);
    const temporary = join(dirname(path), `.project-context-${randomUUID()}.zst`);
    await ensureSharedContextTree(this.root, valid.workspaceId, valid.projectId);
    try {
      await writeFile(temporary, packed, { flag: "wx", mode: 0o640 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return Object.freeze({
      context: valid,
      relativePath: relativeContextPath(this.root, path),
      sha256: `sha256:${createHash("sha256").update(packed).digest("hex")}`,
      sizeBytes: packed.length,
    });
  }

  async read(workspaceId: string, projectId: string, expectedSha256?: string): Promise<StoredProjectContext> {
    const path = this.path(workspaceId, projectId);
    const packed = await readFile(path);
    const sha256 = `sha256:${createHash("sha256").update(packed).digest("hex")}`;
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) throw new Error("Project context digest does not match the database revision");
    const unpacked = await decompress(packed);
    const context = freezeContext(JSON.parse(unpacked.toString("utf8")) as ProjectContext);
    if (context.workspaceId !== workspaceId || context.projectId !== projectId) {
      throw new Error("Project context identity does not match its storage boundary");
    }
    return Object.freeze({
      context,
      relativePath: relativeContextPath(this.root, path),
      sha256,
      sizeBytes: packed.length,
    });
  }
}

async function ensureSharedContextTree(root: string, workspaceId: string, projectId: string): Promise<void> {
  const directories = [
    root,
    join(root, "workspaces"),
    join(root, "workspaces", workspaceId),
    join(root, "workspaces", workspaceId, "projects"),
    join(root, "workspaces", workspaceId, "projects", projectId),
    join(root, "workspaces", workspaceId, "projects", projectId, "context"),
    join(root, "workspaces", workspaceId, "projects", projectId, "runtime"),
  ];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o2770 });
    await chmod(directory, 0o2770);
  }
}

function freezeContext(value: ProjectContext): ProjectContext {
  const normalized = normalizeRoleContexts(value);
  if (!normalized || typeof normalized !== "object" || normalized.schemaVersion !== PROJECT_CONTEXT_SCHEMA
    || !UUID.test(normalized.workspaceId) || !UUID.test(normalized.projectId)
    || !Number.isSafeInteger(normalized.revision) || normalized.revision < 1
    || !["en", "zh"].includes(normalized.language)
    || !normalized.roles || typeof normalized.roles !== "object"
    || PROJECT_RUNTIME_ROLES.some(role => !normalized.roles[role])
    || !Number.isFinite(Date.parse(normalized.updatedAt))) {
    throw new Error("Project context is invalid");
  }
  rejectSensitiveData(normalized);
  if (normalized.source && (!Number.isSafeInteger(normalized.source.revision) || normalized.source.revision < 1 || !SHA256.test(normalized.source.sha256))) {
    throw new Error("Project context source revision is invalid");
  }
  return deepFreeze(structuredClone(normalized));
}

function normalizeRoleContexts(value: ProjectContext): ProjectContext {
  if (!value || typeof value !== "object" || !value.roles || typeof value.roles !== "object") return value;
  if (PROJECT_RUNTIME_ROLES.every(role => value.roles[role])) return value;
  return {
    ...value,
    roles: Object.freeze(Object.fromEntries(PROJECT_RUNTIME_ROLES.map(role => [
      role,
      value.roles[role] ?? EMPTY_ROLE_CONTEXT,
    ]))) as Readonly<Record<ProjectRuntimeRole, ProjectRoleContext>>,
  };
}

function rejectSensitiveData(value: unknown, key = "root", depth = 0): void {
  // A complete deterministic E2E plan contains nested journeys, events,
  // postconditions and evidence gates. Keep the guard finite without rejecting
  // the canonical plan the context is required to preserve.
  if (depth > 32) throw new Error("Project context nesting is too deep");
  if (value === undefined) throw new Error(`Project context cannot persist undefined field: ${key}`);
  if (FORBIDDEN_KEYS.test(key)) throw new Error(`Project context cannot persist sensitive field: ${key}`);
  if (typeof value === "string" && value.length > 64_000) throw new Error("Project context contains an unbounded text field");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) throw new Error("Project context cannot contain binary data");
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("Project context collection is too large");
    value.forEach(item => rejectSensitiveData(item, key, depth + 1));
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) rejectSensitiveData(child, childKey, depth + 1);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function relativeContextPath(root: string, path: string): string {
  const prefix = `${root}${sep}`;
  if (!path.startsWith(prefix)) throw new Error("Project context path escapes the project root");
  return path.slice(prefix.length).split(sep).join("/");
}

function assertId(value: string, name: string): void {
  if (!UUID.test(value)) throw new Error(`${name} id is invalid`);
}
