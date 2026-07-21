import { assertPinnedModelId } from "../../../lib/agent/providers";
import { validateAgentFailureDiagnostic } from "../../../lib/agent/failure-diagnostics";
import type { AgentFailureDiagnostic } from "../../../lib/agent/types";
import type { AgentWorkflowRunReceipt } from "../../agent-worker/src/workflow-handler";
import type { SignedGitHubCandidateArtifact } from "../../scm-proxy/src/github-contracts";
import type { AgentConfigurationLock } from "../../agent-configuration/src/contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface AgentExecutionRequest {
  readonly schemaVersion: "deviludo.agent-execution.v1";
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly lockedRunConfigurationId: string;
  readonly expectedRunId: string | null;
  readonly iteration: number;
  readonly repairAttempts: number;
}

export interface AgentExecutionStatus {
  readonly status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  readonly runId: string;
  readonly providerRevisionId: string;
  readonly receipt: AgentWorkflowRunReceipt | null;
}

export interface AgentExecutionLookup {
  readonly tenantId: string;
  readonly runId: string;
  readonly operationKey: string;
  readonly requestDigest: string;
}

export interface LockedAgentExecution {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly resolutionDigest: string;
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly imageDigest: string;
  readonly exactAgentVersion: string;
  readonly adapterVersion: string;
  readonly agent: "claude-code" | "codex-cli";
  readonly providerRevisionId: string;
  readonly providerProtocol: "anthropic-messages" | "openai-responses";
  readonly providerBaseUrl: string;
  readonly credentialVersionId: string;
  readonly model: string;
  readonly modelRoles: Readonly<{
    readonly primaryModel: string;
    readonly planningModel: string;
    readonly smallFastModel: string;
    readonly subagentModel: string;
  }>;
  readonly authorizedModels: readonly string[];
  readonly authorizationNonce: string;
  readonly authorizationExpiresAt: string;
  readonly budget: Readonly<{ maxUsd: number; maxTurns: number; timeoutSeconds: number }>;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanRevisionId: string;
  readonly testPlanDigest: string;
  readonly targetMatrix: readonly ("linux" | "macos" | "windows")[];
  readonly sourceBaselineReceiptId: string;
  readonly baseCommitSha: string;
  readonly sourceDigest: string;
  readonly repairContext: AgentConfigurationLock["repairContext"];
}

export interface IsolatedAgentExecutionRequest extends LockedAgentExecution {
  readonly attemptId: string;
  readonly inferenceTokenSecretRef: string;
  readonly inferenceTokenExpiresAt: string;
}

interface IsolatedAgentExecutionResultBinding {
  readonly status: "COMPLETED" | "FAILED";
  readonly runId: string;
  readonly attemptId: string;
  readonly resolutionDigest: string;
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly imageDigest: string;
  readonly adapterVersion: string;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly model: string;
  readonly executionReceiptId: string;
}

export type IsolatedAgentExecutionResult =
  | IsolatedAgentExecutionResultBinding & Readonly<{
      status: "COMPLETED";
      candidateArtifact: SignedGitHubCandidateArtifact;
      diagnosticId: null;
      diagnostic: null;
    }>
  | IsolatedAgentExecutionResultBinding & Readonly<{
      status: "FAILED";
      candidateArtifact: null;
      diagnosticId: string;
      diagnostic: AgentFailureDiagnostic;
    }>;

export interface PublishedAgentCandidateReceipt {
  readonly runId: string;
  readonly attemptId: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly baseCommitSha: string;
  readonly candidateCommitSha: string;
  readonly sourceDigest: string;
  readonly draftPullRequest: number;
  readonly receiptId: string;
}

export interface AuthoritativeAgentExecutionResult {
  readonly status: "COMPLETED" | "FAILED";
  readonly runId: string;
  readonly attemptId: string;
  readonly resolutionDigest: string;
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly imageDigest: string;
  readonly adapterVersion: string;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly model: string;
  readonly candidateCommitSha: string | null;
  readonly draftPullRequest: number | null;
  readonly diagnosticId: string | null;
  readonly diagnostic: AgentFailureDiagnostic | null;
  readonly receiptId: string;
}

export interface AgentExecutionBrokerIdentity {
  readonly spiffeId: string;
}

