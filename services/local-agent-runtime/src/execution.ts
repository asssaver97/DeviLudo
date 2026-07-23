import type {
  LocalAgentCancellationRequest,
  LocalAgentCancellationResult,
  LocalAgentExecutionReceipt,
  LocalAgentExecutionRequest,
  LocalAgentExecutor,
  LocalAgentPreflightResult,
} from "./contracts";
import { LocalAgentReadinessService } from "./readiness";
import { validateAgentCodeReviewReceipt } from "../../../lib/agent/code-review";
import { createHash } from "node:crypto";

export type LocalAgentExecutionOutcome =
  | { readonly state: "BLOCKED"; readonly preflight: LocalAgentPreflightResult }
  | { readonly state: "EXECUTOR_NOT_CONFIGURED" }
  | { readonly state: "COMPLETED"; readonly receipt: LocalAgentExecutionReceipt };

export class LocalAgentExecutionRequestError extends Error {}
export class LocalAgentRunCancelledError extends Error {}

type CompletedOutcome = Extract<LocalAgentExecutionOutcome, { readonly state: "COMPLETED" }>;
type ActiveRun = Readonly<{
  request: LocalAgentExecutionRequest;
  requestDigest: string;
  controller: AbortController;
  completion: Promise<CompletedOutcome>;
}>;
type CancelledAttempt = Readonly<{
  tenantId: string;
  projectId: string;
  expiresAt: number;
}>;

const CANCELLATION_TOMBSTONE_TTL_MS = 4 * 60 * 60 * 1_000;
const MAX_CANCELLATION_TOMBSTONES = 10_000;

export class LocalAgentExecutionService {
  readonly #readiness: LocalAgentReadinessService;
  readonly #executor: LocalAgentExecutor | null;
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #cancelledAttempts = new Map<string, CancelledAttempt>();

  constructor(options: { readiness: LocalAgentReadinessService; executor?: LocalAgentExecutor }) {
    this.#readiness = options.readiness;
    this.#executor = options.executor ?? null;
  }

  async execute(request: LocalAgentExecutionRequest, externalSignal?: AbortSignal): Promise<LocalAgentExecutionOutcome> {
    validateExecutionRequest(request);
    const frozenRequest = freezeRequest(request);
    const key = activeRunKey(request.runId, request.attemptId);
    const requestDigest = executionRequestDigest(frozenRequest);
    this.#pruneCancellationTombstones();
    this.#assertNotCancelled(key, frozenRequest);
    const running = this.#activeRuns.get(key);
    if (running) {
      if (running.requestDigest !== requestDigest) {
        throw new LocalAgentExecutionRequestError("An active local Agent run already owns this immutable attempt");
      }
      return running.completion;
    }
    let preflight: LocalAgentPreflightResult;
    try {
      preflight = await this.#readiness.preflight(request);
    } catch {
      throw new LocalAgentExecutionRequestError("Local Agent execution lock is invalid");
    }
    this.#pruneCancellationTombstones();
    this.#assertNotCancelled(key, frozenRequest);
    if (preflight.status !== "READY") return Object.freeze({ state: "BLOCKED", preflight });
    if (!this.#executor) return Object.freeze({ state: "EXECUTOR_NOT_CONFIGURED" });
    const active = this.#activeRuns.get(key);
    if (active) {
      if (active.requestDigest !== requestDigest) {
        throw new LocalAgentExecutionRequestError("An active local Agent run already owns this immutable attempt");
      }
      return active.completion;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const completion = this.#complete(frozenRequest, controller.signal).finally(() => {
      externalSignal?.removeEventListener("abort", abort);
      const current = this.#activeRuns.get(key);
      if (current?.completion === completion) this.#activeRuns.delete(key);
    });
    this.#activeRuns.set(key, Object.freeze({ request: frozenRequest, requestDigest, controller, completion }));
    return completion;
  }

