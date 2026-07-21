import type { SourceBaselineReceipt, SourceBaselineRequest } from "../../scm-proxy/src/source-baseline-contracts";
import type { DeliveryRepairContext } from "../../../lib/orchestration/game-delivery";
import type { AgentFailureDiagnostic } from "../../../lib/agent/types";

export type TargetPlatform = "linux" | "macos" | "windows";
export type AgentKind = "claude-code" | "codex-cli";

export interface AgentVersionAttestationLock {
  readonly catalogReceiptDigest: string;
  readonly validationReceiptId: string;
  readonly validationReceiptDigest: string;
  readonly supplyChainEvidenceDigest: string;
  readonly validatedAdapterVersion: string;
  readonly adapterCompatibility: Readonly<{ min: string; maxExclusive: string }>;
}

export interface AgentConfigurationClaim {
  readonly kind: "CLAIMED";
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly actionId: string;
  readonly specRevisionId: string;
  readonly testPlanRevisionId: string;
  readonly specApprovalReceiptId: string;
  readonly repairContext: DeliveryRepairContext | null;
  readonly claimToken: string;
}

export interface LockedAgentConfiguration {
  readonly kind: "LOCKED";
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly actionId: string;
  readonly specRevisionId: string;
  readonly testPlanRevisionId: string;
  readonly specApprovalReceiptId: string;
  readonly repairContext: DeliveryRepairContext | null;
  readonly sourceBaselineReceiptId: string;
  readonly runId: string;
  readonly resolutionDigest: string;
}

export type AgentConfigurationWork = AgentConfigurationClaim | LockedAgentConfiguration;

export interface AgentProfileConfigurationLock {
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly workerPool: string;
  readonly imageDigest: string;
  readonly agentVersionId: string;
  readonly exactAgentVersion: string;
  readonly agentVersionSourceDigest: string;
  /** Null only when replaying a pre-attestation lock for an already-started repair chain. */
  readonly agentVersionAttestation: AgentVersionAttestationLock | null;
  readonly adapterVersion: string;
  readonly workerImageId: string;
  readonly buildReceiptId: string;
  readonly buildReceiptDigest: string;
  readonly agent: AgentKind;
  readonly providerRevisionId: string;
  readonly providerProtocol: "anthropic-messages" | "openai-responses";
  readonly providerBaseUrl: string;
  readonly providerApprovedPorts: readonly number[];
  readonly providerAuthentication: "x-api-key" | "authorization-bearer" | "bearer";
  readonly providerPricing: Readonly<{
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  }>;
  readonly providerGovernance: Readonly<{
    dataRegion: string;
    retentionPolicy: string;
    trainingPolicy: string;
    confirmedBy: string;
    confirmedAt: string;
  }>;
  readonly inferenceAuthorizationExpiresAt: string;
  readonly modelRoles: Readonly<{
    primaryModel: string;
    planningModel: string;
    smallFastModel: string;
    subagentModel: string;
  }>;
  readonly credentialVersionId: string;
  readonly budget: Readonly<{ maxUsd: number; maxTurns: number; timeoutSeconds: number }>;
}

export interface AgentConfigurationLock {
  readonly profileRevisionId: string;
  readonly profileSource: string;
  readonly installationId: string;
  readonly workerPool: string;
  readonly imageDigest: string;
  readonly agentVersionId: string;
  readonly exactAgentVersion: string;
  readonly agentVersionSourceDigest: string;
  /** Null only when replaying a pre-attestation lock for an already-started repair chain. */
  readonly agentVersionAttestation: AgentVersionAttestationLock | null;
  readonly adapterVersion: string;
  readonly workerImageId: string;
  readonly buildReceiptId: string;
  readonly buildReceiptDigest: string;
  readonly agent: AgentKind;
  readonly providerRevisionId: string;
  readonly providerProtocol: "anthropic-messages" | "openai-responses";
  readonly providerBaseUrl: string;
  readonly providerApprovedPorts: readonly number[];
  readonly providerAuthentication: "x-api-key" | "authorization-bearer" | "bearer";
  readonly providerPricing: Readonly<{
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  }>;
  readonly providerGovernance: Readonly<{
    dataRegion: string;
    retentionPolicy: string;
    trainingPolicy: string;
    confirmedBy: string;
    confirmedAt: string;
  }>;
  readonly inferenceAuthorizationExpiresAt: string;
  readonly modelRoles: Readonly<{
    primaryModel: string;
    planningModel: string;
    smallFastModel: string;
    subagentModel: string;
  }>;
  readonly credentialVersionId: string;
  readonly budget: Readonly<{ maxUsd: number; maxTurns: number; timeoutSeconds: number }>;
  readonly fallback: AgentProfileConfigurationLock | null;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanRevisionId: string;
  readonly testPlanDigest: string;
  readonly specApprovalReceiptId: string;
  readonly runnerToolchainRevisionId: string;
  readonly runnerToolchainDigest: string;
  readonly sourceBaselineReceiptId: string;
  readonly commitSha: string;
  readonly sourceDigest: string;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly adminCatalogRevision: string;
  readonly repairContext: Readonly<{
    readonly attempt: number;
    readonly reason: "AGENT_FAILURE" | "E2E_FAILURE";
    readonly fromRunConfigurationId: string;
    readonly diagnosticId: string | null;
    readonly agentDiagnostic: AgentFailureDiagnostic | null;
    readonly evidenceBundleId: string | null;
    readonly evidenceBundleDigest: string | null;
    readonly repairPromptId: string | null;
    readonly candidateCommitSha: string | null;
    readonly draftPullRequest: number | null;
    readonly failedPlatforms: readonly Readonly<{
      readonly platform: TargetPlatform;
      readonly runnerId: string;
      readonly logsDigest: string;
      readonly junitDigest: string;
      readonly screenshotManifestDigest: string;
      readonly videoManifestDigest: string;
    }>[];
  }> | null;
  readonly resolvedAt: string;
  readonly resolutionDigest: string;
}

export interface AgentConfigurationStore {
  claimNext(tenantId: string): Promise<AgentConfigurationWork | null>;
  lock(claim: AgentConfigurationClaim, baseline: SourceBaselineReceipt | null): Promise<LockedAgentConfiguration>;
  complete(work: LockedAgentConfiguration, outboxId: string): Promise<void>;
  release(claim: AgentConfigurationClaim): Promise<void>;
  probe(): Promise<void>;
}

export interface SourceBaselinePort {
  resolve(request: SourceBaselineRequest): Promise<SourceBaselineReceipt>;
  probe(): Promise<void>;
}
