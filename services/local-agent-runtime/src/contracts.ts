import type { AgentKind } from "../../../lib/agent/types";

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
  readonly agents: readonly LocalAgentReadiness[];
}

export interface LocalProviderBindingVerifier {
  verify(request: LocalAgentPreflightRequest): Promise<boolean>;
}

export interface LocalAgentPreflightRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly profileRevisionId: string;
  readonly agent: AgentKind;
  readonly expectedVersion: string;
  readonly imageDigest: string;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly model: string;
}

export type LocalAgentPreflightCode =
  | "INSTALLATION_UNAVAILABLE"
  | "INSTALLATION_MISMATCH"
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
  readonly agent: AgentKind;
  readonly expectedVersion: string;
  readonly observedVersion: string | null;
  readonly imageDigest: string;
  readonly model: string;
  readonly message: string;
}

export interface LocalAgentExecutionRequest extends LocalAgentPreflightRequest {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly specRevisionId: string;
  readonly testPlanRevisionId: string;
  readonly installationId: string;
  readonly adapterVersion: string;
  readonly providerProtocol: "anthropic-messages" | "openai-responses";
  readonly budget: {
    readonly maxTurns: number;
    readonly maxCostUsd: number;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
  };
  readonly timeoutSeconds: number;
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
  readonly agent: AgentKind;
  readonly budget: LocalAgentExecutionRequest["budget"];
  readonly timeoutSeconds: number;
  readonly status: "completed";
  readonly sessionId?: string;
  readonly summary: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
  readonly warnings: readonly string[];
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

/** Implemented only inside an isolated development Worker, never in the Web process. */
export interface LocalAgentExecutor {
  execute(request: LocalAgentExecutionRequest): Promise<LocalAgentExecutionReceipt>;
}
