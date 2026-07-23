export type LocalProjectCatalogItem = Readonly<{
  projectId: string;
  tenantId: "tenant-local";
  slug: string;
  name: string;
  repositoryBindingId: string;
  installationId: string;
  repositoryId: number;
  repositoryNodeId: string;
  owner: string;
  repositoryName: string;
  defaultBranch: string;
  createdAt: string;
}>;

export type LocalRepositoryCatalog = Readonly<{
  installations: readonly Readonly<{
    installationId: string;
    accountLogin: string;
    repositories: readonly Readonly<{
      installationId: string;
      repositoryId: number;
      owner: string;
      name: string;
      defaultBranch: string;
      private: boolean;
    }>[];
  }>[];
}>;

type ProjectRow = {
  project_id: string;
  tenant_id: string;
  slug: string;
  name: string;
  repository_binding_id: string;
  installation_id: string;
  repository_id: number;
  repository_node_id: string;
  owner: string;
  repository_name: string;
  default_branch: string;
  created_at: string;
};
type CommandRow = { request_digest: string; response_json: string };
type MemoryState = {
  projects: Map<string, LocalProjectCatalogItem>;
  commands: Map<string, Readonly<{ requestDigest: string; project: LocalProjectCatalogItem }>>;
  queue: Promise<void>;
};

const FIXTURE_PROJECT: LocalProjectCatalogItem = Object.freeze({
  projectId: "ember-archipelago",
  tenantId: "tenant-local",
  slug: "ember-archipelago",
  name: "余烬群岛",
  repositoryBindingId: "local-fixture-binding",
  installationId: "local-fixture-9001",
  repositoryId: 7001,
  repositoryNodeId: "LOCAL_R_ember_archipelago",
  owner: "north-dock",
  repositoryName: "ember-archipelago",
  defaultBranch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
});
const LOCAL_REPOSITORIES: LocalRepositoryCatalog = Object.freeze({
  installations: Object.freeze([Object.freeze({
    installationId: "local-fixture-9001",
    accountLogin: "local-sandbox",
    repositories: Object.freeze([Object.freeze({
      installationId: "local-fixture-9001",
      repositoryId: 7001,
      owner: "local-sandbox",
      name: "generated-godot-project",
      defaultBranch: "main",
      private: true,
    })]),
  })]),
});
const PROJECT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_LOCAL_PROJECTS = 100;

const globalState = globalThis as typeof globalThis & { __deviludoLocalProjects?: MemoryState };
let bindingPromise: Promise<D1Database | null> | null = null;
let initializedDb: D1Database | null = null;

export class LocalProjectCatalogError extends Error {
  constructor(readonly code: "INVALID_PROJECT" | "IDEMPOTENCY_CONFLICT" | "PROJECT_CONFLICT" | "PROJECT_LIMIT_REACHED") {
    super(code);
  }
}

export function localRepositoryCatalog(): LocalRepositoryCatalog {
  return LOCAL_REPOSITORIES;
}

export async function listLocalProjects(): Promise<readonly LocalProjectCatalogItem[]> {
  const database = await resolveDatabase();
  if (!database) return sortedProjects(memory().projects.values());
  await ensureStore(database);
  const result = await database.prepare(`SELECT project_id, tenant_id, slug, name, repository_binding_id,
    installation_id, repository_id, repository_node_id, owner, repository_name, default_branch, created_at
    FROM local_projects ORDER BY created_at ASC, project_id ASC`).all<ProjectRow>();
  return Object.freeze(result.results.map(parseProjectRow));
}

export async function readLocalProject(projectId: string): Promise<LocalProjectCatalogItem | null> {
  if (!PROJECT_PATTERN.test(projectId)) return null;
  const database = await resolveDatabase();
  if (!database) return memory().projects.get(projectId) ?? null;
  await ensureStore(database);
  const row = await database.prepare(`SELECT project_id, tenant_id, slug, name, repository_binding_id,
    installation_id, repository_id, repository_node_id, owner, repository_name, default_branch, created_at
    FROM local_projects WHERE project_id = ?`).bind(projectId).first<ProjectRow>();
  return row ? parseProjectRow(row) : null;
}

export async function createLocalProject(
  input: Readonly<{ slug: string; name: string; installationId: string; repositoryId: number }>,
  commandKey: string,
): Promise<Readonly<{ project: LocalProjectCatalogItem; replayed: boolean }>> {
  const normalized = normalizeInput(input);
  if (!COMMAND_PATTERN.test(commandKey)) throw new LocalProjectCatalogError("INVALID_PROJECT");
  const requestDigest = await sha256(JSON.stringify(normalized));
  const database = await resolveDatabase();
  return database
    ? createD1Project(database, normalized, commandKey, requestDigest)
    : withMemoryLock(() => createMemoryProject(normalized, commandKey, requestDigest));
}

