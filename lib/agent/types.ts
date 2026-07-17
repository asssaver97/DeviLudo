/**
 * Immutable control-plane types shared by the agent registry, provider resolver
 * and declarative runtime adapters. Runtime adapters never spawn processes;
 * an isolated worker executor consumes the returned launch plans.
 */

export type AgentKind = "claude-code" | "codex-cli";

export type AgentRunState =
  | "QUEUED"
  | "PREPARING"
  | "RUNNING"
  | "WAITING_PROVIDER"
  | "CANCELLING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface InstallationRef {
  readonly installationId: string;
  readonly agent: AgentKind;
  readonly cliVersion: string;
  readonly imageDigest: `sha256:${string}`;
  readonly adapterVersion: string;
  readonly workerPoolId: string;
}

export interface ModelRoles {
  readonly primaryModel: string;
  readonly planningModel: string;
  readonly smallFastModel: string;
  readonly subagentModel: string;
}

export interface BudgetPolicy {
  readonly maxTurns: number;
  readonly maxCostUsd: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface RuntimePermissions {
  readonly sandbox: "workspace-write";
  readonly network: "inference-gateway-only";
  readonly scmWrite: "proxy-only";
  readonly allowProjectHooks: false;
  readonly allowProjectMcp: false;
  readonly allowProjectPlugins: false;
}

export interface CredentialBindingRef {
  readonly bindingId: string;
  readonly credentialVersionId: string;
}

export interface AgentProfileRevision {
  readonly profileRevisionId: string;
  readonly profileId: string;
  readonly revision: number;
  readonly agent: AgentKind;
  readonly installation: InstallationRef;
  readonly providerRevisionId: string;
  readonly models: ModelRoles;
  readonly credential: CredentialBindingRef;
  readonly budget: BudgetPolicy;
  readonly timeoutSeconds: number;
  readonly permissions: RuntimePermissions;
  /** Fallback is opt-in and always references an exact immutable revision. */
  readonly allowedFallbackProfileRevisionIds: readonly string[];
}

export interface RunContext {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly commitSha: string;
  readonly specificationRevisionId: string;
  readonly testPlanRevisionId: string;
  readonly runRoot: string;
  readonly inferenceGatewayUrl: string;
  /** Reference to a short-lived, run-bound token; never the token itself. */
  readonly runTokenSecretRef: string;
}

export interface RuntimeFile {
  readonly relativePath: string;
  readonly contents: string;
  readonly mode: 0o400 | 0o600;
  readonly redactFromDiagnostics?: boolean;
}

export interface PreparedRuntime {
  readonly agent: AgentKind;
  readonly context: RunContext;
  readonly profile: AgentProfileRevision;
  readonly homeDirectory: string;
  readonly files: readonly RuntimeFile[];
}

export interface RuntimeSpec {
  readonly executable: "claude" | "codex";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * The executor injects these references through its protected secret channel.
   * Values must never be serialized into task records, logs or evidence.
   */
  readonly secretEnv: Readonly<Record<string, string>>;
  readonly files: readonly RuntimeFile[];
  readonly timeoutSeconds: number;
  readonly redactedArgIndexes: readonly number[];
}

export interface RunHandle {
  readonly runId: string;
  readonly attemptId: string;
  readonly agent: AgentKind;
  readonly executorHandle: string;
}

export interface ProbePlan {
  readonly agent: AgentKind;
  readonly executable: "claude" | "codex";
  readonly argv: readonly string[];
  readonly expectedVersion: string;
  readonly imageDigest: `sha256:${string}`;
}

export interface CancellationRequest {
  readonly executorHandle: string;
  readonly signal: "SIGTERM";
  readonly gracePeriodMs: number;
  readonly then: "SIGKILL";
}

export type AgentEventType =
  | "session"
  | "turn"
  | "tool"
  | "file_change"
  | "usage"
  | "warning"
  | "completed"
  | "failed";

export interface AgentEvent {
  readonly type: AgentEventType;
  readonly timestamp: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly message?: string;
  readonly toolName?: string;
  readonly path?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly rawType?: string;
}

export interface AgentRunResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly sessionId?: string;
  readonly summary?: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
  readonly changedFiles: readonly string[];
  readonly warnings: readonly string[];
}

export interface AgentDiagnostics {
  readonly eventCount: number;
  readonly warningCount: number;
  readonly lastEventType?: AgentEventType;
  readonly messages: readonly string[];
}

export interface RuntimeAdapter {
  readonly agent: AgentKind;
  probe(target: InstallationRef | AgentProfileRevision): ProbePlan;
  prepare(runContext: RunContext, profileRevision: AgentProfileRevision): PreparedRuntime;
  start(runtime: PreparedRuntime, prompt: string, workspace: string): RuntimeSpec;
  cancel(runHandle: RunHandle): CancellationRequest;
  collectResult(runHandle: RunHandle, events: readonly AgentEvent[]): AgentRunResult;
  collectDiagnostics(runHandle: RunHandle, events: readonly AgentEvent[]): AgentDiagnostics;
  parseEvent(line: string, timestamp?: string): AgentEvent | null;
}

export const DEFAULT_RUNTIME_PERMISSIONS: RuntimePermissions = Object.freeze({
  sandbox: "workspace-write",
  network: "inference-gateway-only",
  scmWrite: "proxy-only",
  allowProjectHooks: false,
  allowProjectMcp: false,
  allowProjectPlugins: false,
});
