import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import type { PreparedInputTenantAuthorizer } from "../../evidence-archive/src/prepared-inputs";
import { parseSourceExecutionPreparationTrigger } from "./contracts";
import type { SourceExecutionPreparationAuthority } from "./postgres-preparation-authority";
import type { SourceExecutionPreparer, SourceExecutionPreparationResult } from "./preparer";

/** Authenticates the workflow caller, then replaces its trigger with database authority. */
export class ArtifactPreparationService {
  constructor(private readonly options: {
    readonly tenants: PreparedInputTenantAuthorizer;
    readonly authority: SourceExecutionPreparationAuthority;
    readonly preparer: Pick<SourceExecutionPreparer, "prepare" | "probe">;
  }) {}

  async prepare(identity: EvidenceArchiveWorkloadIdentity, value: unknown): Promise<SourceExecutionPreparationResult> {
    const trigger = parseSourceExecutionPreparationTrigger(value);
    await this.options.tenants.authorize(identity, trigger.tenantId);
    const request = await this.options.authority.resolve(trigger);
    return this.options.preparer.prepare(request);
  }

  async probe(): Promise<void> {
    await Promise.all([
      this.options.tenants.probe(),
      this.options.authority.probe(),
      this.options.preparer.probe(),
    ]);
  }
}
