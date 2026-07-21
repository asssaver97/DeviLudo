import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRuntimeAdapter } from "../../../adapters";
import { DEFAULT_RUNTIME_PERMISSIONS, type AgentProfileRevision, type RunContext, type RunHandle } from "../../../lib/agent/types";
import {
  AGENT_CODE_REVIEW_OUTPUT_PATH,
  createAgentCodeReviewReceipt,
  parseAgentCodeReviewOutput,
  type AgentCodeReviewOutput,
  type AgentCodeReviewReceipt,
} from "../../../lib/agent/code-review";
import type { AgentExecutionRequest, SupervisedRun } from "../../agent-worker/src/contracts";
import type { LocalScmCandidateReceipt } from "../../scm-proxy/src/contracts";
import { LocalGitScmProxy } from "../../scm-proxy/src/local-git";
import type { LocalAgentExecutionReceipt, LocalAgentExecutionRequest, LocalAgentExecutor } from "./contracts";

export interface LocalWorkspaceProvisioner {
  provision(request: LocalAgentExecutionRequest, workspaceRoot: string): Promise<void>;
}

export interface LocalRunTokenBroker {
  issue(input: { readonly request: LocalAgentExecutionRequest; readonly baseCommitSha: string }): Promise<{ readonly secretRef: string }>;
}

export interface LocalAgentSupervisor {
  start(request: AgentExecutionRequest): Promise<SupervisedRun>;
}

/**
 * Composes the adapters, hardened process supervisor and SCM proxy. The server
 * only enables this class when an isolated workspace provisioner and a trusted
 * short-lived token broker are injected.
 */
export class IsolatedLocalAgentExecutor implements LocalAgentExecutor {
  readonly #storageRoot: string;
  readonly #gatewayUrl: string;
  readonly #workspaceProvisioner: LocalWorkspaceProvisioner;
  readonly #runTokenBroker: LocalRunTokenBroker;
  readonly #supervisor: LocalAgentSupervisor;
  readonly #scmProxy: LocalGitScmProxy;

  constructor(options: {
    storageRoot: string;
    gatewayUrl: string;
    workspaceProvisioner: LocalWorkspaceProvisioner;
    runTokenBroker: LocalRunTokenBroker;
    supervisor: LocalAgentSupervisor;
    scmProxy?: LocalGitScmProxy;
  }) {
    if (!path.isAbsolute(options.storageRoot)) throw new Error("Local Agent executor storageRoot must be absolute");
    const gateway = new URL(options.gatewayUrl);
    if (gateway.protocol !== "https:" || gateway.username || gateway.password || gateway.search || gateway.hash) {
      throw new Error("Local Agent executor requires a credential-free HTTPS Gateway origin");
    }
    this.#storageRoot = path.normalize(options.storageRoot);
    this.#gatewayUrl = gateway.toString().replace(/\/$/, "");
    this.#workspaceProvisioner = options.workspaceProvisioner;
    this.#runTokenBroker = options.runTokenBroker;
    this.#supervisor = options.supervisor;
    this.#scmProxy = options.scmProxy ?? new LocalGitScmProxy({ storageRoot: this.#storageRoot });
  }

