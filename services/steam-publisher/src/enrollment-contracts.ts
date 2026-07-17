import type { SteamBuildSession } from "./contracts";

export type SteamEnrollmentState =
  | "WAITING_CREDENTIALS"
  | "WAITING_STEAM_GUARD"
  | "READY"
  | "FAILED"
  | "EXPIRED";

export interface SteamEnrollmentPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionBinding: string;
}

export interface SteamEnrollmentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionBindingDigest: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly state: SteamEnrollmentState;
  readonly challengeSecretRef: string | null;
  readonly buildSession: SteamBuildSession | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt: string | null;
}

export interface SteamEnrollmentStore {
  create(input: Omit<SteamEnrollmentRecord, "state" | "challengeSecretRef" | "buildSession" | "completedAt">): Promise<SteamEnrollmentRecord>;
  find(input: {
    readonly tenantId: string;
    readonly enrollmentId: string;
    readonly userId: string;
    readonly sessionBindingDigest: string;
  }): Promise<SteamEnrollmentRecord>;
  saveChallenge(input: {
    readonly tenantId: string;
    readonly enrollmentId: string;
    readonly challengeSecretRef: string;
    readonly at: string;
  }): Promise<SteamEnrollmentRecord>;
  complete(input: {
    readonly tenantId: string;
    readonly enrollmentId: string;
    readonly session: SteamBuildSession;
    readonly credentialBindingId: string;
    readonly fingerprint: string;
    readonly maskedValue: string;
    readonly at: string;
  }): Promise<SteamEnrollmentRecord>;
}

export interface SteamAuthenticatedLogin {
  readonly kind: "AUTHENTICATED";
  readonly accountId: string;
  readonly accountName: string;
  readonly configVdf: Uint8Array;
  readonly allowedAppIds: readonly string[];
  readonly permissions: readonly ("EditAppMetadata" | "PublishAppChanges")[];
  readonly expiresAt: string;
}

export interface SteamGuardChallenge {
  readonly kind: "GUARD_REQUIRED";
  /** Opaque short-lived Vault reference; never a raw Steam challenge token. */
  readonly challengeSecretRef: string;
}

export interface SteamInteractiveLoginConnector {
  begin(input: {
    readonly enrollmentId: string;
    readonly accountName: string;
    readonly password: Uint8Array;
  }): Promise<SteamAuthenticatedLogin | SteamGuardChallenge>;
  completeGuard(input: {
    readonly enrollmentId: string;
    readonly challengeSecretRef: string;
    readonly guardCode: Uint8Array;
  }): Promise<SteamAuthenticatedLogin>;
}

export interface SteamConfigVault {
  write(input: {
    readonly path: string;
    readonly plaintext: Uint8Array;
  }): Promise<{
    readonly secretRef: string;
    readonly maskedFingerprint: string;
  }>;
  revoke(secretRef: string): Promise<void>;
}

export interface SteamEnrollmentView {
  readonly enrollmentId: string;
  readonly state: "WAITING_CREDENTIALS" | "WAITING_STEAM_GUARD" | "READY";
  readonly enrollmentUrl: string | null;
  readonly expiresAt: string;
}
