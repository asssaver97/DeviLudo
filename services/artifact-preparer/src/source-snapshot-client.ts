import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { extractSourceBundle } from "../../godot-testkit/src/source-bundle";
import { sha256Canonical } from "../../runner-control/src/canonical";
import {
  directArtifactTransferHttps,
  testKitArtifactBrokerHttpsJson,
  type TestKitArtifactBrokerHttp,
  type TestKitArtifactBrokerTls,
  type TestKitArtifactTransferHttp,
} from "../../runner-control/src/testkit-artifact-client";
import type { AuthoritativeSourceSnapshotPort } from "./preparer";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_GRANT_MS = 5 * 60_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024;

export type SourceSnapshotMaterializationInput = Omit<Parameters<AuthoritativeSourceSnapshotPort["materialize"]>[0], "mode">
  & Readonly<{ mode: "AGENT_BASELINE" | "CANDIDATE" | "MAIN_RELEASE_GATE" }>;
type MaterializeInput = SourceSnapshotMaterializationInput;

export const REQUIRED_SOURCE_SNAPSHOT_ENV_NAMES = Object.freeze([
  "DEVILUDO_SOURCE_SNAPSHOT_BROKER_URL",
  "DEVILUDO_SOURCE_SNAPSHOT_TLS_KEY_FILE",
  "DEVILUDO_SOURCE_SNAPSHOT_TLS_CERT_FILE",
  "DEVILUDO_SOURCE_SNAPSHOT_CA_FILE",
  "DEVILUDO_SOURCE_SNAPSHOT_TRANSFER_CA_FILE",
  "DEVILUDO_SOURCE_SNAPSHOT_ALLOWED_TRANSFER_ORIGINS_JSON",
] as const);

/** Downloads only the authoritative commit/source tuple granted by the SCM Broker. */
export class MtlsAuthoritativeSourceSnapshotClient implements AuthoritativeSourceSnapshotPort {
  readonly #endpoint: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #transferCa: Buffer;
  readonly #allowedTransferOrigins: ReadonlySet<string>;
  readonly #requestTimeoutMs: number;
  readonly #transferTimeoutMs: number;
  readonly #maxBytes: number;
  readonly #brokerHttp: TestKitArtifactBrokerHttp;
  readonly #transferHttp: TestKitArtifactTransferHttp;
  readonly #now: () => Date;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: TestKitArtifactBrokerTls;
    readonly transferCa: Buffer;
    readonly allowedTransferOrigins: readonly string[];
    readonly requestTimeoutMs?: number;
    readonly transferTimeoutMs?: number;
    readonly maxBytes?: number;
    readonly brokerHttp?: TestKitArtifactBrokerHttp;
    readonly transferHttp?: TestKitArtifactTransferHttp;
    readonly now?: () => Date;
  }) {
    this.#endpoint = strictOrigin(options.endpoint);
    validateTls(options.tls);
    if (!Buffer.isBuffer(options.transferCa) || options.transferCa.byteLength < 32
      || options.transferCa.byteLength > 1024 * 1024) invalidConfig();
    this.#tls = Object.freeze({ ...options.tls });
    this.#transferCa = Buffer.from(options.transferCa);
    this.#allowedTransferOrigins = origins(options.allowedTransferOrigins);
    this.#requestTimeoutMs = integer(options.requestTimeoutMs ?? 600_000, 1_000, 600_000);
    this.#transferTimeoutMs = integer(options.transferTimeoutMs ?? 2 * 60 * 60_000, 1_000, 24 * 60 * 60_000);
    this.#maxBytes = integer(options.maxBytes ?? DEFAULT_MAX_BYTES, 1, 64 * 1024 * 1024 * 1024);
    this.#brokerHttp = options.brokerHttp ?? testKitArtifactBrokerHttpsJson;
    this.#transferHttp = options.transferHttp ?? directArtifactTransferHttps;
    this.#now = options.now ?? (() => new Date());
  }

  async materialize(input: MaterializeInput): Promise<Readonly<{ sourceDigest: string }>> {
    validateInput(input);
    const destination = input.destinationPath;
    await requireAbsent(destination);
    const parent = dirname(destination);
    if (await realpath(parent) !== parent || !(await lstat(parent)).isDirectory()) invalidConfig();
    const request = Object.freeze({
      schemaVersion: "deviludo.source-snapshot-grant-request.v1",
      tenantId: input.tenantId,
      projectId: input.projectId,
      runId: input.runId,
      mode: input.mode,
      commitSha: input.commitSha,
      sourceDigest: input.expectedSourceDigest,
    });
    const response = await this.#post(request);
    const grant = parseGrant(response, input, this.#now(), this.#allowedTransferOrigins, this.#maxBytes);
    const archive = join(parent, `.scm-snapshot-${grant.artifactDigest}-${randomUUID()}.tar.zst`);
    try {
      const transferred = await this.#transferHttp.download({
        url: grant.url,
        headers: grant.requiredHeaders,
        ca: this.#transferCa,
        destinationPath: archive,
        maxBytes: this.#maxBytes,
        timeoutMs: this.#transferTimeoutMs,
      });
      if (transferred.statusCode !== 200 || transferred.artifactDigest !== grant.artifactDigest
        || transferred.sizeBytes !== grant.sizeBytes) invalidResponse();
      await extractSourceBundle(archive, destination);
      return Object.freeze({ sourceDigest: input.expectedSourceDigest });
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally { await unlink(archive).catch(() => undefined); }
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href); url.pathname = "/healthz";
    const response = await this.#brokerHttp({ url, method: "GET", body: "", tls: this.#tls,
      timeoutMs: this.#requestTimeoutMs });
    const body = record(response.payload);
    if (response.statusCode !== 200 || body.status !== "ok" || body.service !== "deviludo-source-snapshot") invalidResponse();
  }

  async #post(body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const url = new URL(this.#endpoint.href);
    url.pathname = "/v1/source-snapshot-grants";
    const response = await this.#brokerHttp({
      url,
      body: JSON.stringify(body),
      tls: this.#tls,
      timeoutMs: this.#requestTimeoutMs,
    });
    if (response.statusCode !== 200) throw new Error(`Source snapshot Broker rejected the request with status ${response.statusCode}`);
    return response.payload;
  }
}

