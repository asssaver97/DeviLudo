import type {
  LocalAgentExecutionReceipt,
  LocalAgentExecutionRequest,
  LocalAgentExecutor,
  LocalAgentPreflightResult,
} from "./contracts";
import { LocalAgentReadinessService } from "./readiness";

export type LocalAgentExecutionOutcome =
  | { readonly state: "BLOCKED"; readonly preflight: LocalAgentPreflightResult }
  | { readonly state: "EXECUTOR_NOT_CONFIGURED" }
  | { readonly state: "COMPLETED"; readonly receipt: LocalAgentExecutionReceipt };

export class LocalAgentExecutionRequestError extends Error {}

export class LocalAgentExecutionService {
  readonly #readiness: LocalAgentReadinessService;
  readonly #executor: LocalAgentExecutor | null;

  constructor(options: { readiness: LocalAgentReadinessService; executor?: LocalAgentExecutor }) {
    this.#readiness = options.readiness;
    this.#executor = options.executor ?? null;
  }

  async execute(request: LocalAgentExecutionRequest): Promise<LocalAgentExecutionOutcome> {
    validateExecutionRequest(request);
    let preflight: LocalAgentPreflightResult;
    try {
      preflight = await this.#readiness.preflight(request);
    } catch {
      throw new LocalAgentExecutionRequestError("Local Agent execution lock is invalid");
    }
    if (preflight.status !== "READY") return Object.freeze({ state: "BLOCKED", preflight });
    if (!this.#executor) return Object.freeze({ state: "EXECUTOR_NOT_CONFIGURED" });
    const receipt = await this.#executor.execute(Object.freeze({ ...request }));
    validateReceipt(receipt, request);
    return Object.freeze({ state: "COMPLETED", receipt: freezeReceipt(receipt) });
  }
}

function validateExecutionRequest(request: LocalAgentExecutionRequest): void {
  for (const value of [request.attemptId, request.specRevisionId, request.installationId, request.adapterVersion]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new LocalAgentExecutionRequestError("Local Agent execution binding is invalid");
  }
  if (request.prompt.length < 1 || request.prompt.length > 64 * 1024 || request.prompt.includes("\0")) {
    throw new LocalAgentExecutionRequestError("Local Agent execution prompt is invalid");
  }
  const expectedProtocol = request.agent === "claude-code" ? "anthropic-messages" : "openai-responses";
  if (request.providerProtocol !== expectedProtocol) throw new LocalAgentExecutionRequestError("Local Agent execution protocol does not match the locked Agent");
}

function validateReceipt(receipt: LocalAgentExecutionReceipt, request: LocalAgentExecutionRequest): void {
  if (receipt.schemaVersion !== 1
    || receipt.status !== "completed"
    || receipt.projectId !== request.projectId
    || receipt.runId !== request.runId
    || receipt.attemptId !== request.attemptId
    || receipt.specRevisionId !== request.specRevisionId
    || receipt.profileRevisionId !== request.profileRevisionId
    || receipt.installationId !== request.installationId
    || receipt.imageDigest !== request.imageDigest
    || receipt.adapterVersion !== request.adapterVersion
    || receipt.providerRevisionId !== request.providerRevisionId
    || receipt.credentialVersionId !== request.credentialVersionId
    || receipt.model !== request.model
    || receipt.agent !== request.agent) {
    throw new Error("Local Agent execution receipt does not match the immutable run lock");
  }
  if (!receipt.summary || receipt.summary.length > 4_000 || !validUsage(receipt.usage)) {
    throw new Error("Local Agent execution receipt result is invalid");
  }
  if (receipt.sessionId !== undefined && (!receipt.sessionId || receipt.sessionId.length > 256)) {
    throw new Error("Local Agent execution receipt session is invalid");
  }
  if (!Array.isArray(receipt.warnings) || receipt.warnings.length > 100 || receipt.warnings.some((value) => typeof value !== "string" || value.length > 1_000)) {
    throw new Error("Local Agent execution receipt warnings are invalid");
  }
  if (receipt.candidate.scmProxy !== "local-git-proxy-v1"
    || !validCandidateBranch(receipt.candidate.branch)
    || !/^[a-f0-9]{40}$/.test(receipt.candidate.commitSha)
    || !/^[a-f0-9]{64}$/.test(receipt.candidate.sourceDigest)
    || receipt.candidate.draftPullRequest !== null
    || !validChangedFiles(receipt.candidate.changedFiles)) {
    throw new Error("Local Agent execution candidate receipt is invalid");
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
    usage: Object.freeze({ ...receipt.usage }),
    warnings: Object.freeze([...receipt.warnings]),
    candidate: Object.freeze({ ...receipt.candidate, changedFiles: Object.freeze([...receipt.candidate.changedFiles]) }),
  });
}
