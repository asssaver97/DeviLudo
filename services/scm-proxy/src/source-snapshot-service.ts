import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createSourceBundle } from "../../godot-testkit/src/source-bundle-builder";
import { sha256Canonical } from "../../runner-control/src/canonical";
import {
  directArtifactTransferHttps,
  type TestKitArtifactTransferHttp,
} from "../../runner-control/src/testkit-artifact-client";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import type { RunnerArtifactTransfer, RunnerArtifactTransferGrant } from "../../evidence-archive/src/runner-artifacts";
import type { GitHubRepositoryBinding } from "./github-contracts";
import type { GitHubSourceMaterializer } from "./github-source-materializer";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_GRANT_MS = 5 * 60_000;

export interface SourceSnapshotTenantAuthorizer {
  authorize(identity: EvidenceArchiveWorkloadIdentity, tenantId: string): Promise<void>;
  probe(): Promise<void>;
}

export interface SourceSnapshotAuthority {
  resolve(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly mode: "AGENT_BASELINE" | "CANDIDATE" | "MAIN_RELEASE_GATE";
    readonly commitSha: string;
    readonly sourceDigest: string;
  }): Promise<Readonly<{ binding: GitHubRepositoryBinding; sourceDigest: string }>>;
  probe(): Promise<void>;
}

/** Builds one deterministic SCM snapshot, uploads it immutably, then returns only a short download grant. */
export class SourceSnapshotGrantService {
  readonly #tenants: SourceSnapshotTenantAuthorizer;
  readonly #authority: SourceSnapshotAuthority;
  readonly #materializer: GitHubSourceMaterializer;
  readonly #transfer: RunnerArtifactTransfer;
  readonly #transferHttp: TestKitArtifactTransferHttp;
  readonly #transferCa: Buffer;
  readonly #allowedTransferOrigins: ReadonlySet<string>;
  readonly #workRoot: string;
  readonly #transferTimeoutMs: number;
  readonly #now: () => Date;

  constructor(options: {
    readonly tenants: SourceSnapshotTenantAuthorizer;
    readonly authority: SourceSnapshotAuthority;
    readonly materializer: GitHubSourceMaterializer;
    readonly transfer: RunnerArtifactTransfer;
    readonly transferCa: Buffer;
    readonly allowedTransferOrigins: readonly string[];
    readonly workRoot: string;
    readonly transferTimeoutMs?: number;
    readonly transferHttp?: TestKitArtifactTransferHttp;
    readonly now?: () => Date;
  }) {
    if (!Buffer.isBuffer(options.transferCa) || options.transferCa.byteLength < 32
      || options.transferCa.byteLength > 1024 * 1024) invalid("configuration");
    this.#tenants = options.tenants;
    this.#authority = options.authority;
    this.#materializer = options.materializer;
    this.#transfer = options.transfer;
    this.#transferHttp = options.transferHttp ?? directArtifactTransferHttps;
    this.#transferCa = Buffer.from(options.transferCa);
    this.#allowedTransferOrigins = origins(options.allowedTransferOrigins);
    this.#workRoot = absolute(options.workRoot);
    this.#transferTimeoutMs = integer(options.transferTimeoutMs ?? 2 * 60 * 60_000, 1_000, 24 * 60 * 60_000);
    this.#now = options.now ?? (() => new Date());
  }

  async grant(identity: EvidenceArchiveWorkloadIdentity, value: unknown): Promise<Readonly<Record<string, unknown>>> {
    const request = parseRequest(value);
    await this.#tenants.authorize(identity, request.tenantId);
    const authoritative = await this.#authority.resolve(request);
    validateAuthority(authoritative, request);
    const root = await privateRoot(this.#workRoot);
    const temporary = await mkdtemp(join(root, "snapshot-"));
    if (!temporary.startsWith(`${root}${sep}`)) invalid("temporary boundary");
    try {
      if (process.platform !== "win32") await chmod(temporary, 0o700);
      const snapshot = join(temporary, "source");
      const materialized = await this.#materializer.materialize({
        binding: authoritative.binding,
        commitSha: request.commitSha,
        expectedSourceDigest: request.sourceDigest,
        destinationPath: snapshot,
      });
      if (materialized.sourceDigest !== request.sourceDigest) invalid("materialization receipt");
      const archivePath = join(temporary, "source.tar.zst");
      const artifact = await createSourceBundle(snapshot, archivePath);
      const objectKey = snapshotObjectKey(request, artifact.artifactDigest);
      const contentType = "application/zstd";
      const uploadNow = validNow(this.#now());
      const uploadExpiresAt = new Date(uploadNow.getTime() + MAX_GRANT_MS).toISOString();
      const upload = await this.#transfer.createUploadGrant({
        objectKey,
        artifactDigest: artifact.artifactDigest,
        sizeBytes: artifact.sizeBytes,
        contentType,
        expiresAt: uploadExpiresAt,
      });
      validateUploadGrant(upload, objectKey, artifact.artifactDigest, artifact.sizeBytes, contentType, uploadNow, this.#allowedTransferOrigins);
      const uploaded = await this.#transferHttp.upload({
        url: new URL(upload.url),
        headers: upload.requiredHeaders,
        ca: this.#transferCa,
        sourcePath: archivePath,
        sizeBytes: artifact.sizeBytes,
        timeoutMs: this.#transferTimeoutMs,
      });
      if (!((uploaded.statusCode >= 200 && uploaded.statusCode < 300)
        || uploaded.statusCode === 409 || uploaded.statusCode === 412)) invalid("upload");
      const verified = await this.#transfer.verifyObject({
        objectKey,
        artifactDigest: artifact.artifactDigest,
        sizeBytes: artifact.sizeBytes,
      });
      if (verified.sizeBytes !== artifact.sizeBytes) invalid("stored object");
      const downloadNow = validNow(this.#now());
      if (downloadNow.getTime() < uploadNow.getTime()) invalid("clock");
      const downloadExpiresAt = new Date(downloadNow.getTime() + MAX_GRANT_MS).toISOString();
      const download = await this.#transfer.createDownloadGrant({
        objectKey,
        artifactDigest: artifact.artifactDigest,
        expiresAt: downloadExpiresAt,
      });
      validateDownloadGrant(download, downloadExpiresAt, downloadNow, this.#allowedTransferOrigins);
      const core = {
        tenantId: request.tenantId,
        projectId: request.projectId,
        runId: request.runId,
        mode: request.mode,
        commitSha: request.commitSha,
        sourceDigest: request.sourceDigest,
        artifactDigest: artifact.artifactDigest,
        sizeBytes: artifact.sizeBytes,
        objectKey,
        contentType,
      };
      return deepFreeze({
        schemaVersion: "deviludo.source-snapshot-grant.v1",
        ...core,
        bindingDigest: sha256Canonical(core),
        method: "GET",
        url: download.url,
        requiredHeaders: download.requiredHeaders,
        expiresAt: download.expiresAt,
      });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async probe(): Promise<void> {
    await Promise.all([this.#tenants.probe(), this.#authority.probe(), this.#transfer.probe()]);
  }
}

function parseRequest(value: unknown) {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "tenantId", "projectId", "runId", "mode", "commitSha", "sourceDigest"]);
  if (body.schemaVersion !== "deviludo.source-snapshot-grant-request.v1") invalid("request schema");
  if (body.mode !== "AGENT_BASELINE" && body.mode !== "CANDIDATE" && body.mode !== "MAIN_RELEASE_GATE") invalid("mode");
  return Object.freeze({
    tenantId: required(body.tenantId, UUID, "tenant"),
    projectId: required(body.projectId, UUID, "project"),
    runId: required(body.runId, UUID, "run"),
    mode: body.mode,
    commitSha: required(body.commitSha, SHA1, "commit"),
    sourceDigest: required(body.sourceDigest, SHA256, "source digest"),
  });
}

