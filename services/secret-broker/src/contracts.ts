export type BrokerSecretPurpose = "provider-credential" | "github-pkce-v1";
export type BrokerAuditPurpose = BrokerSecretPurpose | "github-oauth-client-secret";
export type BrokerSecretState = "PENDING" | "ACTIVE" | "TAKE_CLAIMED" | "CONSUMED" | "REVOKED";

export interface BrokerSecretRecord {
  readonly id: string;
  readonly secretRef: string;
  readonly backendPath: string;
  readonly writeKey: string;
  readonly purpose: BrokerSecretPurpose;
  readonly plaintextDigest: string;
  readonly state: BrokerSecretState;
  readonly claimToken: string | null;
  readonly claimExpiresAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
}

export interface BrokerWriteReservation {
  readonly kind: "CLAIMED" | "REPLAY";
  readonly record: BrokerSecretRecord;
  readonly claimToken: string | null;
}

export interface BrokerTakeReservation {
  readonly record: BrokerSecretRecord;
  readonly claimToken: string;
}

export interface SecretBrokerStore {
  reserveWrite(input: Readonly<{
    id: string;
    writeKey: string;
    purpose: BrokerSecretPurpose;
    plaintextDigest: string;
    expiresAt: string | null;
    claimToken: string;
    claimExpiresAt: string;
    at: string;
  }>): Promise<BrokerWriteReservation>;
  activate(input: Readonly<{
    secretRef: string;
    claimToken: string;
    workloadSpiffeId: string;
    bindingDigest: string;
    at: string;
  }>): Promise<BrokerSecretRecord>;
  releaseWrite(secretRef: string, claimToken: string): Promise<void>;
  claimTake(input: Readonly<{
    secretRef: string;
    claimToken: string;
    claimExpiresAt: string;
    at: string;
  }>): Promise<BrokerTakeReservation | null>;
  releaseTake(secretRef: string, claimToken: string): Promise<void>;
  claimExpiredPkce(input: Readonly<{
    claimToken: string;
    claimExpiresAt: string;
    at: string;
    limit: number;
  }>): Promise<readonly BrokerSecretRecord[]>;
  completeExpiredPkce(input: Readonly<{
    secretRef: string;
    claimToken: string;
    workloadSpiffeId: string;
    bindingDigest: string;
    at: string;
  }>): Promise<void>;
  consume(input: Readonly<{
    secretRef: string;
    claimToken: string;
    workloadSpiffeId: string;
    bindingDigest: string;
    at: string;
  }>): Promise<void>;
  revoke(input: Readonly<{
    secretRef: string;
    workloadSpiffeId: string;
    bindingDigest: string;
    at: string;
  }>): Promise<BrokerSecretRecord | null>;
  active(secretRef: string, at: string): Promise<BrokerSecretRecord | null>;
  recordLease(input: Readonly<{
    secretRef: string;
    purpose: BrokerAuditPurpose;
    workloadSpiffeId: string;
    bindingDigest: string;
    at: string;
  }>): Promise<void>;
  probe(): Promise<void>;
}

export interface SecretBackend {
  create(path: string, plaintext: Uint8Array): Promise<void>;
  read(path: string): Promise<Buffer | null>;
  destroy(path: string): Promise<void>;
  probe(): Promise<void>;
}

export interface InferenceCredentialAuthority {
  resolveRun(input: Readonly<{
    tenantId: string;
    projectId: string;
    runId: string;
    providerRevisionId: string;
    credentialVersionId: string;
  }>): Promise<string>;
  resolveProbe(input: Readonly<{
    providerRevisionId: string;
    credentialVersionId: string;
  }>): Promise<string>;
  resolveSpecModel(input: Readonly<{
    profileRevisionId: string;
    providerRevisionId: string;
    credentialVersionId: string;
    protocol: "anthropic-messages" | "openai-responses";
    model: string;
  }>): Promise<string>;
  probe(): Promise<void>;
}

export class SecretBrokerConflictError extends Error {}
export class SecretBrokerValidationError extends Error {}
export class SecretBrokerUnavailableError extends Error {}
