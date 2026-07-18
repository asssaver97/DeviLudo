import type { MtlsAuthoritativeSourceSnapshotClient } from "../../artifact-preparer/src/source-snapshot-client";
import type { AgentBaselineSourcePort } from "./native-microvm-executor";

/** Adapts the read-only SCM snapshot Broker to one AgentRun baseline workspace. */
export class AgentBaselineSourceSnapshotPort implements AgentBaselineSourcePort {
  constructor(private readonly snapshots: Pick<MtlsAuthoritativeSourceSnapshotClient, "materialize" | "probe">) {}

  async materialize(input: Parameters<AgentBaselineSourcePort["materialize"]>[0]) {
    return this.snapshots.materialize({ tenantId: input.tenantId, projectId: input.projectId, runId: input.runId,
      mode: "AGENT_BASELINE", commitSha: input.commitSha, expectedSourceDigest: input.sourceDigest,
      destinationPath: input.destinationPath });
  }

  async probe(): Promise<void> { await this.snapshots.probe(); }
}
