import type { EvidenceBundle } from "../../../lib/domain/e2e";

export interface ImmutableObjectPut {
  readonly objectKey: string;
  readonly contentType: "application/json";
  readonly contentDigest: string;
  readonly body: Buffer;
}

export interface ImmutableObjectStore {
  putImmutable(input: ImmutableObjectPut): Promise<Readonly<{ created: boolean }>>;
  probe(): Promise<void>;
}

export interface EvidenceArchiveRequest {
  readonly schemaVersion: "deviludo.runner-evidence-archive.v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly bundleDigest: string;
  readonly bundle: EvidenceBundle;
}

export interface EvidenceArchiveReceipt {
  readonly schemaVersion: "deviludo.runner-evidence-archive-receipt.v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly bundleDigest: string;
  readonly objectKey: string;
  readonly repairPromptId: string | null;
}

export interface EvidenceArchivePersistResult {
  readonly receipt: EvidenceArchiveReceipt;
  readonly created: boolean;
}

export interface EvidenceArchiveWorkloadIdentity {
  readonly spiffeId: string;
  readonly certificateFingerprint: string;
  readonly certificateSerial: string;
  readonly certificateNotAfter: string;
}
