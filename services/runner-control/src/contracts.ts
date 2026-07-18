import type { KeyObject } from "node:crypto";
import type {
  EvidenceBundle,
  PlatformEvidence,
  PlatformRunnerLease,
  RunnerEvent,
  RunnerEventCursor,
} from "../../../lib/domain/e2e";
import type { TargetPlatform } from "../../../lib/domain/types";

export type RunnerArchitecture = "x86_64" | "arm64";

/** Constructed only from an authenticated TLS socket by the ingress adapter. */
export interface TlsRunnerIdentity {
  readonly spiffeId: string;
  readonly certificateFingerprint: string;
  readonly certificateSerial: string;
  readonly certificateNotAfter: string;
}

export interface RunnerCapabilities {
  readonly runnerId: string;
  readonly platform: TargetPlatform;
  readonly architecture: RunnerArchitecture;
  readonly osVersion: string;
  readonly runnerImageDigest: string;
  readonly godotVersion: string;
  readonly godotBinaryDigest: string;
  readonly exportTemplatesDigest: string;
  readonly gpu: string;
  readonly display: "physical" | "virtual" | "headless";
  readonly audio: "physical" | "virtual" | "none";
  readonly installedAutonomousAgents: readonly string[];
  readonly steamClientConnector: Readonly<{
    readonly version: string;
    readonly bridgeVersion: string;
    readonly controllerContractVersion: 1;
    readonly binaryDigest: string;
    readonly automationPolicyDigest: string;
    readonly supplyChainEvidenceDigest: string;
  }> | null;
  readonly capabilityDigest: string;
}

export interface RegisteredRunner extends RunnerCapabilities {
  readonly spiffeId: string;
  readonly certificateFingerprint: string;
  readonly certificateSerial: string;
  readonly certificateNotAfter: string;
  readonly state: "ONLINE" | "DRAINING" | "OFFLINE" | "QUARANTINED";
  readonly registeredAt: string;
  readonly lastSeenAt: string;
}

export interface RunnerAdmissionPolicy {
  authorize(input: {
    readonly identity: TlsRunnerIdentity;
    readonly capabilities: RunnerCapabilities;
  }): Promise<boolean>;
}

export interface SourceArtifact {
  readonly objectKey: string;
  readonly digest: string;
}

export type RunnerJobExecution =
  | Readonly<{
      kind: "SOURCE_ARTIFACT";
      objectKey: string;
      artifactDigest: string;
    }>
  | Readonly<{
      kind: "STEAM_CLEAN_INSTALL";
      steamAppId: string;
      buildId: string;
      betaBranch: string;
      installGrantId: string;
    }>;

export interface MatrixAttemptSpec {
  readonly attemptId: string;
  readonly executionLockId: string;
  readonly executionLockDigest: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly iterationId: string;
  readonly commitSha: string;
  readonly sourceDigest: string;
  readonly sourceArtifact: SourceArtifact;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly runnerToolchainRevisionId: string;
  readonly runnerToolchainDigest: string;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly requiredGodotVersion: string;
  readonly godotTestKitDigest: string;
  readonly exportTemplates: Readonly<Record<TargetPlatform, string>>;
  readonly buildManifestDigest: string;
  readonly sbomDigest: string;
  readonly vulnerabilityScanDigest: string;
  readonly assetLicenseLedgerDigest: string;
  readonly leaseDurationSeconds: number;
}

export interface RunnerJobPayload {
  readonly schemaVersion: "deviludo.runner-job.v2";
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly iterationId: string;
  readonly runnerId: string;
  readonly platform: TargetPlatform;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly executionLockId: string;
  readonly executionLockDigest: string;
  readonly commitSha: string;
  readonly sourceDigest: string;
  readonly execution: RunnerJobExecution;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly runnerToolchainRevisionId: string;
  readonly runnerToolchainDigest: string;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly requiredGodotVersion: string;
  readonly godotTestKitDigest: string;
  readonly exportTemplatesDigest: string;
  readonly runnerCapabilityDigest: string;
  readonly buildManifestDigest: string;
  readonly sbomDigest: string;
  readonly vulnerabilityScanDigest: string;
  readonly assetLicenseLedgerDigest: string;
  readonly requiredEvidence: readonly (
    | "logs"
    | "junit"
    | "input-timeline"
    | "screenshots"
    | "video"
    | "production-export"
  )[];
}

export interface SignedRunnerJob {
  readonly payload: RunnerJobPayload;
  readonly signature: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly value: string;
  };
}

export interface PlatformEvidenceManifest extends PlatformEvidence {
  readonly schemaVersion: "deviludo.platform-evidence.v1";
  readonly attemptId: string;
  readonly fencingToken: number;
  readonly commitSha: string;
  readonly sourceDigest: string;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly godotTestKitDigest: string;
  readonly exportTemplatesDigest: string;
  readonly manifestDigest: string;
  readonly createdAt: string;
}

export interface PlatformLeaseState {
  readonly lease: PlatformRunnerLease;
  readonly cursor: RunnerEventCursor;
  readonly evidence: PlatformEvidenceManifest | null;
}

export interface MatrixAttemptState {
  readonly spec: MatrixAttemptSpec;
  readonly state: "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "INVALIDATED";
  readonly platforms: Readonly<Partial<Record<TargetPlatform, PlatformLeaseState>>>;
  readonly evidenceBundle: EvidenceBundle | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunnerJobSignerOptions {
  readonly keyId: string;
  readonly privateKey: KeyObject;
}

export interface RunnerEventReceipt {
  readonly accepted: true;
  readonly attemptState: MatrixAttemptState["state"];
  readonly cursor: RunnerEventCursor;
  readonly event: RunnerEvent;
  readonly evidenceBundle: EvidenceBundle | null;
}

export interface RunnerJobVerificationContext {
  readonly keyId: string;
  readonly runnerId: string;
  readonly platform: TargetPlatform;
  readonly now: string;
}
