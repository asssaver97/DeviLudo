import { createHash, createHmac } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ImmutableObjectPut, ImmutableObjectStore } from "./contracts";
import type { RunnerArtifactTransfer, RunnerArtifactTransferGrant } from "./runner-artifacts";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

export interface S3HttpRequest {
  readonly method: "GET" | "HEAD" | "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer;
  readonly ca: Buffer;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface S3HttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Buffer;
}

export type S3Http = (url: URL, input: S3HttpRequest) => Promise<S3HttpResponse>;

/** Exact, path-style S3 client that never overwrites a content-addressed key. */
export class S3ImmutableObjectStore implements ImmutableObjectStore, RunnerArtifactTransfer {
  readonly #endpoint: URL;
  readonly #bucket: string;
  readonly #region: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: Buffer;
  readonly #ca: Buffer;
  readonly #timeoutMs: number;
  readonly #http: S3Http;
  readonly #now: () => Date;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly bucket: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: Buffer;
    readonly ca: Buffer;
    readonly timeoutMs?: number;
    readonly http?: S3Http;
    readonly now?: () => Date;
  }) {
    this.#endpoint = strictEndpoint(options.endpoint);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) || options.bucket.includes("..")) invalidConfig();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(options.region)) invalidConfig();
    if (!/^[A-Za-z0-9][A-Za-z0-9+/=_-]{7,127}$/.test(options.accessKeyId)
      || !Buffer.isBuffer(options.secretAccessKey) || options.secretAccessKey.byteLength < 16 || options.secretAccessKey.byteLength > 256
      || !Buffer.isBuffer(options.ca) || options.ca.byteLength < 32 || options.ca.byteLength > 1024 * 1024) invalidConfig();
    this.#bucket = options.bucket;
    this.#region = options.region;
    this.#accessKeyId = options.accessKeyId;
    this.#secretAccessKey = Buffer.from(options.secretAccessKey);
    this.#ca = Buffer.from(options.ca);
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 600_000);
    this.#http = options.http ?? s3HttpsRequest;
    this.#now = options.now ?? (() => new Date());
  }

  async putImmutable(input: ImmutableObjectPut): Promise<Readonly<{ created: boolean }>> {
    validatePut(input);
    const url = this.#objectUrl(input.objectKey);
    const response = await this.#signedRequest(url, "PUT", input.contentDigest, {
      "content-length": String(input.body.byteLength),
      "content-type": input.contentType,
      "if-none-match": "*",
      "x-amz-meta-deviludo-sha256": input.contentDigest,
    }, input.body);
    if (response.statusCode >= 200 && response.statusCode < 300) return Object.freeze({ created: true });
    if (response.statusCode !== 409 && response.statusCode !== 412) {
      throw new Error(`Evidence archive S3 PUT failed with status ${response.statusCode}`);
    }
    const existing = await this.#signedRequest(url, "GET", EMPTY_SHA256, {}, undefined);
    const digest = single(existing.headers["x-amz-meta-deviludo-sha256"]);
    const length = Number(single(existing.headers["content-length"]));
    const observed = createHash("sha256").update(existing.body).digest("hex");
    if (existing.statusCode !== 200 || digest !== input.contentDigest || length !== input.body.byteLength
      || existing.body.byteLength !== input.body.byteLength || observed !== input.contentDigest) {
      throw new Error("Evidence archive S3 key conflicts with stored content");
    }
    return Object.freeze({ created: false });
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href);
    url.pathname = `/${encodeSegment(this.#bucket)}`;
    const response = await this.#signedRequest(url, "HEAD", EMPTY_SHA256, {}, undefined);
    if (response.statusCode !== 200) throw new Error("Evidence archive S3 readiness probe failed");
  }

  async createDownloadGrant(input: {
    readonly objectKey: string;
    readonly artifactDigest: string;
    readonly expiresAt: string;
  }): Promise<RunnerArtifactTransferGrant> {
    validateTransferInput(input.objectKey, input.artifactDigest);
    return this.#presign(this.#objectUrl(input.objectKey), "GET", {}, input.expiresAt);
  }

  async createUploadGrant(input: {
    readonly objectKey: string;
    readonly artifactDigest: string;
    readonly sizeBytes: number;
    readonly contentType: string;
    readonly expiresAt: string;
  }): Promise<RunnerArtifactTransferGrant> {
    validateTransferInput(input.objectKey, input.artifactDigest);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 8 * 1024 * 1024 * 1024
      || !/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(input.contentType)) invalidConfig();
    return this.#presign(this.#objectUrl(input.objectKey), "PUT", {
      "content-length": String(input.sizeBytes),
      "content-type": input.contentType,
      "if-none-match": "*",
      "x-amz-checksum-sha256": Buffer.from(input.artifactDigest, "hex").toString("base64"),
      "x-amz-meta-deviludo-sha256": input.artifactDigest,
    }, input.expiresAt);
  }

  async verifyObject(input: {
    readonly objectKey: string;
    readonly artifactDigest: string;
    readonly sizeBytes?: number;
  }): Promise<Readonly<{ sizeBytes: number }>> {
    validateTransferInput(input.objectKey, input.artifactDigest);
    if (input.sizeBytes !== undefined && (!Number.isSafeInteger(input.sizeBytes)
      || input.sizeBytes < 1 || input.sizeBytes > 8 * 1024 * 1024 * 1024)) invalidConfig();
    const response = await this.#signedRequest(
      this.#objectUrl(input.objectKey),
      "HEAD",
      EMPTY_SHA256,
      { "x-amz-checksum-mode": "ENABLED" },
      undefined,
    );
    const sizeBytes = Number(single(response.headers["content-length"]));
    const metadataDigest = single(response.headers["x-amz-meta-deviludo-sha256"]);
    const checksum = single(response.headers["x-amz-checksum-sha256"]);
    const expectedChecksum = Buffer.from(input.artifactDigest, "hex").toString("base64");
    if (response.statusCode !== 200 || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1
      || (input.sizeBytes !== undefined && sizeBytes !== input.sizeBytes)
      || metadataDigest !== input.artifactDigest || checksum !== expectedChecksum) {
      throw new Error("Evidence archive S3 artifact verification failed");
    }
    return Object.freeze({ sizeBytes });
  }

  #objectUrl(key: string): URL {
    const url = new URL(this.#endpoint.href);
    url.pathname = `/${encodeSegment(this.#bucket)}/${key.split("/").map(encodeSegment).join("/")}`;
    return url;
  }

  #presign(
    url: URL,
    method: "GET" | "PUT",
    requiredHeaders: Readonly<Record<string, string>>,
    expiresAt: string,
  ): RunnerArtifactTransferGrant {
    const now = this.#now();
    const expiry = Date.parse(expiresAt);
    const expiresSeconds = Math.floor((expiry - now.getTime()) / 1_000);
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(expiry)
      || expiresSeconds < 1 || expiresSeconds > 300) invalidConfig();
    const amzDate = awsTimestamp(now);
    const date = amzDate.slice(0, 8);
    const headers: Record<string, string> = { host: url.host, ...requiredHeaders };
    const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = names.map((name) => `${name}:${normalizeHeader(headers[name] ?? "")}\n`).join("");
    const signedHeaders = names.join(";");
    const scope = `${date}/${this.#region}/s3/aws4_request`;
    const parameters: Readonly<Record<string, string>> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.#accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": signedHeaders,
    };
    const canonicalQuery = canonicalQueryString(parameters);
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = createHmac("sha256", signingKey(this.#secretAccessKey, date, this.#region))
      .update(stringToSign)
      .digest("hex");
    url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
    return Object.freeze({
      url: url.href,
      method,
      requiredHeaders: Object.freeze({ ...requiredHeaders }),
      expiresAt,
    });
  }

  async #signedRequest(
    url: URL,
    method: "GET" | "HEAD" | "PUT",
    payloadHash: string,
    extraHeaders: Readonly<Record<string, string>>,
    body: Buffer | undefined,
  ): Promise<S3HttpResponse> {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new Error("Evidence archive S3 clock is invalid");
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
    const canonicalRequest = [
      method,
      url.pathname,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${date}/${this.#region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = createHmac("sha256", signingKey(this.#secretAccessKey, date, this.#region))
      .update(stringToSign)
      .digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return this.#http(url, {
      method,
      headers: Object.freeze(headers),
      ...(body ? { body } : {}),
      ca: this.#ca,
      timeoutMs: this.#timeoutMs,
      maxResponseBytes: method === "GET" ? 4 * 1024 * 1024 : MAX_RESPONSE_BYTES,
    });
  }
}