export async function sourceSnapshotClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsAuthoritativeSourceSnapshotClient> {
  const [key, certificate, ca, transferCa] = await Promise.all([
    readRequiredFile(requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_TLS_KEY_FILE")),
    readRequiredFile(requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_TLS_CERT_FILE")),
    readRequiredFile(requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_CA_FILE")),
    readRequiredFile(requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_TRANSFER_CA_FILE")),
  ]);
  return new MtlsAuthoritativeSourceSnapshotClient({
    endpoint: requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_BROKER_URL"),
    tls: { key, certificate, ca },
    transferCa,
    allowedTransferOrigins: parseOrigins(requiredEnv(env, "DEVILUDO_SOURCE_SNAPSHOT_ALLOWED_TRANSFER_ORIGINS_JSON")),
    requestTimeoutMs: seconds(env.DEVILUDO_SOURCE_SNAPSHOT_REQUEST_TIMEOUT_SECONDS, 600, 1, 600) * 1_000,
    transferTimeoutMs: seconds(env.DEVILUDO_SOURCE_SNAPSHOT_TRANSFER_TIMEOUT_SECONDS, 7_200, 1, 86_400) * 1_000,
    maxBytes: integerString(env.DEVILUDO_SOURCE_SNAPSHOT_MAX_BYTES, DEFAULT_MAX_BYTES, 1, 64 * 1024 * 1024 * 1024),
  });
}

function parseGrant(
  value: unknown,
  input: MaterializeInput,
  now: Date,
  allowedOrigins: ReadonlySet<string>,
  maxBytes: number,
): Readonly<{
  artifactDigest: string;
  sizeBytes: number;
  url: URL;
  requiredHeaders: Readonly<Record<string, string>>;
}> {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "bindingDigest", "tenantId", "projectId", "runId", "mode", "commitSha", "sourceDigest",
    "artifactDigest", "sizeBytes", "objectKey", "contentType", "method", "url", "requiredHeaders", "expiresAt",
  ]);
  if (!SHA256.test(String(body.artifactDigest ?? "")) || !Number.isSafeInteger(body.sizeBytes)
    || (body.sizeBytes as number) < 16 || (body.sizeBytes as number) > maxBytes) invalidResponse();
  const artifactDigest = body.artifactDigest as string;
  const sizeBytes = body.sizeBytes as number;
  const objectKey = snapshotObjectKey(input, artifactDigest);
  const core = {
    tenantId: input.tenantId,
    projectId: input.projectId,
    runId: input.runId,
    mode: input.mode,
    commitSha: input.commitSha,
    sourceDigest: input.expectedSourceDigest,
    artifactDigest,
    sizeBytes,
    objectKey,
    contentType: "application/zstd",
  };
  let url: URL;
  try { url = new URL(String(body.url)); }
  catch { invalidResponse(); }
  const observed = now.getTime();
  const expiry = Date.parse(String(body.expiresAt));
  const headers = stringHeaders(body.requiredHeaders);
  if (body.schemaVersion !== "deviludo.source-snapshot-grant.v1" || body.bindingDigest !== sha256Canonical(core)
    || Object.entries(core).some(([name, expected]) => body[name] !== expected)
    || body.method !== "GET" || !Number.isFinite(observed) || !Number.isFinite(expiry)
    || expiry <= observed || expiry > observed + MAX_GRANT_MS || !allowedOrigins.has(url.origin)
    || Object.keys(headers).length !== 0) invalidResponse();
  return Object.freeze({ artifactDigest, sizeBytes, url, requiredHeaders: headers });
}

function snapshotObjectKey(input: MaterializeInput, artifactDigest: string): string {
  return `tenants/${input.tenantId}/projects/${input.projectId}/scm-snapshots/${input.commitSha}/${input.expectedSourceDigest}/${artifactDigest}.tar.zst`;
}

function validateInput(input: MaterializeInput): void {
  if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.runId)
    || (input.mode !== "AGENT_BASELINE" && input.mode !== "CANDIDATE" && input.mode !== "MAIN_RELEASE_GATE")
    || !SHA1.test(input.commitSha) || !SHA256.test(input.expectedSourceDigest)
    || !isAbsolute(input.destinationPath) || resolve(input.destinationPath) !== input.destinationPath
    || input.destinationPath.length > 4_096 || /\0/.test(input.destinationPath)) invalidConfig();
}

