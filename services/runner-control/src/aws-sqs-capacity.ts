import { createHash, createHmac } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { FleetCapacityIntent, MacCapacityPublisher } from "./capacity-controller";

type AwsCredentials = Readonly<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}>;

export class AwsSqsFifoCapacityPublisher implements MacCapacityPublisher {
  readonly #queueUrl: URL;
  readonly #region: string;
  readonly #credentialsFile: string;
  readonly #fetch: typeof fetch;

  constructor(options: Readonly<{ queueUrl: string; region: string; credentialsFile: string; fetch?: typeof fetch }>) {
    this.#queueUrl = strictQueueUrl(options.queueUrl, options.region);
    this.#region = options.region;
    if (!options.credentialsFile.startsWith("/") || /[\0\r\n]/.test(options.credentialsFile)) throw new Error("AWS credential file path is invalid");
    this.#credentialsFile = options.credentialsFile;
    this.#fetch = options.fetch ?? fetch;
  }

  async publish(intent: FleetCapacityIntent): Promise<Readonly<Record<string, unknown>>> {
    if (intent.fleet !== "MACOS") throw new Error("AWS Mac publisher accepts only MACOS capacity intents");
    const credentials = await readShortLivedCredentials(this.#credentialsFile);
    const body = JSON.stringify({
      QueueUrl: this.#queueUrl.href,
      MessageBody: JSON.stringify({
        schemaVersion: "deviludo.macos-capacity-intent.v1",
        intentId: intent.id,
        operationKey: intent.operationKey,
        desiredHosts: intent.desiredHosts,
        requestedAt: intent.requestedAt,
        minimumReleaseAt: intent.minimumReleaseAt,
      }),
      MessageGroupId: "deviludo-macos-capacity",
      MessageDeduplicationId: intent.operationKey,
    });
    const headers = signAwsJsonRequest({
      method: "POST", url: new URL(`https://sqs.${this.#region}.amazonaws.com/`), region: this.#region,
      service: "sqs", body, credentials, at: new Date(), target: "AmazonSQS.SendMessage",
    });
    const response = await this.#fetch(`https://sqs.${this.#region}.amazonaws.com/`, {
      method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.redirected) throw new Error("AWS Mac capacity request was rejected");
    const receipt = await response.json() as { MessageId?: unknown; SequenceNumber?: unknown };
    if (typeof receipt.MessageId !== "string" || typeof receipt.SequenceNumber !== "string") {
      throw new Error("AWS Mac capacity receipt is invalid");
    }
    return Object.freeze({ provider: "AWS", messageId: receipt.MessageId, sequenceNumber: receipt.SequenceNumber });
  }
}

export function signAwsJsonRequest(input: Readonly<{
  method: "POST";
  url: URL;
  region: string;
  service: string;
  body: string;
  credentials: AwsCredentials;
  at: Date;
  target: string;
}>): Readonly<Record<string, string>> {
  if (!Number.isFinite(input.at.valueOf()) || input.url.protocol !== "https:" || input.url.username || input.url.password) {
    throw new Error("AWS request binding is invalid");
  }
  const amzDate = input.at.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = hash(input.body);
  const canonicalHeaders = `content-type:application/x-amz-json-1.0\nhost:${input.url.host}\nx-amz-date:${amzDate}\nx-amz-security-token:${input.credentials.sessionToken}\nx-amz-target:${input.target}\n`;
  const signedHeaders = "content-type;host;x-amz-date;x-amz-security-token;x-amz-target";
  const canonicalRequest = `${input.method}\n${input.url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hash(canonicalRequest)}`;
  const dateKey = hmac(`AWS4${input.credentials.secretAccessKey}`, date);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, input.service);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  return Object.freeze({
    "content-type": "application/x-amz-json-1.0",
    "x-amz-date": amzDate,
    "x-amz-security-token": input.credentials.sessionToken,
    "x-amz-target": input.target,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  });
}

export async function readShortLivedCredentials(path: string): Promise<AwsCredentials> {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 64 || stat.size > 16 * 1024) {
    throw new Error("AWS credential file permissions are invalid");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const accessKeyId = String(value.AccessKeyId ?? "");
  const secretAccessKey = String(value.SecretAccessKey ?? "");
  const sessionToken = String(value.SessionToken ?? "");
  const expiration = String(value.Expiration ?? "");
  if (!/^ASIA[A-Z0-9]{12,32}$/.test(accessKeyId) || secretAccessKey.length < 32 || sessionToken.length < 32
    || !Number.isFinite(Date.parse(expiration)) || Date.parse(expiration) <= Date.now() + 60_000) {
    throw new Error("AWS short-lived credential is invalid or expiring");
  }
  return Object.freeze({ accessKeyId, secretAccessKey, sessionToken, expiration });
}

export function strictQueueUrl(value: string, region: string): URL {
  if (region !== "ap-southeast-1") throw new Error("P0 AWS region must be ap-southeast-1");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== `sqs.${region}.amazonaws.com` || url.username || url.password
    || url.search || url.hash || !/^\/\d{12}\/[A-Za-z0-9_-]+\.fifo$/.test(url.pathname)) {
    throw new Error("AWS FIFO queue URL is invalid");
  }
  return url;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: string | Buffer, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
