import { createHash } from "node:crypto";
import { canonicalJson, sha256Canonical } from "../../runner-control/src/canonical";
import type { EvidenceArchiveWorkloadIdentity, ImmutableObjectStore } from "./contracts";
import type { RunnerArtifactTransfer, RunnerArtifactTransferGrant } from "./runner-artifacts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_GRANT_SECONDS = 300;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;

export type PreparedInputArtifactKind = "source-bundle" | "test-plan";

export interface PreparedInputTenantAuthorizer {
  authorize(identity: EvidenceArchiveWorkloadIdentity, tenantId: string): Promise<void>;
  probe(): Promise<void>;
}

interface PreparedInputBinding {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly lockKey: string;
  readonly artifactKind: PreparedInputArtifactKind;
  readonly artifactDigest: string;
  readonly sizeBytes: number;
  readonly objectKey: string;
  readonly contentType: "application/zstd" | "application/json";
  readonly bindingDigest: string;
}

/** Issues and commits only short-lived, tenant-assigned immutable Runner input uploads. */
export class PreparedInputGrantService {
  readonly #authorizer: PreparedInputTenantAuthorizer;
  readonly #transfer: RunnerArtifactTransfer;
  readonly #reservations: ImmutableObjectStore;
  readonly #now: () => Date;

  constructor(options: {
    readonly authorizer: PreparedInputTenantAuthorizer;
    readonly transfer: RunnerArtifactTransfer;
    readonly reservations: ImmutableObjectStore;
    readonly now?: () => Date;
  }) {
    this.#authorizer = options.authorizer;
    this.#transfer = options.transfer;
    this.#reservations = options.reservations;
    this.#now = options.now ?? (() => new Date());
  }

  async grant(identity: EvidenceArchiveWorkloadIdentity, value: unknown): Promise<Readonly<Record<string, unknown>>> {
    const binding = parseRequest(value, "deviludo.prepared-input-grant-request.v1");
    await this.#authorizer.authorize(identity, binding.tenantId);
    const now = validNow(this.#now());
    const expiresAt = new Date(now.getTime() + MAX_GRANT_SECONDS * 1_000).toISOString();
    const transfer = await this.#transfer.createUploadGrant({
      objectKey: binding.objectKey,
      artifactDigest: binding.artifactDigest,
      sizeBytes: binding.sizeBytes,
      contentType: binding.contentType,
      expiresAt,
    });
    validateTransferGrant(transfer, binding, now);
    return deepFreeze({
      schemaVersion: "deviludo.prepared-input-grant.v1",
      ...binding,
      method: "PUT",
      url: transfer.url,
      requiredHeaders: transfer.requiredHeaders,
      expiresAt,
      commitRequired: true,
    });
  }

  async commit(identity: EvidenceArchiveWorkloadIdentity, value: unknown): Promise<Readonly<Record<string, unknown>>> {
    const binding = parseRequest(value, "deviludo.prepared-input-commit-request.v1");
    await this.#authorizer.authorize(identity, binding.tenantId);
    const verified = await this.#transfer.verifyObject({
      objectKey: binding.objectKey,
      artifactDigest: binding.artifactDigest,
      sizeBytes: binding.sizeBytes,
    });
    if (verified.sizeBytes !== binding.sizeBytes) invalid("stored object");
    const receipt = deepFreeze({
      schemaVersion: "deviludo.prepared-input-commit-receipt.v1",
      ...binding,
      verified: true,
    });
    const body = Buffer.from(canonicalJson(receipt), "utf8");
    await this.#reservations.putImmutable({
      objectKey: preparedInputReceiptObjectKey(binding),
      contentType: "application/json",
      contentDigest: createHash("sha256").update(body).digest("hex"),
      body,
    });
    return receipt;
  }

  async probe(): Promise<void> {
    await Promise.all([this.#authorizer.probe(), this.#transfer.probe(), this.#reservations.probe()]);
  }
}

function parseRequest(value: unknown, schemaVersion: string): PreparedInputBinding {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "tenantId", "projectId", "runId", "lockKey", "artifactKind", "artifactDigest", "sizeBytes",
  ]);
  if (body.schemaVersion !== schemaVersion) invalid("request schema");
  const tenantId = required(body.tenantId, UUID, "tenant");
  const projectId = required(body.projectId, UUID, "project");
  const runId = required(body.runId, UUID, "run");
  const lockKey = required(body.lockKey, SHA256, "lock key");
  const artifactDigest = required(body.artifactDigest, SHA256, "artifact digest");
  if (body.artifactKind !== "source-bundle" && body.artifactKind !== "test-plan") invalid("artifact kind");
  const artifactKind = body.artifactKind as PreparedInputArtifactKind;
  const maximum = artifactKind === "source-bundle" ? MAX_SOURCE_BYTES : MAX_PLAN_BYTES;
  const sizeBytes = integer(body.sizeBytes, 1, maximum, "artifact size");
  const objectKey = preparedInputObjectKey({ tenantId, projectId, artifactKind, artifactDigest });
  const contentType = artifactKind === "source-bundle" ? "application/zstd" as const : "application/json" as const;
  const core = { tenantId, projectId, runId, lockKey, artifactKind, artifactDigest, sizeBytes, objectKey, contentType };
  return deepFreeze({ ...core, bindingDigest: sha256Canonical(core) });
}

export function preparedInputObjectKey(input: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly artifactKind: PreparedInputArtifactKind;
  readonly artifactDigest: string;
}): string {
  return input.artifactKind === "source-bundle"
    ? `tenants/${input.tenantId}/projects/${input.projectId}/sources/${input.artifactDigest}.tar.zst`
    : `tenants/${input.tenantId}/projects/${input.projectId}/test-plans/${input.artifactDigest}.json`;
}

function preparedInputReceiptObjectKey(binding: PreparedInputBinding): string {
  return `tenants/${binding.tenantId}/projects/${binding.projectId}/prepared-input-receipts/${binding.runId}/${binding.lockKey}/${binding.artifactKind}.json`;
}

function validateTransferGrant(grant: RunnerArtifactTransferGrant, binding: PreparedInputBinding, now: Date): void {
  let url: URL;
  try { url = new URL(grant.url); }
  catch { invalid("transfer grant"); }
  const expiry = Date.parse(grant.expiresAt);
  const expectedHeaders = [
    "content-length", "content-type", "if-none-match", "x-amz-checksum-sha256", "x-amz-meta-deviludo-sha256",
  ];
  if (grant.method !== "PUT" || url.protocol !== "https:" || url.username || url.password || url.hash
    || !Number.isFinite(expiry) || expiry <= now.getTime() || expiry > now.getTime() + MAX_GRANT_SECONDS * 1_000
    || grant.requiredHeaders["content-length"] !== String(binding.sizeBytes)
    || grant.requiredHeaders["content-type"] !== binding.contentType
    || grant.requiredHeaders["if-none-match"] !== "*"
    || grant.requiredHeaders["x-amz-checksum-sha256"] !== Buffer.from(binding.artifactDigest, "hex").toString("base64")
    || grant.requiredHeaders["x-amz-meta-deviludo-sha256"] !== binding.artifactDigest
    || JSON.stringify(Object.keys(grant.requiredHeaders).sort()) !== JSON.stringify(expectedHeaders)) invalid("transfer grant");
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid("clock");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("request");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("request fields");
}

function required(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(label);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(label);
  return value as number;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(label: string): never {
  throw new Error(`Evidence archive prepared input ${label} is invalid`);
}
