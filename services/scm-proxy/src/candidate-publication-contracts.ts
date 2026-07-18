import { sha256Canonical } from "./canonical";
import type { SignedGitHubCandidateArtifact } from "./github-contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface CandidatePublicationRequest {
  readonly schemaVersion: "deviludo.scm-candidate-publication.v1";
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly resolutionDigest: string;
  readonly artifact: SignedGitHubCandidateArtifact;
}

export interface CandidatePublicationReceipt {
  readonly schemaVersion: "deviludo.scm-candidate-publication-receipt.v1";
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly resolutionDigest: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly baseCommitSha: string;
  readonly candidateCommitSha: string;
  readonly sourceDigest: string;
  readonly draftPullRequest: number;
  readonly receiptId: string;
}

export function createCandidatePublicationRequest(input: Readonly<{
  tenantId: string; projectId: string; runId: string; attemptId: string; resolutionDigest: string;
  artifact: SignedGitHubCandidateArtifact;
}>): CandidatePublicationRequest {
  const operationKey = `agent-candidate:${input.runId}:${input.attemptId}`;
  const requestDigest = sha256Canonical({ operation: "PUBLISH_AGENT_CANDIDATE", ...input, operationKey });
  return parseCandidatePublicationRequest({ schemaVersion: "deviludo.scm-candidate-publication.v1", operationKey,
    requestDigest, ...input });
}

export function parseCandidatePublicationRequest(value: unknown): CandidatePublicationRequest {
  const body = typeof value === "string" ? parseJson(value) : record(value);
  exactKeys(body, ["schemaVersion", "operationKey", "requestDigest", "tenantId", "projectId", "runId", "attemptId",
    "resolutionDigest", "artifact"]);
  if (body.schemaVersion !== "deviludo.scm-candidate-publication.v1" || typeof body.tenantId !== "string" || !UUID.test(body.tenantId)
    || typeof body.projectId !== "string" || !UUID.test(body.projectId) || typeof body.runId !== "string" || !UUID.test(body.runId)
    || typeof body.attemptId !== "string" || !UUID.test(body.attemptId)
    || body.operationKey !== `agent-candidate:${body.runId}:${body.attemptId}`
    || typeof body.resolutionDigest !== "string" || !SHA256.test(body.resolutionDigest)
    || typeof body.requestDigest !== "string" || !SHA256.test(body.requestDigest)) invalid();
  const artifact = parseArtifact(body.artifact, body.tenantId, body.projectId, body.runId, body.attemptId);
  const expectedDigest = sha256Canonical({ operation: "PUBLISH_AGENT_CANDIDATE", tenantId: body.tenantId,
    projectId: body.projectId, runId: body.runId, attemptId: body.attemptId,
    resolutionDigest: body.resolutionDigest, artifact, operationKey: body.operationKey });
  if (body.requestDigest !== expectedDigest) invalid();
  return Object.freeze({ schemaVersion: "deviludo.scm-candidate-publication.v1", operationKey: body.operationKey,
    requestDigest: body.requestDigest, tenantId: body.tenantId, projectId: body.projectId, runId: body.runId,
    attemptId: body.attemptId, resolutionDigest: body.resolutionDigest, artifact });
}

export function validateCandidatePublicationReceipt(value: unknown, request: CandidatePublicationRequest): CandidatePublicationReceipt {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "operationKey", "requestDigest", "tenantId", "projectId", "runId", "attemptId",
    "resolutionDigest", "artifactId", "artifactDigest", "baseCommitSha", "candidateCommitSha", "sourceDigest",
    "draftPullRequest", "receiptId"]);
  const payload = request.artifact.payload;
  if (body.schemaVersion !== "deviludo.scm-candidate-publication-receipt.v1" || body.operationKey !== request.operationKey
    || body.requestDigest !== request.requestDigest || body.tenantId !== request.tenantId || body.projectId !== request.projectId
    || body.runId !== request.runId || body.attemptId !== request.attemptId || body.resolutionDigest !== request.resolutionDigest
    || body.artifactId !== payload.artifactId || body.artifactDigest !== payload.artifactDigest
    || body.baseCommitSha !== payload.expectedBaseCommitSha || body.sourceDigest !== payload.sourceDigest
    || typeof body.candidateCommitSha !== "string" || !SHA1.test(body.candidateCommitSha)
    || body.candidateCommitSha === payload.expectedBaseCommitSha || !Number.isSafeInteger(body.draftPullRequest)
    || (body.draftPullRequest as number) < 1 || typeof body.receiptId !== "string" || !UUID.test(body.receiptId)) invalid();
  return Object.freeze({ ...body }) as unknown as CandidatePublicationReceipt;
}

function parseArtifact(value: unknown, tenantId: string, projectId: string, runId: string, attemptId: string): SignedGitHubCandidateArtifact {
  const artifact = record(value); exactKeys(artifact, ["payload", "attestation"]);
  const payload = record(artifact.payload); const attestation = record(artifact.attestation);
  if (payload.schemaVersion !== "deviludo.github-candidate.v1" || payload.tenantId !== tenantId || payload.projectId !== projectId
    || payload.runId !== runId || payload.attemptId !== attemptId || typeof payload.artifactId !== "string" || !SAFE_ID.test(payload.artifactId)
    || typeof payload.artifactDigest !== "string" || !SHA256.test(payload.artifactDigest)
    || typeof payload.expectedBaseCommitSha !== "string" || !SHA1.test(payload.expectedBaseCommitSha)
    || typeof payload.sourceDigest !== "string" || !SHA256.test(payload.sourceDigest) || !Array.isArray(payload.changes)
    || payload.changes.length < 1 || attestation.algorithm !== "Ed25519" || typeof attestation.keyId !== "string"
    || !SAFE_ID.test(attestation.keyId) || typeof attestation.signature !== "string" || attestation.signature.length < 32) invalid();
  return Object.freeze({ payload: Object.freeze({ ...payload }), attestation: Object.freeze({ ...attestation }) }) as unknown as SignedGitHubCandidateArtifact;
}
function parseJson(value: string): Record<string, unknown> { try { return record(JSON.parse(value) as unknown); } catch { invalid(); } }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void { if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalid(); }
function invalid(): never { throw new Error("SCM candidate publication contract is invalid"); }