  async execute(request: LocalAgentExecutionRequest): Promise<LocalAgentExecutionReceipt> {
    const runRoot = path.join(this.#storageRoot, request.projectId, request.runId, request.attemptId);
    const workspaceRoot = path.join(runRoot, "workspace");
    const controlRoot = path.join(this.#storageRoot, ".executions", request.projectId, request.runId, request.attemptId);
    const receiptFile = path.join(controlRoot, "receipt.json");
    const replay = await readReceipt(receiptFile);
    if (replay) return replay;
    await mkdir(controlRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(controlRoot, "started.json"), `${JSON.stringify({
      tenantId: request.tenantId,
      projectId: request.projectId,
      runId: request.runId,
      attemptId: request.attemptId,
      profileRevisionId: request.profileRevisionId,
      installationId: request.installationId,
      imageDigest: request.imageDigest,
      startedAt: new Date().toISOString(),
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await this.#workspaceProvisioner.provision(request, workspaceRoot);
    await assertReviewOutputAbsent(workspaceRoot);

    const scmBinding = {
      projectId: request.projectId,
      runId: request.runId,
      attemptId: request.attemptId,
      specRevisionId: request.specRevisionId,
      workspaceRoot,
    };
    const base = await this.#scmProxy.prepare(scmBinding);
    const token = await this.#runTokenBroker.issue({ request, baseCommitSha: base.baseCommitSha });
    if (!/^(?:vault|kms|secret):\/\/[^\s?#]{1,480}$/.test(token.secretRef)) {
      throw new Error("Local token broker returned an invalid SecretRef");
    }

    const adapter = getRuntimeAdapter(request.agent);
    const profile = profileFrom(request);
    const context: RunContext = Object.freeze({
      tenantId: request.tenantId,
      projectId: request.projectId,
      runId: request.runId,
      attemptId: request.attemptId,
      commitSha: base.baseCommitSha,
      specificationRevisionId: request.specRevisionId,
      testPlanRevisionId: request.testPlanRevisionId,
      runRoot,
      inferenceGatewayUrl: this.#gatewayUrl,
      runTokenSecretRef: token.secretRef,
    });
    const runtime = adapter.prepare(context, profile);
    const runtimeSpec = adapter.start(runtime, reviewPrompt(request.prompt), workspaceRoot);
    const runHandle: RunHandle = Object.freeze({
      runId: request.runId,
      attemptId: request.attemptId,
      agent: request.agent,
      executorHandle: `local-${hash(`${request.runId}:${request.attemptId}`).slice(0, 20)}`,
    });
    const supervised = await this.#supervisor.start({
      adapter,
      runHandle,
      installationProbe: adapter.probe(profile),
      runtimeSpec,
      workerRunRoot: runRoot,
      workspaceRoot,
    });
    const completion = await supervised.completion;
    if (completion.status !== "completed" || completion.result.status !== "completed") {
      throw new Error(`Local Agent attempt did not complete (${completion.status})`);
    }
    const reviewOutput = await consumeReviewOutput(workspaceRoot);
    if (reviewOutput.verdict !== "PASSED") throw new Error("Local Agent code review contains blocking findings");
    const candidate = await this.#scmProxy.finalize({
      ...scmBinding,
      expectedBaseCommitSha: base.baseCommitSha,
      candidateBranch: `deviludo/${safeBranchPart(request.projectId)}/${hash(request.attemptId).slice(0, 16)}`,
      commitMessage: `agent: implement ${request.specRevisionId}`,
    });
    const codeReviewReceipt = createAgentCodeReviewReceipt({
      output: reviewOutput, runId: request.runId, attemptId: request.attemptId,
      profileRevisionId: request.profileRevisionId, installationId: request.installationId,
      imageDigest: request.imageDigest, model: request.model, specRevisionId: request.specRevisionId,
      testPlanRevisionId: request.testPlanRevisionId, sourceDigest: candidate.sourceDigest,
      reviewedAt: candidate.createdAt,
    });
    const receipt = buildReceipt(request, completion.result, candidate, codeReviewReceipt);
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return receipt;
  }
}

function profileFrom(request: LocalAgentExecutionRequest): AgentProfileRevision {
  const revisionMatch = /-r(\d+)$/.exec(request.profileRevisionId);
  const revision = revisionMatch ? Number.parseInt(revisionMatch[1] ?? "1", 10) : 1;
  return Object.freeze({
    profileRevisionId: request.profileRevisionId,
    profileId: request.profileRevisionId.replace(/-r\d+$/, ""),
    revision,
    agent: request.agent,
    installation: Object.freeze({
      installationId: request.installationId,
      agent: request.agent,
      cliVersion: request.expectedVersion,
      imageDigest: request.imageDigest as `sha256:${string}`,
      adapterVersion: request.adapterVersion,
      workerPoolId: "local-isolated-development",
    }),
    providerRevisionId: request.providerRevisionId,
    models: Object.freeze({ ...request.modelRoles }),
    credential: Object.freeze({
      bindingId: `binding-${hash(`${request.tenantId}:${request.credentialVersionId}`).slice(0, 20)}`,
      credentialVersionId: request.credentialVersionId,
    }),
    budget: Object.freeze({ ...request.budget }),
    timeoutSeconds: request.timeoutSeconds,
    permissions: DEFAULT_RUNTIME_PERMISSIONS,
    allowedFallbackProfileRevisionIds: Object.freeze([]),
  });
}

function buildReceipt(
  request: LocalAgentExecutionRequest,
  result: Awaited<SupervisedRun["completion"]>["result"],
  candidate: LocalScmCandidateReceipt,
  codeReviewReceipt: AgentCodeReviewReceipt,
): LocalAgentExecutionReceipt {
  const reported = [...result.changedFiles].sort();
  const authoritative = [...candidate.changedFiles].sort();
  if (!Number.isSafeInteger(result.usage.inputTokens) || result.usage.inputTokens < 0 || result.usage.inputTokens > request.budget.maxInputTokens
    || !Number.isSafeInteger(result.usage.outputTokens) || result.usage.outputTokens < 0 || result.usage.outputTokens > request.budget.maxOutputTokens
    || !Number.isFinite(result.usage.costUsd) || result.usage.costUsd < 0 || result.usage.costUsd > request.budget.maxCostUsd) {
    throw new Error("Agent result usage exceeds the immutable run budget");
  }
  const warnings = result.warnings.slice(0, 99).map((value) => value.slice(0, 1_000));
  if (JSON.stringify(reported) !== JSON.stringify(authoritative)) {
    warnings.push("Adapter changed-file events differed from the authoritative SCM candidate diff");
  }
  return Object.freeze({
    schemaVersion: 1,
    tenantId: request.tenantId,
    projectId: request.projectId,
    runId: request.runId,
    attemptId: request.attemptId,
    specRevisionId: request.specRevisionId,
    testPlanRevisionId: request.testPlanRevisionId,
    profileRevisionId: request.profileRevisionId,
    installationId: request.installationId,
    imageDigest: request.imageDigest,
    adapterVersion: request.adapterVersion,
    providerRevisionId: request.providerRevisionId,
    credentialVersionId: request.credentialVersionId,
    model: request.model,
    modelRoles: Object.freeze({ ...request.modelRoles }),
    agent: request.agent,
    budget: Object.freeze({ ...request.budget }),
    timeoutSeconds: request.timeoutSeconds,
    status: "completed",
    ...(result.sessionId && result.sessionId.length <= 256 ? { sessionId: result.sessionId } : {}),
    summary: (result.summary?.trim() || "Agent completed and SCM proxy created a candidate commit.").slice(0, 4_000),
    usage: Object.freeze({ ...result.usage }),
    warnings: Object.freeze(warnings),
    codeReviewReceipt,
    candidate: Object.freeze({
      scmProxy: "local-git-proxy-v1",
      branch: candidate.branch,
      baseCommitSha: candidate.baseCommitSha,
      commitSha: candidate.commitSha,
      sourceDigest: candidate.sourceDigest,
      changedFiles: Object.freeze([...candidate.changedFiles]),
      draftPullRequest: null,
    }),
    completedAt: candidate.createdAt,
  });
}

function reviewPrompt(prompt: string): string {
  return `${prompt}\n\nBefore finishing, review every change against the approved specification and frozen test plan. Write exactly one UTF-8 JSON object to ${AGENT_CODE_REVIEW_OUTPUT_PATH}. Use schemaVersion deviludo.agent-code-review-output.v1 with exactly verdict (PASSED or FAILED), a non-empty summary, and findings. Each finding has severity (BLOCKING, WARNING, or INFO), an uppercase code, a repository-relative path or null, and a non-empty message. PASSED is allowed only without BLOCKING findings.`;
}

async function assertReviewOutputAbsent(workspaceRoot: string): Promise<void> {
  try {
    await lstat(path.join(workspaceRoot, AGENT_CODE_REVIEW_OUTPUT_PATH));
    throw new Error("Local Agent reserved code review path already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function consumeReviewOutput(workspaceRoot: string): Promise<AgentCodeReviewOutput> {
  const reviewPath = path.join(workspaceRoot, AGENT_CODE_REVIEW_OUTPUT_PATH);
  const metadata = await lstat(reviewPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 64 * 1024) {
    throw new Error("Local Agent code review output is invalid");
  }
  const file = await open(reviewPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const content = await file.readFile();
    const after = await file.stat();
    if (!after.isFile() || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs
      || after.ctimeMs !== metadata.ctimeMs || content.byteLength !== metadata.size) {
      throw new Error("Local Agent code review output changed while being read");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content.toString("utf8")); }
    catch { throw new Error("Local Agent code review output is not valid JSON"); }
    return parseAgentCodeReviewOutput(parsed);
  } finally {
    await file.close();
    await unlink(reviewPath);
  }
}

async function readReceipt(file: string): Promise<LocalAgentExecutionReceipt | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as LocalAgentExecutionReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Stored Local Agent receipt is invalid");
  }
}

function safeBranchPart(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/\.{2,}/g, "-").replace(/^-+|-+$/g, "");
  return result || "project";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