async function requireAbsent(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  invalidConfig();
}

function stringHeaders(value: unknown): Readonly<Record<string, string>> {
  const body = record(value);
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(body)) {
    if (name !== name.toLowerCase() || typeof item !== "string" || /\0|\r|\n/.test(item)) invalidResponse();
    result[name] = item;
  }
  return Object.freeze(result);
}

function strictOrigin(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { invalidConfig(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) invalidConfig();
  return url;
}

function origins(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16 || new Set(values).size !== values.length) invalidConfig();
  const parsed = values.map((value) => strictOrigin(value).origin).sort();
  if (JSON.stringify(parsed) !== JSON.stringify(values)) invalidConfig();
  return new Set(parsed);
}

function parseOrigins(value: string): readonly string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { invalidConfig(); }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) invalidConfig();
  return parsed as readonly string[];
}

async function readRequiredFile(path: string): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) invalidConfig();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) invalidConfig();
    return await file.readFile();
  } finally { await file.close(); }
}

function validateTls(tls: TestKitArtifactBrokerTls): void {
  if (!Buffer.isBuffer(tls.key) || !Buffer.isBuffer(tls.certificate) || !Buffer.isBuffer(tls.ca)
    || tls.key.byteLength < 32 || tls.certificate.byteLength < 32 || tls.ca.byteLength < 32) invalidConfig();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalidResponse();
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) invalidConfig();
  return value;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) invalidConfig();
  return parsed;
}

function integerString(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) invalidConfig();
  return parsed;
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalidConfig();
  return value;
}

function invalidConfig(): never { throw new Error("Source snapshot client configuration is invalid"); }
function invalidResponse(): never { throw new Error("Source snapshot Broker response is invalid"); }
