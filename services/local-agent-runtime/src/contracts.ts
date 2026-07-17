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
