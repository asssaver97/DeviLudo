import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { sha256Canonical } from "../../runner-control/src/canonical";
import {
  directArtifactTransferHttps,
  testKitArtifactBrokerHttpsJson,
  type TestKitArtifactBrokerHttp,
  type TestKitArtifactBrokerTls,
  type TestKitArtifactTransferHttp,
} from "../../runner-control/src/testkit-artifact-client";
import type { PreparedInputObjectPort } from "./preparer";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;

export const REQUIRED_PREPARED_INPUT_ENV_NAMES = Object.freeze([
  "DEVILUDO_PREPARED_INPUT_BROKER_URL",
  "DEVILUDO_PREPARED_INPUT_TLS_KEY_FILE",
  "DEVILUDO_PREPARED_INPUT_TLS_CERT_FILE",
  "DEVILUDO_PREPARED_INPUT_CA_FILE",
  "DEVILUDO_PREPARED_INPUT_TRANSFER_CA_FILE",
  "DEVILUDO_PREPARED_INPUT_ALLOWED_TRANSFER_ORIGINS_JSON",
] as const);

export const OPTIONAL_PREPARED_INPUT_ENV_NAMES = Object.freeze([
  "DEVILUDO_PREPARED_INPUT_REQUEST_TIMEOUT_SECONDS",
  "DEVILUDO_PREPARED_INPUT_TRANSFER_TIMEOUT_SECONDS",
] as const);

type PublishInput = Parameters<PreparedInputObjectPort["publishFile"]>[0];

interface PreparedInputGrant {
  readonly bindingDigest: string;
  readonly objectKey: string;
  readonly method: "PUT";
  readonly url: URL;
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: string;
  readonly commitRequired: true;
}

/** mTLS client that streams prepared inputs only through Evidence Archive grants. */
export class MtlsPreparedInputObjectClient implements PreparedInputObjectPort {
  readonly #endpoint: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #transferCa: Buffer;
  readonly #allowedTransferOrigins: ReadonlySet<string>;
  readonly #requestTimeoutMs: number;
  readonly #transferTimeoutMs: number;
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
    readonly brokerHttp?: TestKitArtifactBrokerHttp;
    readonly transferHttp?: TestKitArtifactTransferHttp;
    readonly now?: () => Date;
  }) {
    this.#endpoint = strictOrigin(options.endpoint);
    validateTls(options.tls);
    if (!Buffer.isBuffer(options.transferCa) || options.transferCa.byteLength < 32 || options.transferCa.byteLength > 1024 * 1024) invalidConfig();
    this.#tls = Object.freeze({ ...options.tls });
    this.#transferCa = Buffer.from(options.transferCa);
    this.#allowedTransferOrigins = origins(options.allowedTransferOrigins);
    this.#requestTimeoutMs = integer(options.requestTimeoutMs ?? 30_000, 1_000, 600_000);
    this.#transferTimeoutMs = integer(options.transferTimeoutMs ?? 2 * 60 * 60_000, 1_000, 24 * 60 * 60_000);
    this.#brokerHttp = options.brokerHttp ?? testKitArtifactBrokerHttpsJson;
    this.#transferHttp = options.transferHttp ?? directArtifactTransferHttps;
    this.#now = options.now ?? (() => new Date());
  }

  async publishFile(input: PublishInput): Promise<Readonly<{ objectKey: string; artifactDigest: string; sizeBytes: number }>> {
    validateInput(input);
    const maximum = input.artifactKind === "source-bundle" ? MAX_SOURCE_BYTES : MAX_PLAN_BYTES;
    const before = await fileDigest(input.path, maximum);
    if (before.artifactDigest !== input.artifactDigest || before.sizeBytes !== input.sizeBytes) invalidResponse();
    const request = {
      schemaVersion: "deviludo.prepared-input-grant-request.v1",
      tenantId: input.tenantId,
      projectId: input.projectId,
      runId: input.runId,
      lockKey: input.lockKey,
      artifactKind: input.artifactKind,
      artifactDigest: input.artifactDigest,
      sizeBytes: input.sizeBytes,
    };
    const grant = parseGrant(await this.#post("/v1/prepared-input-grants", request), input, this.#now(), this.#allowedTransferOrigins);
    const uploaded = await this.#transferHttp.upload({
      url: grant.url,
      headers: grant.requiredHeaders,
      ca: this.#transferCa,
      sourcePath: input.path,
      sizeBytes: input.sizeBytes,
      timeoutMs: this.#transferTimeoutMs,
    });
    if (!((uploaded.statusCode >= 200 && uploaded.statusCode < 300) || uploaded.statusCode === 409 || uploaded.statusCode === 412)) {
      throw new Error("Prepared input upload was rejected");
    }
    const after = await fileDigest(input.path, maximum);
    if (after.artifactDigest !== before.artifactDigest || after.sizeBytes !== before.sizeBytes) {
      throw new Error("Prepared input file changed during upload");
    }
    const receipt = await this.#post("/v1/prepared-input-commits", {
      ...request,
      schemaVersion: "deviludo.prepared-input-commit-request.v1",
    });
    return parseReceipt(receipt, input, grant.bindingDigest);
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href);
    url.pathname = "/healthz";
    const response = await this.#brokerHttp({
      url,
      method: "GET",
      body: "",
      tls: this.#tls,
      timeoutMs: this.#requestTimeoutMs,
    });
    const body = record(response.payload);
    exactKeys(body, ["status", "service"]);
    if (response.statusCode !== 200 || body.status !== "ok" || body.service !== "deviludo-evidence-archive") {
      invalidResponse();
    }
  }

  async #post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const url = new URL(this.#endpoint.href);
    url.pathname = path;
    const response = await this.#brokerHttp({
      url,
      body: JSON.stringify(body),
      tls: this.#tls,
      timeoutMs: this.#requestTimeoutMs,
    });
    if (response.statusCode !== 200) throw new Error(`Prepared input Broker rejected the request with status ${response.statusCode}`);
    return response.payload;
  }
}