  cancel(request: LocalAgentCancellationRequest): LocalAgentCancellationResult {
    validateCancellationRequest(request);
    const key = activeRunKey(request.runId, request.attemptId);
    this.#pruneCancellationTombstones();
    const cancelled = this.#cancelledAttempts.get(key);
    if (cancelled && (cancelled.tenantId !== request.tenantId || cancelled.projectId !== request.projectId)) {
      throw new LocalAgentExecutionRequestError("Local Agent cancellation binding conflicts with an existing tombstone");
    }
    const active = this.#activeRuns.get(key);
    if (active && (active.request.tenantId !== request.tenantId || active.request.projectId !== request.projectId)) {
      throw new LocalAgentExecutionRequestError("Local Agent cancellation binding does not match the active run");
    }
    if (!cancelled && this.#cancelledAttempts.size >= MAX_CANCELLATION_TOMBSTONES) {
      throw new LocalAgentExecutionRequestError("Local Agent cancellation capacity is exhausted");
    }
    this.#cancelledAttempts.set(key, Object.freeze({
      tenantId: request.tenantId,
      projectId: request.projectId,
      expiresAt: Date.now() + CANCELLATION_TOMBSTONE_TTL_MS,
    }));
    active?.controller.abort();
    return cancellationResult(request, active ? "CANCELLATION_REQUESTED" : "NOT_RUNNING");
  }

  cancelAll(): void {
    for (const active of this.#activeRuns.values()) active.controller.abort();
  }

  #pruneCancellationTombstones(): void {
    const now = Date.now();
    for (const [key, value] of this.#cancelledAttempts) {
      if (value.expiresAt <= now) this.#cancelledAttempts.delete(key);
    }
  }

  #assertNotCancelled(key: string, request: LocalAgentExecutionRequest): void {
    const cancellation = this.#cancelledAttempts.get(key);
    if (!cancellation) return;
    if (cancellation.tenantId !== request.tenantId || cancellation.projectId !== request.projectId) {
      throw new LocalAgentExecutionRequestError("Local Agent execution conflicts with a cancelled attempt binding");
    }
    throw new LocalAgentRunCancelledError("Local Agent run was cancelled");
  }

  async #complete(request: LocalAgentExecutionRequest, signal: AbortSignal): Promise<CompletedOutcome> {
    try {
      const receipt = await this.#executor!.execute(request, signal);
      if (signal.aborted) throw new LocalAgentRunCancelledError("Local Agent run was cancelled");
      validateReceipt(receipt, request);
      return Object.freeze({ state: "COMPLETED", receipt: freezeReceipt(receipt) });
    } catch (error) {
      if (signal.aborted && !(error instanceof LocalAgentRunCancelledError)) {
        throw new LocalAgentRunCancelledError("Local Agent run was cancelled");
      }
      throw error;
    }
  }
}

function validateCancellationRequest(request: LocalAgentCancellationRequest): void {
  for (const value of [request.tenantId, request.projectId, request.runId, request.attemptId]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
      throw new LocalAgentExecutionRequestError("Local Agent cancellation binding is invalid");
    }
  }
  if (!request.reason.trim() || request.reason.length > 2_000 || request.reason.includes("\0")) {
    throw new LocalAgentExecutionRequestError("Local Agent cancellation reason is invalid");
  }
}

function cancellationResult(
  request: LocalAgentCancellationRequest,
  state: LocalAgentCancellationResult["state"],
): LocalAgentCancellationResult {
  return Object.freeze({
    tenantId: request.tenantId,
    projectId: request.projectId,
    runId: request.runId,
    attemptId: request.attemptId,
    state,
  });
}

function activeRunKey(runId: string, attemptId: string): string {
  return `${runId}\0${attemptId}`;
}