export function parseAgentExecutionRequest(value: unknown): AgentExecutionRequest {
  const body = typeof value === "string" ? parseJson(value) : record(value);
  exactKeys(body, ["schemaVersion", "operationKey", "requestDigest", "tenantId", "projectId", "workflowId",
    "lockedRunConfigurationId", "expectedRunId", "iteration", "repairAttempts"]);
  if (body.schemaVersion !== "deviludo.agent-execution.v1"
    || typeof body.operationKey !== "string" || !/^workflow-job:[a-f0-9-]{36}$/i.test(body.operationKey)
    || typeof body.requestDigest !== "string" || !SHA256.test(body.requestDigest)
    || typeof body.tenantId !== "string" || !UUID.test(body.tenantId)
    || typeof body.projectId !== "string" || !UUID.test(body.projectId)
    || typeof body.workflowId !== "string" || !SAFE_ID.test(body.workflowId)
    || typeof body.lockedRunConfigurationId !== "string" || !UUID.test(body.lockedRunConfigurationId)
    || body.expectedRunId !== null && (typeof body.expectedRunId !== "string" || !UUID.test(body.expectedRunId))
    || !Number.isSafeInteger(body.iteration) || (body.iteration as number) < 1
    || !Number.isSafeInteger(body.repairAttempts) || (body.repairAttempts as number) < 0) invalid();
  if (body.expectedRunId !== null && body.expectedRunId !== body.lockedRunConfigurationId) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.agent-execution.v1",
    operationKey: body.operationKey,
    requestDigest: body.requestDigest,
    tenantId: body.tenantId,
    projectId: body.projectId,
    workflowId: body.workflowId,
    lockedRunConfigurationId: body.lockedRunConfigurationId,
    expectedRunId: body.expectedRunId,
    iteration: body.iteration as number,
    repairAttempts: body.repairAttempts as number,
  });
}

