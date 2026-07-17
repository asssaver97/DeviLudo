import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentEvent, AgentRunResult, RuntimeSpec } from "../../../lib/agent/types";
import type {
  AgentExecutionRequest,
  AgentExecutionSupervisorOptions,
  ProcessDiagnostics,
  SecretResolutionContext,
  SupervisedExecutionResult,
  SupervisedRun,
  SupervisedStatus,
  SupervisorLimits,
} from "./contracts";
import { BoundedJsonLineDecoder } from "./jsonl";
import { CliInstallationVerifier, validateProbePlan } from "./installation-verifier";
import { assertExecutableMatchesAdapter, validateExecutionPaths } from "./path-policy";
import { SecretRedactor } from "./redaction";
import { SecureRuntimeFileMaterializer } from "./runtime-files";

const DEFAULT_LIMITS: SupervisorLimits = Object.freeze({
  maxStdinBytes: 2 * 1024 * 1024,
  maxJsonLineBytes: 1024 * 1024,
  maxStderrBytes: 64 * 1024,
});

const HOST_ENV_ALLOWLIST = new Set(["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"]);
const RUNTIME_ENV_ALLOWLIST = Object.freeze({
  claude: new Set([
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "DISABLE_UPDATES",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  ]),
  codex: new Set(["CODEX_HOME", "DEVILUDO_AGENT_UPDATE_POLICY"]),
});
const SECRET_ENV_ALLOWLIST = Object.freeze({
  claude: new Set(["ANTHROPIC_API_KEY"]),
  codex: new Set(["DEVILUDO_RUN_TOKEN"]),
});

export class AgentExecutionSupervisor {
  readonly #spawn: NonNullable<AgentExecutionSupervisorOptions["spawn"]>;
  readonly #secretResolver: AgentExecutionSupervisorOptions["secretResolver"];
  readonly #hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #limits: SupervisorLimits;
  readonly #now: () => number;
  readonly #installationVerifier: NonNullable<AgentExecutionSupervisorOptions["installationVerifier"]>;
  readonly #runtimeFileMaterializer: NonNullable<AgentExecutionSupervisorOptions["runtimeFileMaterializer"]>;