function executionRequestDigest(request: LocalAgentExecutionRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LocalAgentExecutionRequestError("Local Agent execution binding is not canonical");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`;
  }
  throw new LocalAgentExecutionRequestError("Local Agent execution binding is not canonical");
}

function freezeRequest(request: LocalAgentExecutionRequest): LocalAgentExecutionRequest {
  return Object.freeze({
    ...request,
    modelRoles: Object.freeze({ ...request.modelRoles }),
    budget: Object.freeze({ ...request.budget }),
  });
}

function validateExecutionRequest(request: LocalAgentExecutionRequest): void {
  for (const value of [request.tenantId, request.attemptId, request.specRevisionId, request.testPlanRevisionId, request.installationId, request.adapterVersion]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new LocalAgentExecutionRequestError("Local Agent execution binding is invalid");
  }
  if (request.prompt.length < 1 || request.prompt.length > 64 * 1024 || request.prompt.includes("\0")) {
    throw new LocalAgentExecutionRequestError("Local Agent execution prompt is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(request.promptDigest)
    || createHash("sha256").update(request.prompt, "utf8").digest("hex") !== request.promptDigest) {
    throw new LocalAgentExecutionRequestError("Local Agent execution prompt digest is invalid");
  }
  const expectedProtocol = request.agent === "claude-code" ? "anthropic-messages" : "openai-responses";
  if (request.providerProtocol !== expectedProtocol) throw new LocalAgentExecutionRequestError("Local Agent execution protocol does not match the locked Agent");
  if (!validBudget(request.budget)
    || !Number.isSafeInteger(request.timeoutSeconds)
    || request.timeoutSeconds < 60
    || request.timeoutSeconds > 14_400) {
    throw new LocalAgentExecutionRequestError("Local Agent execution budget or timeout is invalid");
  }
}

function validateReceipt(receipt: LocalAgentExecutionReceipt, request: LocalAgentExecutionRequest): void {
  if (receipt.schemaVersion !== 1
    || receipt.status !== "completed"
    || receipt.tenantId !== request.tenantId
    || receipt.projectId !== request.projectId
    || receipt.runId !== request.runId
    || receipt.attemptId !== request.attemptId
    || receipt.specRevisionId !== request.specRevisionId
    || receipt.testPlanRevisionId !== request.testPlanRevisionId
    || receipt.profileRevisionId !== request.profileRevisionId
    || receipt.installationId !== request.installationId
    || receipt.imageDigest !== request.imageDigest
    || receipt.adapterVersion !== request.adapterVersion
    || receipt.providerRevisionId !== request.providerRevisionId
    || receipt.credentialVersionId !== request.credentialVersionId
    || receipt.model !== request.model
    || !sameModelRoles(receipt.modelRoles, request.modelRoles)
    || receipt.agent !== request.agent
    || receipt.timeoutSeconds !== request.timeoutSeconds
    || receipt.promptDigest !== request.promptDigest
    || !sameBudget(receipt.budget, request.budget)) {
    throw new Error("Local Agent execution receipt does not match the immutable run lock");
  }
  if (!receipt.summary || receipt.summary.length > 4_000 || !validUsage(receipt.usage) || !usageWithinBudget(receipt.usage, request.budget)) {
    throw new Error("Local Agent execution receipt result is invalid");
  }
  if (receipt.sessionId !== undefined && (!receipt.sessionId || receipt.sessionId.length > 256)) {
    throw new Error("Local Agent execution receipt session is invalid");
  }
  if (!Array.isArray(receipt.warnings) || receipt.warnings.length > 100 || receipt.warnings.some((value) => typeof value !== "string" || value.length > 1_000)) {
    throw new Error("Local Agent execution receipt warnings are invalid");
  }
  const review = validateAgentCodeReviewReceipt(receipt.codeReviewReceipt);
  if (review.runId !== request.runId || review.attemptId !== request.attemptId
    || review.profileRevisionId !== request.profileRevisionId || review.installationId !== request.installationId
    || review.imageDigest !== request.imageDigest || review.model !== request.model
    || review.specRevisionId !== request.specRevisionId || review.testPlanRevisionId !== request.testPlanRevisionId) {
    throw new Error("Local Agent code review receipt does not match the immutable run lock");
  }
  if (receipt.candidate.scmProxy !== "local-git-proxy-v1"
    || !validCandidateBranch(receipt.candidate.branch)
    || !/^[a-f0-9]{40}$/.test(receipt.candidate.baseCommitSha)
    || !/^[a-f0-9]{40}$/.test(receipt.candidate.commitSha)
    || receipt.candidate.baseCommitSha === receipt.candidate.commitSha
    || !/^[a-f0-9]{64}$/.test(receipt.candidate.sourceDigest)
    || receipt.candidate.draftPullRequest !== null
    || !validChangedFiles(receipt.candidate.changedFiles)) {
    throw new Error("Local Agent execution candidate receipt is invalid");
  }
  if (review.sourceDigest !== receipt.candidate.sourceDigest) {
    throw new Error("Local Agent code review does not match the authoritative candidate");
  }
  if (!Number.isFinite(Date.parse(receipt.completedAt))) throw new Error("Local Agent execution completion time is invalid");
}

function validCandidateBranch(value: string): boolean {
  return value.length <= 128
    && /^deviludo\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(value)
    && !value.includes("..")
    && !value.endsWith(".lock");
}

function validUsage(value: LocalAgentExecutionReceipt["usage"]): boolean {
  return Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0
    && Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0
    && Number.isFinite(value.costUsd) && value.costUsd >= 0;
}

function usageWithinBudget(usage: LocalAgentExecutionReceipt["usage"], budget: LocalAgentExecutionRequest["budget"]): boolean {
  return usage.inputTokens <= budget.maxInputTokens
    && usage.outputTokens <= budget.maxOutputTokens
    && usage.costUsd <= budget.maxCostUsd;
}

function validBudget(value: LocalAgentExecutionRequest["budget"]): boolean {
  return Number.isSafeInteger(value.maxTurns) && value.maxTurns >= 1 && value.maxTurns <= 200
    && Number.isFinite(value.maxCostUsd) && value.maxCostUsd > 0 && value.maxCostUsd <= 100
    && Number.isSafeInteger(value.maxInputTokens) && value.maxInputTokens >= 1 && value.maxInputTokens <= 10_000_000
    && Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens >= 1 && value.maxOutputTokens <= 1_000_000;
}

function sameBudget(left: LocalAgentExecutionRequest["budget"], right: LocalAgentExecutionRequest["budget"]): boolean {
  return left.maxTurns === right.maxTurns
    && left.maxCostUsd === right.maxCostUsd
    && left.maxInputTokens === right.maxInputTokens
    && left.maxOutputTokens === right.maxOutputTokens;
}

function sameModelRoles(left: LocalAgentExecutionRequest["modelRoles"], right: LocalAgentExecutionRequest["modelRoles"]): boolean {
  return left.primaryModel === right.primaryModel
    && left.planningModel === right.planningModel
    && left.smallFastModel === right.smallFastModel
    && left.subagentModel === right.subagentModel;
}

function validChangedFiles(files: readonly string[]): boolean {
  return Array.isArray(files)
    && files.length > 0
    && files.length <= 10_000
    && new Set(files).size === files.length
    && files.every((value) => typeof value === "string"
      && value.length > 0
      && value.length <= 500
      && !value.startsWith("/")
      && !value.includes("\\")
      && !value.split("/").some((part) => part === "" || part === "." || part === ".."));
}

function freezeReceipt(receipt: LocalAgentExecutionReceipt): LocalAgentExecutionReceipt {
  return Object.freeze({
    ...receipt,
    modelRoles: Object.freeze({ ...receipt.modelRoles }),
    usage: Object.freeze({ ...receipt.usage }),
    warnings: Object.freeze([...receipt.warnings]),
    codeReviewReceipt: Object.freeze({ ...receipt.codeReviewReceipt }),
    candidate: Object.freeze({ ...receipt.candidate, changedFiles: Object.freeze([...receipt.candidate.changedFiles]) }),
  });
}