export async function preparedInputObjectClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsPreparedInputObjectClient> {
  const controlled = preparedInputProcessEnvironmentFromEnv(env);
  const [key, certificate, ca, transferCa] = await Promise.all([
    readRequiredFile(controlled.DEVILUDO_PREPARED_INPUT_TLS_KEY_FILE!),
    readRequiredFile(controlled.DEVILUDO_PREPARED_INPUT_TLS_CERT_FILE!),
    readRequiredFile(controlled.DEVILUDO_PREPARED_INPUT_CA_FILE!),
    readRequiredFile(controlled.DEVILUDO_PREPARED_INPUT_TRANSFER_CA_FILE!),
  ]);
  return new MtlsPreparedInputObjectClient({
    endpoint: controlled.DEVILUDO_PREPARED_INPUT_BROKER_URL!,
    tls: { key, certificate, ca },
    transferCa,
    allowedTransferOrigins: parseOrigins(controlled.DEVILUDO_PREPARED_INPUT_ALLOWED_TRANSFER_ORIGINS_JSON!),
    requestTimeoutMs: seconds(controlled.DEVILUDO_PREPARED_INPUT_REQUEST_TIMEOUT_SECONDS, 30, 1, 600) * 1_000,
    transferTimeoutMs: seconds(controlled.DEVILUDO_PREPARED_INPUT_TRANSFER_TIMEOUT_SECONDS, 7_200, 1, 86_400) * 1_000,
  });
}

