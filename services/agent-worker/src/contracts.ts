import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type {
  AgentDiagnostics,
  AgentEvent,
  AgentRunResult,
  RunHandle,
  RuntimeAdapter,
  RuntimeSpec,
} from "../../../lib/agent/types";

export interface SecretResolutionContext {
  readonly runId: string;
  readonly attemptId: string;
  readonly environmentVariable: string;
}

export interface SecretResolver {
  resolve(secretRef: string, context: SecretResolutionContext): Promise<string>;
}

export type SpawnImplementation = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface SupervisorLimits {
  readonly maxStdinBytes: number;
  readonly maxJsonLineBytes: number;
  readonly maxStderrBytes: number;
}

export interface AgentExecutionRequest {
  readonly adapter: RuntimeAdapter;
  readonly runHandle: RunHandle;
  readonly runtimeSpec: RuntimeSpec;
  /** Absolute root dedicated to this one run attempt. */
  readonly workerRunRoot: string;
  /** Absolute checkout root. It must be within workerRunRoot. */
  readonly workspaceRoot: string;
  readonly abortSignal?: AbortSignal;
}

export type SupervisedStatus = "completed" | "failed" | "cancelled" | "timed_out";

export interface ProcessDiagnostics {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly stderr: string;
  readonly droppedJsonLines: number;
  readonly processError?: string;
  readonly adapter: AgentDiagnostics;
}

export interface SupervisedExecutionResult {
  readonly status: SupervisedStatus;
  readonly events: readonly AgentEvent[];
  readonly result: AgentRunResult;
  readonly diagnostics: ProcessDiagnostics;
}

export interface SupervisedRun {
  readonly completion: Promise<SupervisedExecutionResult>;
  /** Idempotent. Returns false after termination or after an earlier cancellation. */
  cancel(): boolean;
}

export interface AgentExecutionSupervisorOptions {
  readonly spawn?: SpawnImplementation;
  readonly secretResolver: SecretResolver;
  /** Only an explicit, small allowlist is copied from this object. */
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly limits?: Partial<SupervisorLimits>;
  readonly now?: () => number;
}