function validateAuthority(
  value: Readonly<{ binding: GitHubRepositoryBinding; sourceDigest: string }>,
  request: ReturnType<typeof parseRequest>,
): void {
  const binding = value?.binding;
  if (!binding || value.sourceDigest !== request.sourceDigest || binding.tenantId !== request.tenantId
    || binding.projectId !== request.projectId || !/^\d+$/.test(binding.installationId)
    || !Number.isSafeInteger(binding.repositoryId) || binding.repositoryId < 1
    || !binding.repositoryNodeId || !binding.owner || !binding.name || !binding.defaultBranch) invalid("authority receipt");
}

function snapshotObjectKey(request: ReturnType<typeof parseRequest>, artifactDigest: string): string {
  return `tenants/${request.tenantId}/projects/${request.projectId}/scm-snapshots/${request.commitSha}/${request.sourceDigest}/${artifactDigest}.tar.zst`;
}

function validateUploadGrant(
  grant: RunnerArtifactTransferGrant,
  objectKey: string,
  artifactDigest: string,
  sizeBytes: number,
  contentType: string,
  now: Date,
  allowedOrigins: ReadonlySet<string>,
): void {
  const expectedHeaders = {
    "content-length": String(sizeBytes),
    "content-type": contentType,
    "if-none-match": "*",
    "x-amz-checksum-sha256": Buffer.from(artifactDigest, "hex").toString("base64"),
    "x-amz-meta-deviludo-sha256": artifactDigest,
  };
  validateGrant(grant, "PUT", now, allowedOrigins);
  if (!sameHeaders(grant.requiredHeaders, expectedHeaders)
    || !new URL(grant.url).pathname.endsWith(`/${objectKey}`)) invalid("upload grant");
}

function validateDownloadGrant(
  grant: RunnerArtifactTransferGrant,
  expiresAt: string,
  now: Date,
  allowedOrigins: ReadonlySet<string>,
): void {
  validateGrant(grant, "GET", now, allowedOrigins);
  if (grant.expiresAt !== expiresAt || Object.keys(grant.requiredHeaders).length !== 0) invalid("download grant");
}

function validateGrant(
  grant: RunnerArtifactTransferGrant,
  method: "GET" | "PUT",
  now: Date,
  allowedOrigins: ReadonlySet<string>,
): void {
  let url: URL;
  try { url = new URL(grant.url); }
  catch { invalid("transfer grant"); }
  const expiry = Date.parse(grant.expiresAt);
  if (grant.method !== method || url.protocol !== "https:" || url.username || url.password || url.hash
    || !allowedOrigins.has(url.origin) || !Number.isFinite(expiry) || expiry <= now.getTime()
    || expiry > now.getTime() + MAX_GRANT_MS) invalid("transfer grant");
}

async function privateRoot(value: string): Promise<string> {
  await mkdir(value, { recursive: true, mode: 0o700 });
  const path = await realpath(value);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("work root");
  if (process.platform !== "win32") await chmod(path, 0o700);
  return path;
}

function origins(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16 || new Set(values).size !== values.length) invalid("origins");
  const parsed = values.map((value) => {
    let url: URL;
    try { url = new URL(value); }
    catch { invalid("origin"); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "")) invalid("origin");
    return url.origin;
  }).sort();
  if (JSON.stringify(parsed) !== JSON.stringify(values)) invalid("origins");
  return new Set(parsed);
}

function sameHeaders(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
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

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid("clock");
  return value;
}

function absolute(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) invalid("path");
  return value;
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("duration");
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(label: string): never {
  throw new Error(`SCM source snapshot ${label} is invalid`);
}
