import type { SteamTargetPlatform } from "../../steam-publisher/src/contracts";
import type { SteamDepotSigningScheme } from "../../steam-publisher/src/depot-finalization";

export interface SteamDepotFinalizationRequest {
  readonly schemaVersion: "deviludo.steam-depot-finalization.v1";
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly mainCommitSha: string;
  readonly evidenceBundleDigest: string;
  readonly platform: SteamTargetPlatform;
  readonly sourceObjectKey: string;
  readonly sourceArtifactDigest: string;
  readonly requestDigest: string;
}

export interface SteamDepotFinalizationReceipt {
  readonly schemaVersion: "deviludo.steam-depot-finalization-receipt.v1";
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly mainCommitSha: string;
  readonly evidenceBundleDigest: string;
  readonly platform: SteamTargetPlatform;
  readonly sourceArtifactDigest: string;
  readonly artifactObjectKey: string;
  readonly artifactDigest: string;
  readonly signingScheme: SteamDepotSigningScheme;
  readonly signingIdentityDigest: string;
  readonly signingEvidenceObjectKey: string;
  readonly signingEvidenceDigest: string;
  readonly notarizationEvidenceObjectKey: string | null;
  readonly notarizationEvidenceDigest: string | null;
}

export interface SteamDepotNativeFinalizer {
  finalize(request: SteamDepotFinalizationRequest): Promise<SteamDepotFinalizationReceipt>;
  probe(): Promise<void>;
}

export interface SteamDepotFinalizationOperationStore {
  claim(input: Readonly<{
    request: SteamDepotFinalizationRequest;
    claimToken: string;
    claimedAt: string;
    claimExpiresAt: string;
  }>): Promise<
    | Readonly<{ kind: "ACQUIRED"; attempt: number }>
    | Readonly<{ kind: "BUSY" }>
    | Readonly<{ kind: "REPLAY"; receipt: SteamDepotFinalizationReceipt }>
  >;
  complete(input: Readonly<{
    request: SteamDepotFinalizationRequest;
    claimToken: string;
    receipt: SteamDepotFinalizationReceipt;
    receiptDigest: string;
    completedAt: string;
  }>): Promise<void>;
  release(input: Readonly<{
    request: SteamDepotFinalizationRequest;
    claimToken: string;
    releasedAt: string;
  }>): Promise<void>;
  probe(): Promise<void>;
}
