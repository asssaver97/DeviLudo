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
  readonly workerImageIdentity: string | null;
  readonly expectedWorkerImageIdentity: string | null;
  readonly workerImageVerified: boolean;
  readonly agents: readonly LocalAgentReadiness[];
}
