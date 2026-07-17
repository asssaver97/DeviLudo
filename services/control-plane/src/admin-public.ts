import type { CredentialVersionRecord } from "./contracts";

export function credentialView(record: CredentialVersionRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: record.id,
    familyId: record.familyId,
    version: record.version,
    label: record.label,
    scope: record.scope,
    scopeId: record.scopeId,
    maskedFingerprint: record.maskedFingerprint,
    state: record.state,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    plaintextRecoverable: false,
  });
}

export function credentialResultView(result: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(result).map(([key, value]) => [
      key,
      isCredential(value) ? credentialView(value) : value,
    ]),
  ));
}

function isCredential(value: unknown): value is CredentialVersionRecord {
  return Boolean(value && typeof value === "object" && "maskedFingerprint" in value && "secretRef" in value);
}
