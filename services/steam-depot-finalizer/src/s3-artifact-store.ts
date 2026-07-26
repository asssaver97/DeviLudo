import { createHash, createHmac } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { SteamDepotArtifactStore } from "./native-controller";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

export interface SteamDepotS3HttpRequest {
  readonly method: "GET" | "HEAD" | "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer;
  readonly ca: Buffer;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface SteamDepotS3HttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Buffer;
}

export type SteamDepotS3Http = (
  url: URL,
  input: SteamDepotS3HttpRequest,
) => Promise<SteamDepotS3HttpResponse>;

/** Dedicated S3 boundary for source exports and finalized, content-addressed depots. */
export class S3SteamDepotArtifactStore implements SteamDepotArtifactStore {
  readonly #endpoint: URL;
  readonly #bucket: string;
  readonly #region: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: Buffer;
  readonly #ca: Buffer;
  readonly #timeoutMs: number;
  readonly #http: SteamDepotS3Http;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    endpoint: string | URL;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: Buffer;
    ca: Buffer;
    timeoutMs?: number;
    http?: SteamDepotS3Http;
    now?: () => Date;
  }>) {
    this.#endpoint = strictEndpoint(options.endpoint);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) || options.bucket.includes("..")
      || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(options.region)
      || !/^[A-Za-z0-9][A-Za-z0-9+/=_-]{7,127}$/.test(options.accessKeyId)
      || !Buffer.isBuffer(options.secretAccessKey) || options.secretAccessKey.byteLength < 16
      || options.secretAccessKey.byteLength > 256 || !Buffer.isBuffer(options.ca)
      || options.ca.byteLength < 32 || options.ca.byteLength > 1024 * 1024) invalid("configuration");
    this.#bucket = options.bucket;
    this.#region = options.region;
    this.#accessKeyId = options.accessKeyId;
    this.#secretAccessKey = Buffer.from(options.secretAccessKey);
    this.#ca = Buffer.from(options.ca);
    this.#timeoutMs = integer(options.timeoutMs ?? 60_000, 1_000, 10 * 60_000);
    this.#http = options.http ?? steamDepotS3HttpsRequest;
    this.#now = options.now ?? (() => new Date());
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href);
    url.pathname = `/${encodeSegment(this.#bucket)}`;
    const response = await this.#signedRequest(url, "HEAD", EMPTY_SHA256, {}, undefined, MAX_CONTROL_RESPONSE_BYTES);
    if (response.statusCode !== 200 || response.body.byteLength !== 0) invalid("readiness");
  }

  async download(input: Readonly<{
    objectKey: string;
    artifactDigest: string;
    maximumBytes: number;
  }>): Promise<Buffer> {
    validateIdentity(input.objectKey, input.artifactDigest);
    const maximumBytes = integer(input.maximumBytes, 1, MAX_ARTIFACT_BYTES);
    const response = await this.#signedRequest(
      this.#objectUrl(input.objectKey), "GET", EMPTY_SHA256,
      { "x-amz-checksum-mode": "ENABLED" }, undefined, maximumBytes,
    );
    verifyDownloaded(response, input.artifactDigest, maximumBytes);
    return Buffer.from(response.body);
  }

  async putImmutable(input: Readonly<{
    objectKey: string;
    artifactDigest: string;
    contentType: "application/json" | "application/octet-stream";
    body: Buffer;
  }>): Promise<void> {
    validateIdentity(input.objectKey, input.artifactDigest);
    if (!Buffer.isBuffer(input.body) || input.body.byteLength < (input.contentType === "application/json" ? 2 : 1)
      || input.body.byteLength > MAX_ARTIFACT_BYTES || digest(input.body) !== input.artifactDigest) invalid("put");
    const checksum = Buffer.from(input.artifactDigest, "hex").toString("base64");
    const url = this.#objectUrl(input.objectKey);
    const response = await this.#signedRequest(url, "PUT", input.artifactDigest, {
      "content-length": String(input.body.byteLength),
      "content-type": input.contentType,
      "if-none-match": "*",
      "x-amz-checksum-sha256": checksum,
      "x-amz-meta-deviludo-sha256": input.artifactDigest,
    }, input.body, MAX_CONTROL_RESPONSE_BYTES);
    if (response.statusCode >= 200 && response.statusCode < 300 && response.body.byteLength === 0) return;
    if (response.statusCode !== 409 && response.statusCode !== 412) invalid("put response");
    const existing = await this.#signedRequest(
      url, "GET", EMPTY_SHA256, { "x-amz-checksum-mode": "ENABLED" }, undefined, input.body.byteLength,
    );
    verifyDownloaded(existing, input.artifactDigest, input.body.byteLength);
    if (!existing.body.equals(input.body)) invalid("immutable conflict");
  }

  #objectUrl(objectKey: string): URL {
    const url = new URL(this.#endpoint.href);
    url.pathname = `/${encodeSegment(this.#bucket)}/${objectKey.split("/").map(encodeSegment).join("/")}`;
    return url;
  }

  async #signedRequest(
    url: URL,
    method: "GET" | "HEAD" | "PUT",
    payloadHash: string,
    extraHeaders: Readonly<Record<string, string>>,
    body: Buffer | undefined,
    maxResponseBytes: number,
  ): Promise<SteamDepotS3HttpResponse> {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) invalid("clock");
    const amzDate = awsTimestamp(now);
    const date = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host: url.host,
      ...extraHeaders,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = names.map((name) => `${name}:${normalizeHeader(headers[name] ?? "")}\n`).join("");
    const signedHeaders = names.join(";");
    const canonicalRequest = [method, url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${this.#region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${digest(Buffer.from(canonicalRequest))}`;
    const signature = createHmac("sha256", signingKey(this.#secretAccessKey, date, this.#region))
      .update(stringToSign).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return this.#http(url, Object.freeze({
      method,
      headers: Object.freeze(headers),
      ...(body ? { body } : {}),
      ca: this.#ca,
      timeoutMs: this.#timeoutMs,
      maxResponseBytes,
    }));
  }
}