/** Returns only the bounded transport configuration allowed into the service. */
export function preparedInputProcessEnvironmentFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {
    DEVILUDO_PREPARED_INPUT_BROKER_URL: strictOrigin(requiredEnv(env, "DEVILUDO_PREPARED_INPUT_BROKER_URL")).origin,
    DEVILUDO_PREPARED_INPUT_TLS_KEY_FILE: absolutePath(requiredEnv(env, "DEVILUDO_PREPARED_INPUT_TLS_KEY_FILE")),
    DEVILUDO_PREPARED_INPUT_TLS_CERT_FILE: absolutePath(requiredEnv(env, "DEVILUDO_PREPARED_INPUT_TLS_CERT_FILE")),
    DEVILUDO_PREPARED_INPUT_CA_FILE: absolutePath(requiredEnv(env, "DEVILUDO_PREPARED_INPUT_CA_FILE")),
    DEVILUDO_PREPARED_INPUT_TRANSFER_CA_FILE: absolutePath(requiredEnv(env, "DEVILUDO_PREPARED_INPUT_TRANSFER_CA_FILE")),
    DEVILUDO_PREPARED_INPUT_ALLOWED_TRANSFER_ORIGINS_JSON: JSON.stringify([
      ...origins(parseOrigins(requiredEnv(env, "DEVILUDO_PREPARED_INPUT_ALLOWED_TRANSFER_ORIGINS_JSON"))),
    ]),
  };
  if (env.DEVILUDO_PREPARED_INPUT_REQUEST_TIMEOUT_SECONDS !== undefined) {
    result.DEVILUDO_PREPARED_INPUT_REQUEST_TIMEOUT_SECONDS = String(seconds(
      env.DEVILUDO_PREPARED_INPUT_REQUEST_TIMEOUT_SECONDS, 30, 1, 600,
    ));
  }
  if (env.DEVILUDO_PREPARED_INPUT_TRANSFER_TIMEOUT_SECONDS !== undefined) {
    result.DEVILUDO_PREPARED_INPUT_TRANSFER_TIMEOUT_SECONDS = String(seconds(
      env.DEVILUDO_PREPARED_INPUT_TRANSFER_TIMEOUT_SECONDS, 7_200, 1, 86_400,
    ));
  }
  return Object.freeze(result);
}

function parseGrant(
  value: unknown,
  input: PublishInput,
  now: Date,
  allowedOrigins: ReadonlySet<string>,
): PreparedInputGrant {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "bindingDigest", "tenantId", "projectId", "runId", "lockKey", "artifactKind",
    "artifactDigest", "sizeBytes", "objectKey", "contentType", "method", "url", "requiredHeaders",
    "expiresAt", "commitRequired",
  ]);
  const expectedKey = objectKey(input);
  const core = {
    tenantId: input.tenantId,
    projectId: input.projectId,
    runId: input.runId,
    lockKey: input.lockKey,
    artifactKind: input.artifactKind,
    artifactDigest: input.artifactDigest,
    sizeBytes: input.sizeBytes,
    objectKey: expectedKey,
    contentType: input.contentType,
  };
  let url: URL;
  try { url = new URL(String(body.url)); }
  catch { invalidResponse(); }
  const headers = stringHeaders(body.requiredHeaders);
  const observed = now.getTime();
  const expiry = Date.parse(String(body.expiresAt));
  if (body.schemaVersion !== "deviludo.prepared-input-grant.v1"
    || body.bindingDigest !== sha256Canonical(core)
    || Object.entries(core).some(([key, expected]) => body[key] !== expected)
    || body.method !== "PUT" || body.commitRequired !== true
    || !Number.isFinite(observed) || !Number.isFinite(expiry) || expiry <= observed || expiry > observed + 5 * 60_000
    || !allowedOrigins.has(url.origin)
    || headers["content-length"] !== String(input.sizeBytes)
    || headers["content-type"] !== input.contentType
    || headers["if-none-match"] !== "*"
    || headers["x-amz-checksum-sha256"] !== Buffer.from(input.artifactDigest, "hex").toString("base64")
    || headers["x-amz-meta-deviludo-sha256"] !== input.artifactDigest) invalidResponse();
  exactHeaderNames(headers);
  return Object.freeze({
    bindingDigest: body.bindingDigest as string,
    objectKey: expectedKey,
    method: "PUT",
    url,
    requiredHeaders: headers,
    expiresAt: body.expiresAt as string,
    commitRequired: true,
  });
}