export function s3HttpsRequest(url: URL, input: S3HttpRequest): Promise<S3HttpResponse> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method: input.method,
      headers: input.headers,
      ca: input.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: url.hostname,
    };
    const request = httpsRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > input.maxResponseBytes) {
          response.destroy(new Error("Evidence archive S3 response exceeded the limit"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => resolve(Object.freeze({
        statusCode: response.statusCode ?? 503,
        headers: Object.freeze({ ...response.headers }),
        body: Buffer.concat(chunks),
      })));
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Evidence archive S3 request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function signingKey(secret: Buffer, date: string, region: string): Buffer {
  const dateKey = createHmac("sha256", Buffer.concat([Buffer.from("AWS4"), secret])).update(date).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

function awsTimestamp(value: Date): string {
  return value.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQueryString(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([name, value]) => [encodeSegment(name), encodeSegment(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function strictEndpoint(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) invalidConfig();
  return url;
}

function validatePut(input: ImmutableObjectPut): void {
  const parts = input.objectKey.split("/");
  const observed = createHash("sha256").update(input.body).digest("hex");
  if (input.contentType !== "application/json" || !SHA256.test(input.contentDigest) || observed !== input.contentDigest
    || input.body.byteLength < 2 || input.body.byteLength > 4 * 1024 * 1024
    || input.objectKey.length < 3 || input.objectKey.length > 1_024
    || parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._:-]+$/.test(part))) {
    throw new Error("Evidence archive S3 object is invalid");
  }
}

function validateTransferInput(objectKey: string, artifactDigest: string): void {
  const parts = objectKey.split("/");
  if (!SHA256.test(artifactDigest) || objectKey.length < 3 || objectKey.length > 1_024
    || parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._:-]+$/.test(part))) {
    throw new Error("Evidence archive S3 transfer input is invalid");
  }
}

function single(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalidConfig();
  return value;
}

function invalidConfig(): never {
  throw new Error("Evidence archive S3 configuration is invalid");
}