export function validateAgentExecutionStatus(value: unknown, expected: Pick<AgentExecutionRequest, "lockedRunConfigurationId">): AgentExecutionStatus {
  const body = record(value);
  if (!UUID.test(String(body.runId ?? "")) || body.runId !== expected.lockedRunConfigurationId
    || typeof body.providerRevisionId !== "string" || !SAFE_ID.test(body.providerRevisionId)
    || !["RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(String(body.status))) invalid();
  if (body.status === "RUNNING" || body.status === "CANCELLED") {
    if (body.receipt !== null) invalid();
    return Object.freeze({ status: body.status, runId: body.runId as string,
      providerRevisionId: body.providerRevisionId, receipt: null });
  }
  const receipt = validateReceipt(body.receipt, body.status as "COMPLETED" | "FAILED", body.runId as string,
    body.providerRevisionId);
  return Object.freeze({ status: body.status as "COMPLETED" | "FAILED", runId: body.runId as string,
    providerRevisionId: body.providerRevisionId, receipt });
}

export function validateIsolatedResult(value: unknown, lock: LockedAgentExecution, attemptId: string): IsolatedAgentExecutionResult {
  const body = record(value);
  exactKeys(body, ["status", "runId", "attemptId", "resolutionDigest", "profileRevisionId", "installationId",
    "imageDigest", "adapterVersion", "providerRevisionId", "credentialVersionId", "model", "executionReceiptId",
    "candidateArtifact", "diagnosticId", "diagnostic"]);
  if ((body.status !== "COMPLETED" && body.status !== "FAILED") || body.runId !== lock.runId
    || body.attemptId !== attemptId || body.resolutionDigest !== lock.resolutionDigest
    || body.profileRevisionId !== lock.profileRevisionId || body.installationId !== lock.installationId
    || body.imageDigest !== lock.imageDigest || body.adapterVersion !== lock.adapterVersion
    || body.providerRevisionId !== lock.providerRevisionId || body.credentialVersionId !== lock.credentialVersionId
    || body.model !== lock.model || typeof body.executionReceiptId !== "string" || !SAFE_ID.test(body.executionReceiptId)) invalid();
  if (body.status === "COMPLETED") {
    const artifact = record(body.candidateArtifact);
    const payload = record(artifact.payload);
    const attestation = record(artifact.attestation);
    if (body.diagnosticId !== null || body.diagnostic !== null || payload.schemaVersion !== "deviludo.github-candidate.v1"
      || payload.tenantId !== lock.tenantId || payload.projectId !== lock.projectId
      || payload.runId !== lock.runId || payload.attemptId !== attemptId
      || payload.specRevisionId !== lock.specRevisionId || payload.expectedBaseCommitSha !== lock.baseCommitSha
      || typeof payload.artifactId !== "string" || !SAFE_ID.test(payload.artifactId)
      || typeof payload.artifactDigest !== "string" || !SHA256.test(payload.artifactDigest)
      || typeof payload.sourceDigest !== "string" || !SHA256.test(payload.sourceDigest)
      || !Array.isArray(payload.changes) || payload.changes.length < 1
      || attestation.algorithm !== "Ed25519" || typeof attestation.keyId !== "string" || !SAFE_ID.test(attestation.keyId)
      || typeof attestation.signature !== "string" || attestation.signature.length < 32) invalid();
  } else if (typeof body.diagnosticId !== "string" || !SAFE_ID.test(body.diagnosticId)
    || body.candidateArtifact !== null) invalid();
  if (body.status === "FAILED") {
    const diagnostic = validateAgentFailureDiagnostic(body.diagnostic);
    if (diagnostic.diagnosticId !== body.diagnosticId || diagnostic.runId !== lock.runId
      || diagnostic.attemptId !== attemptId) invalid();
    return Object.freeze({ ...body, diagnostic }) as unknown as IsolatedAgentExecutionResult;
  }
  return Object.freeze({ ...body }) as unknown as IsolatedAgentExecutionResult;
}

export function validateAuthoritativeResult(value: unknown, lock: LockedAgentExecution, attemptId: string): AuthoritativeAgentExecutionResult {
  const body = record(value);
  exactKeys(body, ["status", "runId", "attemptId", "resolutionDigest", "profileRevisionId", "installationId",
    "imageDigest", "adapterVersion", "providerRevisionId", "credentialVersionId", "model", "candidateCommitSha",
    "draftPullRequest", "diagnosticId", "diagnostic", "receiptId"]);
  if ((body.status !== "COMPLETED" && body.status !== "FAILED") || body.runId !== lock.runId
    || body.attemptId !== attemptId || body.resolutionDigest !== lock.resolutionDigest
    || body.profileRevisionId !== lock.profileRevisionId || body.installationId !== lock.installationId
    || body.imageDigest !== lock.imageDigest || body.adapterVersion !== lock.adapterVersion
    || body.providerRevisionId !== lock.providerRevisionId || body.credentialVersionId !== lock.credentialVersionId
    || body.model !== lock.model || typeof body.receiptId !== "string" || !SAFE_ID.test(body.receiptId)) invalid();
  if (body.status === "COMPLETED") {
    if (typeof body.candidateCommitSha !== "string" || !/^[a-f0-9]{40}$/.test(body.candidateCommitSha)
      || body.candidateCommitSha === lock.baseCommitSha || !Number.isSafeInteger(body.draftPullRequest)
      || (body.draftPullRequest as number) < 1 || body.diagnosticId !== null || body.diagnostic !== null) invalid();
  } else if (typeof body.diagnosticId !== "string" || !SAFE_ID.test(body.diagnosticId)
    || body.candidateCommitSha !== null || body.draftPullRequest !== null) invalid();
  if (body.status === "FAILED") {
    const diagnostic = validateAgentFailureDiagnostic(body.diagnostic);
    if (diagnostic.diagnosticId !== body.diagnosticId || diagnostic.runId !== lock.runId
      || diagnostic.attemptId !== attemptId) invalid();
    return Object.freeze({ ...body, diagnostic }) as unknown as AuthoritativeAgentExecutionResult;
  }
  return Object.freeze({ ...body }) as unknown as AuthoritativeAgentExecutionResult;
}

export function validatePublishedCandidate(value: unknown, isolated: Extract<IsolatedAgentExecutionResult, { status: "COMPLETED" }>,
  lock: LockedAgentExecution): PublishedAgentCandidateReceipt {
  const body = record(value);
  const payload = isolated.candidateArtifact.payload;
  if (body.runId !== lock.runId || body.attemptId !== isolated.attemptId
    || body.artifactId !== payload.artifactId || body.artifactDigest !== payload.artifactDigest
    || body.baseCommitSha !== lock.baseCommitSha || body.sourceDigest !== payload.sourceDigest
    || typeof body.candidateCommitSha !== "string" || !/^[a-f0-9]{40}$/.test(body.candidateCommitSha)
    || body.candidateCommitSha === lock.baseCommitSha || !Number.isSafeInteger(body.draftPullRequest)
    || (body.draftPullRequest as number) < 1 || typeof body.receiptId !== "string" || !SAFE_ID.test(body.receiptId)) invalid();
  return Object.freeze({ ...body }) as unknown as PublishedAgentCandidateReceipt;
}

function validateReceipt(value: unknown, status: "COMPLETED" | "FAILED", runId: string, providerRevisionId: string): AgentWorkflowRunReceipt {
  const body = record(value);
  if (body.status !== status || body.runId !== runId || body.lockedRunConfigurationId !== runId
    || body.providerRevisionId !== providerRevisionId || (body.agent !== "claude-code" && body.agent !== "codex-cli")
    || ![body.profileRevisionId, body.installationId, body.receiptId].every((item) => typeof item === "string" && SAFE_ID.test(item))
    || typeof body.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(body.imageDigest)
    || typeof body.model !== "string" || !validModel(body.model)) invalid();
  if (status === "COMPLETED") {
    if (typeof body.candidateCommitSha !== "string" || !/^[a-f0-9]{40}$/.test(body.candidateCommitSha)
      || !Number.isSafeInteger(body.draftPullRequest) || (body.draftPullRequest as number) < 1
      || body.diagnosticId !== null || body.diagnostic !== null && body.diagnostic !== undefined) invalid();
  } else if (typeof body.diagnosticId !== "string" || !SAFE_ID.test(body.diagnosticId)
    || body.candidateCommitSha !== null || body.draftPullRequest !== null) invalid();
  const diagnostic = status === "COMPLETED" || body.diagnostic === null || body.diagnostic === undefined
    ? null
    : validateAgentFailureDiagnostic(body.diagnostic);
  if (diagnostic && (diagnostic.diagnosticId !== body.diagnosticId || diagnostic.runId !== runId)) invalid();
  return Object.freeze({ ...body, diagnostic }) as unknown as AgentWorkflowRunReceipt;
}

function validModel(value: string): boolean { try { assertPinnedModelId(value); return true; } catch { return false; } }
function parseJson(value: string): Record<string, unknown> { try { return record(JSON.parse(value) as unknown); } catch { invalid(); } }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalid();
}
function invalid(): never { throw new Error("Agent execution Broker contract is invalid"); }
