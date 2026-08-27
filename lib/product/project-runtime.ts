import type { AgentRuntimeKind, ProjectRuntimeRole, ProjectRuntimeState } from "./contracts";

export const PROJECT_RUNTIME_SCHEMA = "deviludo.project-runtime.v2" as const;
export const PROJECT_CONTEXT_SCHEMA = "deviludo.project-context.v2" as const;

export type ProjectRuntimeIdentity = Readonly<{
  workspaceId: string;
  projectId: string;
  generation: number;
  fencingToken: number;
}>;

export type ProjectRuntimeStatus = ProjectRuntimeIdentity & Readonly<{
  state: ProjectRuntimeState;
  runtime: AgentRuntimeKind;
  containerId: string | null;
  activeRole: ProjectRuntimeRole | null;
  activeTurnId: string | null;
  lastActivityAt: string;
  pausedAt: string | null;
  contextRevision: number;
  contextSha256: string;
}>;

export type ProjectRuntimeTurnMode = "PRIMARY" | "READ_ONLY_BRANCH" | "COMPACT";

export type ProjectRuntimeProgressEvent = Readonly<{
  kind: "RUNTIME_OUTPUT" | "ACTIVITY" | "CONTENT_DELTA" | "DEVELOPMENT_LOG";
  content: string;
}>;

export type ProjectRuntimeTurnRequest = ProjectRuntimeIdentity & Readonly<{
  schemaVersion: typeof PROJECT_RUNTIME_SCHEMA;
  turnId: string;
  role: ProjectRuntimeRole;
  mode: ProjectRuntimeTurnMode;
  runtime: AgentRuntimeKind;
  runtimeImage: string;
  baseUrl: string;
  model: string;
  sourceRevision: number | null;
  sourceRelativePath: string | null;
  contextRevision: number;
  responseLanguage: "en" | "zh";
  prompt: string;
  attachmentPaths: readonly string[];
  credentialRef: string;
  mcpToken: string;
  leaseToken: string;
  leaseExpiresAt: string;
}>;

export type ProjectRuntimeEnsureRequest = ProjectRuntimeIdentity & Readonly<{
  schemaVersion: typeof PROJECT_RUNTIME_SCHEMA;
  runtime: AgentRuntimeKind;
  runtimeImage: string;
  sourceRelativePath: string | null;
  contextRelativePath: string;
}>;

export type ProjectRuntimeControlRequest = ProjectRuntimeIdentity & Readonly<{
  schemaVersion: typeof PROJECT_RUNTIME_SCHEMA;
  runtime: AgentRuntimeKind;
}>;

export type ProjectRuntimeToolSummary = Readonly<{
  name: string;
  arguments: Readonly<Record<string, unknown>>;
  result: Readonly<Record<string, unknown>>;
  startedAt: string;
  completedAt: string;
}>;

export type ProjectRuntimeTurnResult = Readonly<{
  schemaVersion: typeof PROJECT_RUNTIME_SCHEMA;
  turnId: string;
  role: ProjectRuntimeRole;
  mode: ProjectRuntimeTurnMode;
  content: string;
  structured: Readonly<Record<string, unknown>>;
  toolCalls: readonly ProjectRuntimeToolSummary[];
  sessionId: string;
  branchId: string | null;
  sourceRevision: number | null;
  startedAt: string;
  completedAt: string;
}>;

export const PROJECT_RUNTIME_IDLE_MS = 5 * 60 * 1_000;
export const PROJECT_RUNTIME_PAUSED_DESTROY_MS = 30 * 60 * 1_000;