function parseReceipt(value: unknown, input: PublishInput, bindingDigest: string): Readonly<{
  objectKey: string;
  artifactDigest: string;
  sizeBytes: number;
}> {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "bindingDigest", "tenantId", "projectId", "runId", "lockKey", "artifactKind",
    "artifactDigest", "sizeBytes", "objectKey", "contentType", "verified",
  ]);
  const expectedKey = objectKey(input);
  if (body.schemaVersion !== "deviludo.prepared-input-commit-receipt.v1" || body.bindingDigest !== bindingDigest
    || body.tenantId !== input.tenantId || body.projectId !== input.projectId || body.runId !== input.runId
    || body.lockKey !== input.lockKey || body.artifactKind !== input.artifactKind
    || body.artifactDigest !== input.artifactDigest || body.sizeBytes !== input.sizeBytes
    || body.objectKey !== expectedKey || body.contentType !== input.contentType || body.verified !== true) invalidResponse();
  return Object.freeze({ objectKey: expectedKey, artifactDigest: input.artifactDigest, sizeBytes: input.sizeBytes });
}

function validateInput(input: PublishInput): void {
  if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.runId) || !SHA256.test(input.lockKey)
    || (input.artifactKind !== "source-bundle" && input.artifactKind !== "test-plan")
    || !SHA256.test(input.artifactDigest) || input.objectKey !== objectKey(input)
    || input.contentType !== (input.artifactKind === "source-bundle" ? "application/zstd" : "application/json")
    || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1
    || !isAbsolute(input.path) || resolve(input.path) !== input.path || /\0/.test(input.path)) invalidConfig();
}

function objectKey(input: Pick<PublishInput, "tenantId" | "projectId" | "artifactKind" | "artifactDigest">): string {
  return input.artifactKind === "source-bundle"
    ? `tenants/${input.tenantId}/projects/${input.projectId}/sources/${input.artifactDigest}.tar.zst`
    : `tenants/${input.tenantId}/projects/${input.projectId}/test-plans/${input.artifactDigest}.json`;
}

async function fileDigest(path: string, maximum: number): Promise<Readonly<{ artifactDigest: string; sizeBytes: number }>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum) invalidResponse();
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, metadata.size - position), position);
      if (bytesRead < 1) invalidResponse();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) invalidResponse();
    return Object.freeze({ artifactDigest: hash.digest("hex"), sizeBytes: metadata.size });
  } finally { await file.close(); }
}

function stringHeaders(value: unknown): Readonly<Record<string, string>> {
  const body = record(value);
  const headers: Record<string, string> = {};
  for (const [name, item] of Object.entries(body)) {
    if (name !== name.toLowerCase() || typeof item !== "string" || /\0|\r|\n/.test(item)) invalidResponse();
    headers[name] = item;
  }
  return Object.freeze(headers);
}

function exactHeaderNames(value: Readonly<Record<string, string>>): void {
  const expected = [
    "content-length", "content-type", "if-none-match", "x-amz-checksum-sha256", "x-amz-meta-deviludo-sha256",
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) invalidResponse();
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
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) invalidConfig();
    const value = await file.readFile();
    if (value.byteLength < 32 || value.byteLength > 1024 * 1024) invalidConfig();
    return value;
  } finally { await file.close(); }
}

function absolutePath(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) invalidConfig();
  return value;
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

function validateTls(value: TestKitArtifactBrokerTls): void {
  if (!Buffer.isBuffer(value.key) || !Buffer.isBuffer(value.certificate) || !Buffer.isBuffer(value.ca)
    || value.key.byteLength < 32 || value.certificate.byteLength < 32 || value.ca.byteLength < 32) invalidConfig();
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

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalidConfig();
  return value;
}

function invalidConfig(): never { throw new Error("Prepared input client configuration is invalid"); }
function invalidResponse(): never { throw new Error("Prepared input Broker response is invalid"); }
