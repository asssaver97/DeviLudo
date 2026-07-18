import type { GitHubScmConnector } from "./github-contracts";
import {
  parseSourceBaselineRequest,
  type SourceBaselineReceipt,
  type SourceBaselineRequest,
} from "./source-baseline-contracts";
import type {
  SourceBaselineAcquireResult,
  SourceBaselineClaim,
} from "./source-baseline-postgres";

export class SourceBaselineBusyError extends Error {
  constructor() { super("Source baseline operation is already in progress"); }
}

export interface SourceBaselineStore {
  acquire(request: SourceBaselineRequest): Promise<SourceBaselineAcquireResult>;
  complete(
    claim: SourceBaselineClaim,
    observed: Readonly<{ defaultBranch: string; commitSha: string; sourceDigest: string; observedAt: string }>,
  ): Promise<SourceBaselineReceipt>;
  release(claim: SourceBaselineClaim): Promise<void>;
  probe(): Promise<void>;
}

/** Resolves and persists the exact current default-branch commit without workspace access. */
export class SourceBaselineService {
  constructor(
    private readonly store: SourceBaselineStore,
    private readonly github: Pick<GitHubScmConnector, "getRepository" | "getReference" | "getSourceDigest">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve(value: unknown): Promise<SourceBaselineReceipt> {
    const request = parseSourceBaselineRequest(value);
    const acquired = await this.store.acquire(request);
    if (acquired.kind === "REPLAY") return acquired.receipt;
    if (acquired.kind === "BUSY") throw new SourceBaselineBusyError();
    const { claim } = acquired;
    try {
      const repository = await this.github.getRepository(claim.binding);
      if (repository.repositoryId !== claim.binding.repositoryId
        || repository.repositoryNodeId !== claim.binding.repositoryNodeId
        || repository.owner !== claim.binding.owner || repository.name !== claim.binding.name
        || repository.defaultBranch !== claim.binding.defaultBranch
        || repository.archived || repository.disabled) invalid();
      const reference = await this.github.getReference(claim.binding, claim.binding.defaultBranch);
      if (!reference || reference.branch !== claim.binding.defaultBranch) invalid();
      const sourceDigest = await this.github.getSourceDigest(claim.binding, reference.commitSha);
      const observedAt = this.now();
      if (!Number.isFinite(observedAt.getTime())) invalid();
      return await this.store.complete(claim, {
        defaultBranch: claim.binding.defaultBranch,
        commitSha: reference.commitSha,
        sourceDigest,
        observedAt: observedAt.toISOString(),
      });
    } catch (error) {
      await this.store.release(claim).catch(() => undefined);
      throw error;
    }
  }

  async probe(): Promise<void> { await this.store.probe(); }
}

function invalid(): never { throw new Error("GitHub source baseline receipt is invalid"); }