  constructor(options: AgentExecutionSupervisorOptions) {
    this.#spawn = options.spawn ?? nodeSpawn;
    this.#secretResolver = options.secretResolver;
    this.#hostEnvironment = options.hostEnvironment ?? process.env;
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    this.#now = options.now ?? Date.now;
    this.#installationVerifier = options.installationVerifier ?? new CliInstallationVerifier({ hostEnvironment: this.#hostEnvironment });
    this.#runtimeFileMaterializer = options.runtimeFileMaterializer ?? new SecureRuntimeFileMaterializer();
    validateLimits(this.#limits);
  }

  async start(request: AgentExecutionRequest): Promise<SupervisedRun> {
    validateRequest(request, this.#limits);
    const { adapter, runHandle, runtimeSpec } = request;
    await this.#installationVerifier.verify(request.installationProbe);
    await this.#runtimeFileMaterializer.materialize(request.workerRunRoot, runtimeSpec.files);
    const secretValues = await this.#resolveSecrets(runtimeSpec, runHandle);
    const redactor = new SecretRedactor(Object.values(secretValues));
    const stderrCaptureLimit =
      this.#limits.maxStderrBytes +
      Math.max(0, ...Object.values(secretValues).map((value) => Buffer.byteLength(value)));
    const environment = buildEnvironment(
      runtimeSpec,
      this.#hostEnvironment,
      secretValues,
    );

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawn(runtimeSpec.executable, runtimeSpec.args, {
        cwd: runtimeSpec.cwd,
        env: environment as NodeJS.ProcessEnv,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(`Agent process could not be started: ${redactor.redact(errorMessage(error))}`);
    }

    const startedAt = this.#now();
    const decoder = new BoundedJsonLineDecoder(this.#limits.maxJsonLineBytes);
    const events: AgentEvent[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let droppedJsonLines = 0;
    let processError: string | undefined;
    let cancelled = false;
    let timedOut = false;
    let terminated = false;
    let killTimer: NodeJS.Timeout | undefined;

    const consumeBatch = (batch: ReturnType<BoundedJsonLineDecoder["write"]>) => {
      droppedJsonLines += batch.dropped;
      for (const line of batch.lines) {
        const parsed = adapter.parseEvent(line);
        if (parsed) events.push(redactor.event(parsed));
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => consumeBatch(decoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = stderrCaptureLimit - stderrBytes;
      if (remaining <= 0) return;
      const accepted = bytes.subarray(0, remaining);
      stderrChunks.push(accepted);
      stderrBytes += accepted.byteLength;
    });
    child.stdout.on("error", (error) => {
      processError ??= `stdout: ${redactor.redact(errorMessage(error))}`;
    });
    child.stderr.on("error", (error) => {
      processError ??= `stderr: ${redactor.redact(errorMessage(error))}`;
    });
    child.stdin.on("error", (error) => {
      const code = errorCode(error);
      if (code !== "EPIPE") processError ??= `stdin: ${redactor.redact(errorMessage(error))}`;
    });

    const cancellation = adapter.cancel(runHandle);
    if (
      cancellation.signal !== "SIGTERM" ||
      cancellation.then !== "SIGKILL" ||
      !Number.isSafeInteger(cancellation.gracePeriodMs) ||
      cancellation.gracePeriodMs < 1 ||
      cancellation.gracePeriodMs > 60_000
    ) {
      child.kill("SIGKILL");
      throw new Error("Adapter supplied an invalid cancellation policy");
    }
    const terminate = (reason: "cancel" | "timeout"): boolean => {
      if (terminated || cancelled || timedOut) return false;
      if (reason === "cancel") cancelled = true;
      else timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!terminated) child.kill("SIGKILL");
      }, cancellation.gracePeriodMs);
      return true;
    };

    const timeoutTimer = setTimeout(
      () => terminate("timeout"),
      runtimeSpec.timeoutSeconds * 1_000,
    );
    const abort = () => terminate("cancel");

    const completion = new Promise<SupervisedExecutionResult>((resolve) => {
      child.once("error", (error) => {
        processError = redactor.redact(errorMessage(error));
      });
      child.once("close", (exitCode, signal) => {
        terminated = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        request.abortSignal?.removeEventListener("abort", abort);
        consumeBatch(decoder.end());

        const status = deriveStatus(cancelled, timedOut, exitCode, processError, events);
        appendSupervisorEvent(events, status, exitCode, runtimeSpec.timeoutSeconds);
        const adapterResult = adapter.collectResult(runHandle, events);
        const result = normalizeRunResult(adapterResult, status);
        const diagnostics: ProcessDiagnostics = Object.freeze({
          exitCode,
          signal,
          timedOut,
          cancelled,
          durationMs: Math.max(0, this.#now() - startedAt),
          stderr: redactor.redact(Buffer.concat(stderrChunks).toString("utf8"), this.#limits.maxStderrBytes),
          droppedJsonLines,
          processError,
          adapter: adapter.collectDiagnostics(runHandle, events),
        });
        resolve(
          Object.freeze({
            status,
            events: Object.freeze([...events]),
            result,
            diagnostics,
          }),
        );
      });
    });

    request.abortSignal?.addEventListener("abort", abort, { once: true });
    if (request.abortSignal?.aborted) abort();
    child.stdin.end(runtimeSpec.stdin);
    return Object.freeze({ completion, cancel: () => terminate("cancel") });
  }

  async #resolveSecrets(
    runtimeSpec: RuntimeSpec,
    runHandle: AgentExecutionRequest["runHandle"],
  ): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [environmentVariable, secretRef] of Object.entries(runtimeSpec.secretEnv)) {
      if (!/^(?:vault|kms|secret):\/\/[^\s?#]{1,480}$/.test(secretRef)) {
        throw new Error("Runtime secret must be an opaque SecretRef");
      }
      const context: SecretResolutionContext = {
        runId: runHandle.runId,
        attemptId: runHandle.attemptId,
        environmentVariable,
      };
      let value: string;
      try {
        value = await this.#secretResolver.resolve(secretRef, context);
      } catch {
        throw new Error("Runtime SecretRef could not be resolved");
      }
      if (!value || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
        throw new Error("Secret resolver returned an invalid value");
      }
      resolved[environmentVariable] = value;
    }
    return resolved;
  }
}

function validateRequest(request: AgentExecutionRequest, limits: SupervisorLimits): void {
  const { adapter, runHandle, runtimeSpec } = request;
  if (adapter.agent !== runHandle.agent) throw new Error("Run handle uses the wrong adapter");
  if (request.installationProbe.agent !== adapter.agent || request.installationProbe.executable !== runtimeSpec.executable) {
    throw new Error("Installation probe does not match the locked runtime adapter");
  }
  validateProbePlan(request.installationProbe);
  assertExecutableMatchesAdapter(adapter.agent, runtimeSpec);
  validateExecutionPaths(request.workerRunRoot, request.workspaceRoot, runtimeSpec);
  validateEnvironmentKeys(runtimeSpec);
  validateSecretReferences(runtimeSpec);
  if (!Number.isFinite(runtimeSpec.timeoutSeconds) || runtimeSpec.timeoutSeconds <= 0) {
    throw new Error("Runtime timeout must be positive");
  }
  if (Buffer.byteLength(runtimeSpec.stdin, "utf8") > limits.maxStdinBytes) {
    throw new Error("Runtime stdin exceeds the configured limit");
  }
  if (new Set(runtimeSpec.files.map((file) => file.relativePath)).size !== runtimeSpec.files.length) {
    throw new Error("Runtime file paths must be unique");
  }
}

function validateSecretReferences(runtimeSpec: RuntimeSpec): void {
  for (const secretRef of Object.values(runtimeSpec.secretEnv)) {
    if (!/^(?:vault|kms|secret):\/\/[^\s?#]{1,480}$/.test(secretRef)) {
      throw new Error("Runtime secret must be an opaque SecretRef");
    }
  }
}

function validateEnvironmentKeys(runtimeSpec: RuntimeSpec): void {
  const runtimeAllowed = RUNTIME_ENV_ALLOWLIST[runtimeSpec.executable];
  const secretAllowed = SECRET_ENV_ALLOWLIST[runtimeSpec.executable];
  for (const key of Object.keys(runtimeSpec.env)) {
    if (!runtimeAllowed.has(key)) throw new Error(`Runtime environment variable is not permitted: ${key}`);
  }
  for (const key of Object.keys(runtimeSpec.secretEnv)) {
    if (!secretAllowed.has(key)) throw new Error(`Secret environment variable is not permitted: ${key}`);
    if (key in runtimeSpec.env) throw new Error("Secret environment variable shadows a runtime value");
  }
}

function buildEnvironment(
  runtimeSpec: RuntimeSpec,
  hostEnvironment: Readonly<Record<string, string | undefined>>,
  secrets: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = hostEnvironment[key];
    if (value !== undefined && !value.includes("\0")) environment[key] = value;
  }
  return Object.assign(environment, runtimeSpec.env, secrets);
}

function deriveStatus(
  cancelled: boolean,
  timedOut: boolean,
  exitCode: number | null,
  processError: string | undefined,
  events: readonly AgentEvent[],
): SupervisedStatus {
  if (timedOut) return "timed_out";
  if (cancelled) return "cancelled";
  if (processError || exitCode !== 0) return "failed";
  return events.some((event) => event.type === "completed") ? "completed" : "failed";
}

function appendSupervisorEvent(
  events: AgentEvent[],
  status: SupervisedStatus,
  exitCode: number | null,
  timeoutSeconds: number,
): void {
  if (status === "completed") return;
  const message =
    status === "timed_out"
      ? `Agent execution timed out after ${timeoutSeconds} seconds`
      : status === "cancelled"
        ? "Agent execution was cancelled by the control plane"
        : exitCode === 0
          ? "Agent exited without a completed event"
          : `Agent process exited with code ${exitCode ?? "unknown"}`;
  events.push(
    Object.freeze({
      type: status === "cancelled" ? "warning" : "failed",
      timestamp: new Date().toISOString(),
      message,
      rawType: `worker.${status}`,
    }),
  );
}

function normalizeRunResult(
  adapterResult: AgentRunResult,
  status: SupervisedStatus,
): AgentRunResult {
  const normalizedStatus = status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
  return Object.freeze({ ...adapterResult, status: normalizedStatus });
}

function validateLimits(limits: SupervisorLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Supervisor limit is invalid");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown process error";
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
