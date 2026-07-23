import type { AgentKind, ModelRoles } from "../../../lib/agent/types";
import type { AgentCodeReviewReceipt } from "../../../lib/agent/code-review";

export type LocalAgentReadinessState = "READY" | "VERSION_MISMATCH" | "UNAVAILABLE";

export interface LocalAgentReadiness {
  readonly agent: AgentKind;
  readonly executable: "claude" | "codex";
  readonly expectedVersion: string;
  readonly observedVersion: string | null;
  readonly state: LocalAgentReadinessState;
}

export interface LocalAgentRuntimeHealth {
  readonly status: "ok" | "degraded";
  readonly service: "deviludo-local-agent-runtime";
  readonly executionEnabled: boolean;
  readonly inferenceGateway: "CONFIGURED" | "NOT_CONFIGURED";
  readonly providerBindingProbe: "CONFIGURED" | "NOT_CONFIGURED";
  readonly workerImageIdentity: string | null;
  readonly expectedWorkerImageIdentity: string | null;
  readonly workerImageVerified: boolean;
  readonly workerIdentityMode: "PINNED_ENV" | "LOCAL_DETERMINISTIC" | "NOT_CONFIGURED";
  readonly agents: readonly LocalAgentReadiness[];
}

export interface LocalProviderBindingVerifier {
  verify(request: LocalAgentPreflightRequest): Promise<boolean>;
}

export interface LocalAgentPreflightRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly agent: AgentKind;
  readonly expectedVersion: string;
  readonly imageDigest: string;
  readonly adapterVersion: string;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly model: string;
  readonly modelRoles: ModelRoles;
}

export type LocalAgentPreflightCode =
  | "INSTALLATION_UNAVAILABLE"
  | "INSTALLATION_MISMATCH"
  | "ADAPTER_MISMATCH"
  | "WORKER_IMAGE_MISMATCH"
  | "WAITING_PROVIDER"
  | "EXECUTION_DISABLED"
  | "READY";

export interface LocalAgentPreflightResult {
  readonly status: "BLOCKED" | "READY";
  readonly code: LocalAgentPreflightCode;
  readonly projectId: string;
  readonly runId: string;
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly agent: AgentKind;
  readonly expectedVersion: string;
  readonly observedVersion: string | null;
  readonly imageDigest: string;
  readonly adapterVersion: string;
  readonly model: string;
  readonly modelRoles: ModelRoles;
  readonly message: string;
}

export interface LocalAgentExecutionRequest extends LocalAgentPreflightRequest {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly specRevisionId: string;
  readonly testPlanRevisionId: string;
  readonly providerProtocol: "anthropic-messages" | "openai-responses";
  readonly budget: {
    readonly maxTurns: number;
    readonly maxCostUsd: number;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
  };
  readonly timeoutSeconds: number;
  readonly promptDigest: string;
  readonly prompt: string;
}

export interface LocalAgentExecutionReceipt {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly specRevisionId: string;
  readonly testPlanRevisionId: string;
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly imageDigest: string;
  readonly adapterVersion: string;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly model: string;
  readonly modelRoles: ModelRoles;
  readonly agent: AgentKind;
  readonly budget: LocalAgentExecutionRequest["budget"];
  readonly timeoutSeconds: number;
  readonly promptDigest: string;
  readonly status: "completed";
  readonly sessionId?: string;
  readonly summary: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
  readonly warnings: readonly string[];
  readonly codeReviewReceipt: AgentCodeReviewReceipt;
  readonly candidate: {
    readonly scmProxy: "local-git-proxy-v1";
    readonly branch: string;
    readonly baseCommitSha: string;
    readonly commitSha: string;
    readonly sourceDigest: string;
    readonly changedFiles: readonly string[];
    readonly draftPullRequest: number | null;
  };
  readonly completedAt: string;
}

export interface LocalAgentCancellationRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly reason: string;
}

export interface LocalAgentCancellationResult {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly state: "CANCELLATION_REQUESTED" | "NOT_RUNNING";
}

/** Implemented only inside an isolated development Worker, never in the Web process. */
export interface LocalAgentExecutor {
  execute(request: LocalAgentExecutionRequest, signal?: AbortSignal): Promise<LocalAgentExecutionReceipt>;
}
