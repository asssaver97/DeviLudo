import type { ScmMergeWorkflowReceipt } from "./workflow-handler";
import type { CandidateAcceptanceSigner } from "./acceptance-signer-client";
import type {
  AcceptedCandidateEvidence,
  GitHubCandidateReceipt,
  GitHubMergeReceipt,
  GitHubRepositoryBinding,
} from "./github-contracts";
import type { GitHubAppScmProxy } from "./github-proxy";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface ScmMergeCommand {
  readonly schemaVersion: "deviludo.scm-merge.v1";
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly specRevisionId: string;
  readonly candidateCommitSha: string;
  readonly pullRequestNumber: number;
  readonly evidenceBundleId: string;
  readonly acceptanceSignalId: string;
}

export interface AuthoritativeMergeContext {
  readonly acceptanceOperationKey: string;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly repositoryBindingId: string;
  readonly binding: GitHubRepositoryBinding;
  readonly candidateReceiptId: string;
  readonly candidate: GitHubCandidateReceipt;
  readonly evidence: AcceptedCandidateEvidence;
}

export interface ScmMergeAuthority {
  resolve(request: ScmMergeCommand): Promise<AuthoritativeMergeContext>;
  verify(input: Readonly<{ binding: GitHubRepositoryBinding; candidate: GitHubCandidateReceipt; evidence: AcceptedCandidateEvidence }>): Promise<boolean>;
  probe(): Promise<void>;
}

export interface ScmMergeReceiptArchive {
  persist(input: Readonly<{ request: ScmMergeCommand; authority: AuthoritativeMergeContext; receipt: GitHubMergeReceipt }>): Promise<Readonly<{ receiptId: string }>>;
  probe(): Promise<void>;
}

export class AuthoritativeScmMergeService {
  constructor(
    private readonly authority: ScmMergeAuthority,
    private readonly signer: CandidateAcceptanceSigner,
    private readonly github: Pick<GitHubAppScmProxy, "mergeAcceptedCandidate">,
    private readonly archive: ScmMergeReceiptArchive,
    private readonly now: () => Date = () => new Date(),
    private readonly readiness: readonly Readonly<{ probe(): Promise<void> }>[] = [],
  ) {}

  async merge(value: unknown): Promise<ScmMergeWorkflowReceipt> {
    const request = parseScmMergeCommand(value);
    const authority = await this.authority.resolve(request);
    const epoch = Math.floor(validDate(this.now()).getTime() / 1_000);
    const acceptance = await this.signer.sign(Object.freeze({
      iss: "deviludo-control-plane",
      aud: "deviludo-scm-proxy",
      tenantId: request.tenantId,
      projectId: request.projectId,
      acceptedBy: authority.acceptedBy,
      candidateCommitSha: authority.candidate.candidateCommitSha,
      sourceDigest: authority.candidate.sourceDigest,
      specRevisionId: authority.evidence.specRevisionId,
      evidenceBundleDigest: authority.evidence.evidenceBundleDigest,
      iat: epoch,
      exp: epoch + 300,
      nonce: authority.acceptanceOperationKey,
    }));
    const merged = await this.github.mergeAcceptedCandidate({
      idempotencyKey: request.operationKey,
      binding: authority.binding,
      candidate: authority.candidate,
      evidence: authority.evidence,
      acceptance,
    }, new Date(epoch * 1_000).toISOString());
    const archived = await this.archive.persist({ request, authority, receipt: merged });
    return Object.freeze({
      receiptId: archived.receiptId,
      runId: request.runId,
      candidateCommitSha: request.candidateCommitSha,
      pullRequestNumber: request.pullRequestNumber,
      evidenceBundleId: request.evidenceBundleId,
      acceptanceSignalId: request.acceptanceSignalId,
      mergeCommitSha: merged.mergeCommitSha,
      defaultBranchHeadSha: merged.defaultBranchHeadSha,
      mainSourceDigest: merged.mainSourceDigest,
      requiresFreshMainSnapshot: merged.requiresFreshMainSnapshot,
    });
  }

  async probe(): Promise<void> {
    await Promise.all([this.authority.probe(), this.archive.probe(), this.signer.probe(), ...this.readiness.map((item) => item.probe())]);
  }
}

export function parseScmMergeCommand(value: unknown): ScmMergeCommand {
  if (typeof value === "string") { try { return parseScmMergeCommand(JSON.parse(value)); } catch { invalid(); } }
  const body = record(value);
  const expected = ["acceptanceSignalId", "candidateCommitSha", "evidenceBundleId", "operationKey", "projectId", "pullRequestNumber",
    "requestDigest", "runId", "schemaVersion", "specRevisionId", "tenantId", "workflowId"];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected)) invalid();
  const operationId = typeof body.operationKey === "string" ? body.operationKey.slice("workflow-job:".length) : "";
  if (body.schemaVersion !== "deviludo.scm-merge.v1" || typeof body.operationKey !== "string"
    || !body.operationKey.startsWith("workflow-job:") || !UUID.test(operationId)
    || typeof body.requestDigest !== "string" || !SHA256.test(body.requestDigest)
    || typeof body.tenantId !== "string" || !UUID.test(body.tenantId) || typeof body.projectId !== "string" || !UUID.test(body.projectId)
    || typeof body.workflowId !== "string" || !SAFE_ID.test(body.workflowId) || typeof body.runId !== "string" || !UUID.test(body.runId)
    || typeof body.specRevisionId !== "string" || !UUID.test(body.specRevisionId) || typeof body.candidateCommitSha !== "string"
    || !SHA1.test(body.candidateCommitSha) || !Number.isSafeInteger(body.pullRequestNumber) || (body.pullRequestNumber as number) < 1
    || typeof body.evidenceBundleId !== "string" || !UUID.test(body.evidenceBundleId)
    || typeof body.acceptanceSignalId !== "string" || !SAFE_ID.test(body.acceptanceSignalId)) invalid();
  return Object.freeze(body as unknown as ScmMergeCommand);
}

function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function validDate(value: Date): Date { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid(); return value; }
function invalid(): never { throw new Error("SCM merge request or authority is invalid"); }