export function steamDepotS3HttpsRequest(
  url: URL,
  input: SteamDepotS3HttpRequest,
): Promise<SteamDepotS3HttpResponse> {
  return new Promise((accept, reject) => {
    const options: RequestOptions = {
      method: input.method,
      headers: input.headers,
      ca: input.ca,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      servername: url.hostname,
    };
    const request = httpsRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > input.maxResponseBytes) {
          response.destroy(new Error("Steam depot S3 response exceeded the limit"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => accept(Object.freeze({
        statusCode: response.statusCode ?? 503,
        headers: Object.freeze({ ...response.headers }),
        body: Buffer.concat(chunks),
      })));
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Steam depot S3 request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function verifyDownloaded(response: SteamDepotS3HttpResponse, expectedDigest: string, maximumBytes: number): void {
  const length = Number(single(response.headers["content-length"]));
  const metadataDigest = single(response.headers["x-amz-meta-deviludo-sha256"]);
  const checksum = single(response.headers["x-amz-checksum-sha256"]);
  if (response.statusCode !== 200 || !Number.isSafeInteger(length) || length < 1 || length > maximumBytes
    || response.body.byteLength !== length || metadataDigest !== expectedDigest
    || checksum !== Buffer.from(expectedDigest, "hex").toString("base64")
    || digest(response.body) !== expectedDigest) invalid("download");
}

function signingKey(secret: Buffer, date: string, region: string): Buffer {
  const dateKey = createHmac("sha256", Buffer.concat([Buffer.from("AWS4"), secret])).update(date).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

function strictEndpoint(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); } catch { invalid("configuration"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || !new Set(["", "443", "8443", "9000"]).has(url.port)) invalid("configuration");
  return url;
}

function validateIdentity(objectKey: string, artifactDigest: string): void {
  const parts = objectKey.split("/");
  if (!SHA256.test(artifactDigest) || objectKey.length < 3 || objectKey.length > 1_024
    || parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._:-]+$/.test(part))) {
    invalid("object identity");
  }
}

function awsTimestamp(value: Date): string { return value.toISOString().replace(/[:-]|\.\d{3}/g, ""); }
function normalizeHeader(value: string): string { return value.trim().replace(/\s+/g, " "); }
function encodeSegment(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function single(value: string | readonly string[] | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("integer");
  return value;
}
function invalid(label: string): never { throw new Error(`Steam depot S3 ${label} is invalid`); }