async function createD1Project(
  database: D1Database,
  input: ReturnType<typeof normalizeInput>,
  commandKey: string,
  requestDigest: string,
) {
  await ensureStore(database);
  const replay = await database.prepare("SELECT request_digest, response_json FROM local_project_commands WHERE command_key = ?")
    .bind(commandKey).first<CommandRow>();
  if (replay) return replayProject(replay, requestDigest);
  const count = await database.prepare("SELECT COUNT(*) AS count FROM local_projects").first<{ count: number }>();
  if (!count || !Number.isSafeInteger(count.count)) throw new Error("Local project catalog is unavailable");
  if (count.count >= MAX_LOCAL_PROJECTS) throw new LocalProjectCatalogError("PROJECT_LIMIT_REACHED");
  const project = makeProject(input);
  try {
    await database.batch([
      database.prepare(`INSERT INTO local_projects
        (project_id, tenant_id, slug, name, repository_binding_id, installation_id, repository_id,
         repository_node_id, owner, repository_name, default_branch, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(project.projectId, project.tenantId, project.slug, project.name, project.repositoryBindingId,
          project.installationId, project.repositoryId, project.repositoryNodeId, project.owner,
          project.repositoryName, project.defaultBranch, project.createdAt),
      database.prepare(`INSERT INTO local_project_commands
        (command_key, request_digest, response_json, created_at) VALUES (?, ?, ?, ?)`)
        .bind(commandKey, requestDigest, JSON.stringify(project), project.createdAt),
    ]);
    return Object.freeze({ project, replayed: false });
  } catch {
    const raced = await database.prepare("SELECT request_digest, response_json FROM local_project_commands WHERE command_key = ?")
      .bind(commandKey).first<CommandRow>();
    if (raced) return replayProject(raced, requestDigest);
    const existing = await database.prepare("SELECT project_id FROM local_projects WHERE project_id = ? OR slug = ?")
      .bind(project.projectId, project.slug).first<{ project_id: string }>();
    if (existing) throw new LocalProjectCatalogError("PROJECT_CONFLICT");
    const latestCount = await database.prepare("SELECT COUNT(*) AS count FROM local_projects").first<{ count: number }>();
    if (latestCount && latestCount.count >= MAX_LOCAL_PROJECTS) throw new LocalProjectCatalogError("PROJECT_LIMIT_REACHED");
    throw new Error("Local project catalog persistence failed");
  }
}

function createMemoryProject(
  input: ReturnType<typeof normalizeInput>,
  commandKey: string,
  requestDigest: string,
) {
  const state = memory();
  const replay = state.commands.get(commandKey);
  if (replay) {
    if (replay.requestDigest !== requestDigest) throw new LocalProjectCatalogError("IDEMPOTENCY_CONFLICT");
    return Object.freeze({ project: replay.project, replayed: true });
  }
  if (state.projects.has(input.slug)) throw new LocalProjectCatalogError("PROJECT_CONFLICT");
  if (state.projects.size >= MAX_LOCAL_PROJECTS) throw new LocalProjectCatalogError("PROJECT_LIMIT_REACHED");
  const project = makeProject(input);
  state.projects.set(project.projectId, project);
  state.commands.set(commandKey, Object.freeze({ requestDigest, project }));
  return Object.freeze({ project, replayed: false });
}

function replayProject(row: CommandRow, requestDigest: string) {
  if (row.request_digest !== requestDigest) throw new LocalProjectCatalogError("IDEMPOTENCY_CONFLICT");
  const project = parseProject(JSON.parse(row.response_json));
  return Object.freeze({ project, replayed: true });
}

function normalizeInput(input: Readonly<{ slug: string; name: string; installationId: string; repositoryId: number }>) {
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!PROJECT_PATTERN.test(slug) || name.length < 1 || name.length > 120 || /[\0-\x1f\x7f]/.test(name)
    || input.installationId !== "local-fixture-9001" || input.repositoryId !== 7001) {
    throw new LocalProjectCatalogError("INVALID_PROJECT");
  }
  return Object.freeze({ slug, name, installationId: input.installationId, repositoryId: input.repositoryId });
}

function makeProject(input: ReturnType<typeof normalizeInput>): LocalProjectCatalogItem {
  return Object.freeze({
    projectId: input.slug,
    tenantId: "tenant-local",
    slug: input.slug,
    name: input.name,
    repositoryBindingId: `local-binding-${input.slug}`,
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    repositoryNodeId: `LOCAL_R_${input.slug}`,
    owner: "local-sandbox",
    repositoryName: input.slug,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
}

function parseProjectRow(row: ProjectRow): LocalProjectCatalogItem {
  return parseProject({
    projectId: row.project_id, tenantId: row.tenant_id, slug: row.slug, name: row.name,
    repositoryBindingId: row.repository_binding_id, installationId: row.installation_id,
    repositoryId: row.repository_id, repositoryNodeId: row.repository_node_id, owner: row.owner,
    repositoryName: row.repository_name, defaultBranch: row.default_branch, createdAt: row.created_at,
  });
}

function parseProject(value: unknown): LocalProjectCatalogItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local project catalog is invalid");
  const project = value as Record<string, unknown>;
  const fields = ["projectId", "tenantId", "slug", "name", "repositoryBindingId", "installationId", "repositoryId",
    "repositoryNodeId", "owner", "repositoryName", "defaultBranch", "createdAt"];
  if (Object.keys(project).sort().join("\0") !== [...fields].sort().join("\0")
    || typeof project.projectId !== "string" || project.projectId !== project.slug || !PROJECT_PATTERN.test(project.projectId)
    || project.tenantId !== "tenant-local" || typeof project.name !== "string" || project.name.length < 1 || project.name.length > 120
    || project.name.trim() !== project.name || /[\0-\x1f\x7f]/.test(project.name)
    || typeof project.repositoryBindingId !== "string" || typeof project.installationId !== "string"
    || !Number.isSafeInteger(project.repositoryId) || typeof project.repositoryNodeId !== "string"
    || typeof project.owner !== "string" || typeof project.repositoryName !== "string"
    || project.defaultBranch !== "main" || typeof project.createdAt !== "string"
    || !Number.isFinite(Date.parse(project.createdAt)) || new Date(project.createdAt).toISOString() !== project.createdAt) {
    throw new Error("Local project catalog is invalid");
  }
  const fixture = project.projectId === FIXTURE_PROJECT.projectId;
  if (fixture) {
    for (const field of fields) {
      if (project[field] !== FIXTURE_PROJECT[field as keyof LocalProjectCatalogItem]) {
        throw new Error("Local project catalog fixture is invalid");
      }
    }
  } else if (project.repositoryBindingId !== `local-binding-${project.projectId}`
    || project.installationId !== "local-fixture-9001" || project.repositoryId !== 7001
    || project.repositoryNodeId !== `LOCAL_R_${project.projectId}` || project.owner !== "local-sandbox"
    || project.repositoryName !== project.projectId) {
    throw new Error("Local project catalog binding is invalid");
  }
  return Object.freeze(project as LocalProjectCatalogItem);
}

function memory(): MemoryState {
  globalState.__deviludoLocalProjects ??= {
    projects: new Map([[FIXTURE_PROJECT.projectId, FIXTURE_PROJECT]]), commands: new Map(), queue: Promise.resolve(),
  };
  return globalState.__deviludoLocalProjects;
}

async function withMemoryLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const state = memory();
  const previous = state.queue;
  let release = () => {};
  state.queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}

async function resolveDatabase(): Promise<D1Database | null> {
  bindingPromise ??= import("cloudflare:workers").then(({ env }) => env.DB ?? null).catch(() => null);
  return bindingPromise;
}

async function ensureStore(database: D1Database): Promise<void> {
  if (initializedDb === database) return;
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS local_projects (
      project_id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, repository_binding_id TEXT NOT NULL UNIQUE, installation_id TEXT NOT NULL,
      repository_id INTEGER NOT NULL, repository_node_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
      repository_name TEXT NOT NULL, default_branch TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
    database.prepare(`CREATE TABLE IF NOT EXISTS local_project_commands (
      command_key TEXT PRIMARY KEY NOT NULL, request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
    database.prepare(`CREATE TRIGGER IF NOT EXISTS local_projects_limit
      BEFORE INSERT ON local_projects WHEN (SELECT COUNT(*) FROM local_projects) >= 100
      BEGIN SELECT RAISE(ABORT, 'local project limit reached'); END`),
    database.prepare(`INSERT OR IGNORE INTO local_projects
      (project_id, tenant_id, slug, name, repository_binding_id, installation_id, repository_id,
       repository_node_id, owner, repository_name, default_branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(FIXTURE_PROJECT.projectId, FIXTURE_PROJECT.tenantId, FIXTURE_PROJECT.slug, FIXTURE_PROJECT.name,
        FIXTURE_PROJECT.repositoryBindingId, FIXTURE_PROJECT.installationId, FIXTURE_PROJECT.repositoryId,
        FIXTURE_PROJECT.repositoryNodeId, FIXTURE_PROJECT.owner, FIXTURE_PROJECT.repositoryName,
        FIXTURE_PROJECT.defaultBranch, FIXTURE_PROJECT.createdAt),
  ]);
  initializedDb = database;
}

function sortedProjects(projects: Iterable<LocalProjectCatalogItem>) {
  return Object.freeze([...projects].sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.projectId.localeCompare(right.projectId)));
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
