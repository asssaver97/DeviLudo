import type { CandidatePublicationReceipt, CandidatePublicationRequest } from "./candidate-publication-contracts";
import { parseCandidatePublicationRequest, validateCandidatePublicationReceipt } from "./candidate-publication-contracts";
import type { GitHubCandidateReceipt, GitHubRepositoryBinding } from "./github-contracts";
import type { GitHubAppScmProxy } from "./github-proxy";

export interface CandidatePublicationAuthority {
  resolve(request: CandidatePublicationRequest): Promise<Readonly<{
    repositoryBindingId: string;
    binding: GitHubRepositoryBinding;
    specRevisionId: string;
  }>>;
  probe(): Promise<void>;
}

export interface CandidateReceiptArchive {
  persist(input: Readonly<{ request: CandidatePublicationRequest; repositoryBindingId: string;
    specRevisionId: string; receipt: GitHubCandidateReceipt }>): Promise<Readonly<{ receiptId: string }>>;
  probe(): Promise<void>;
}

export class AuthoritativeCandidatePublicationService {
  constructor(private readonly authority: CandidatePublicationAuthority,
    private readonly github: Pick<GitHubAppScmProxy, "publishCandidate">,
    private readonly archive: CandidateReceiptArchive,
    private readonly now: () => Date = () => new Date(),
    private readonly readiness: readonly Readonly<{ probe(): Promise<void> }>[] = []) {}

  async publish(value: CandidatePublicationRequest): Promise<CandidatePublicationReceipt> {
    const request = parseCandidatePublicationRequest(value);
    const authority = await this.authority.resolve(request);
    const at = this.now().toISOString();
    const artifact = request.artifact.payload;
    const published = await this.github.publishCandidate({ idempotencyKey: request.operationKey,
      binding: authority.binding, artifact: request.artifact,
      pullRequestTitle: `DeviLudo: implement specification ${authority.specRevisionId}`,
      pullRequestBody: `Automated candidate for AgentRun ${request.runId}.\n\nArtifact: ${artifact.artifactDigest}`,
    }, at);
    const archived = await this.archive.persist({ request, repositoryBindingId: authority.repositoryBindingId,
      specRevisionId: authority.specRevisionId, receipt: published });
    return validateCandidatePublicationReceipt({ schemaVersion: "deviludo.scm-candidate-publication-receipt.v1",
      operationKey: request.operationKey, requestDigest: request.requestDigest, tenantId: request.tenantId,
      projectId: request.projectId, runId: request.runId, attemptId: request.attemptId,
      resolutionDigest: request.resolutionDigest, artifactId: published.artifactId,
      artifactDigest: published.artifactDigest, baseCommitSha: published.baseCommitSha,
      candidateCommitSha: published.candidateCommitSha, sourceDigest: published.sourceDigest,
      draftPullRequest: published.pullRequestNumber, receiptId: archived.receiptId }, request);
  }

  async probe(): Promise<void> { await Promise.all([this.authority.probe(), this.archive.probe(), ...this.readiness.map((item) => item.probe())]); }
}
