import { request as httpsRequest, type RequestOptions } from "node:https";
import type { TargetPlatform } from "../../../lib/domain/types";
import type { SignedRunnerJob } from "../../runner-control/src/contracts";

const MAX_RESPONSE_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const APP_ID = /^[1-9][0-9]{0,19}$/;
const BETA_BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;

export interface SteamInstallGrantRedemptionReceipt {
  readonly schemaVersion: "deviludo.steam-install-grant-redemption-receipt.v1";
  readonly jobDigest: string;
  readonly executionLockDigest: string;
  readonly grantId: string;
  readonly platform: TargetPlatform;
  readonly steamAppId: string;
  readonly buildId: string;
  readonly betaBranch: string;
  readonly redeemedAt: string;
}

export interface SteamInstallGrantRedemptionPort {
  redeem(input: Readonly<{ jobDigest: string; signedJob: SignedRunnerJob }>): Promise<SteamInstallGrantRedemptionReceipt>;
  probe(): Promise<void>;
}

export interface SteamInstallGrantClientTls {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export type SteamInstallGrantClientHttp = (input: Readonly<{
  url: URL;
  method: "GET" | "POST";
  body: string;
  tls: SteamInstallGrantClientTls;
  timeoutMs: number;
}>) => Promise<Readonly<{ statusCode: number; payload: unknown }>>;

/** Redeems one opaque grant through a dedicated Connector mTLS identity. */
export class MtlsSteamInstallGrantClient implements SteamInstallGrantRedemptionPort {
  readonly #endpoint: URL;
  readonly #tls: SteamInstallGrantClientTls;
  readonly #timeoutMs: number;
  readonly #http: SteamInstallGrantClientHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    tls: SteamInstallGrantClientTls;
    timeoutMs?: number;
    http?: SteamInstallGrantClientHttp;
  }>) {
    this.#endpoint = strictOrigin(options.endpoint);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 300_000);
    this.#http = options.http ?? steamInstallGrantHttpsJson;
  }

  async redeem(input: Readonly<{ jobDigest: string; signedJob: SignedRunnerJob }>): Promise<SteamInstallGrantRedemptionReceipt> {
    if (!SHA256.test(input.jobDigest)) invalidReceipt();
    const response = await this.#http({
      url: new URL("/v1/steam-install-grant-redemptions", this.#endpoint),
      method: "POST",
      body: JSON.stringify({
        schemaVersion: "deviludo.steam-install-grant-redemption.v1",
        jobDigest: input.jobDigest,
        signedJob: input.signedJob,
      }),
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
    });
    if (response.statusCode !== 200) throw new Error("Steam install grant redemption was rejected");
    return parseReceipt(response.payload, input);
  }

  async probe(): Promise<void> {
    const response = await this.#http({
      url: new URL("/healthz", this.#endpoint),
      method: "GET",
      body: "",
      tls: this.#tls,
      timeoutMs: Math.min(this.#timeoutMs, 30_000),
    });
    const body = record(response.payload);
    exactKeys(body, ["status", "service"]);
    if (response.statusCode !== 200 || body.status !== "ok" || body.service !== "deviludo-steam-install-grants") {
      throw new Error("Steam install grant service is not ready");
    }
  }
}

export function steamInstallGrantHttpsJson(input: Parameters<SteamInstallGrantClientHttp>[0]): ReturnType<SteamInstallGrantClientHttp> {
  return new Promise((resolve, reject) => {
    const headers = input.method === "POST" ? {
      accept: "application/json",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(input.body)),
    } : { accept: "application/json" };
    const options: RequestOptions = {
      method: input.method,
      headers,
      key: input.tls.key,
      cert: input.tls.certificate,
      ca: input.tls.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: input.url.hostname,
    };
    const request = httpsRequest(input.url, options, (response) => {
      const advertised = Number(response.headers["content-length"] ?? 0);
      if (!Number.isFinite(advertised) || advertised < 0 || advertised > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(new Error("Steam install grant response exceeded the limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Steam install grant response exceeded the limit"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve(Object.freeze({
            statusCode: response.statusCode ?? 503,
            payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          }));
        } catch { reject(new Error("Steam install grant service returned invalid JSON")); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Steam install grant request timed out")));
    request.once("error", reject);
    request.end(input.method === "POST" ? input.body : undefined);
  });
}

function parseReceipt(
  value: unknown,
  input: Readonly<{ jobDigest: string; signedJob: SignedRunnerJob }>,
): SteamInstallGrantRedemptionReceipt {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "jobDigest", "executionLockDigest", "grantId", "platform",
    "steamAppId", "buildId", "betaBranch", "redeemedAt",
  ]);
  const execution = input.signedJob.payload.execution;
  if (execution.kind !== "STEAM_CLEAN_INSTALL"
    || body.schemaVersion !== "deviludo.steam-install-grant-redemption-receipt.v1"
    || body.jobDigest !== input.jobDigest
    || body.executionLockDigest !== input.signedJob.payload.executionLockDigest
    || body.grantId !== execution.installGrantId
    || body.platform !== input.signedJob.payload.platform
    || body.steamAppId !== execution.steamAppId
    || body.buildId !== execution.buildId
    || body.betaBranch !== execution.betaBranch
    || typeof body.redeemedAt !== "string" || !Number.isFinite(Date.parse(body.redeemedAt))) invalidReceipt();
  return Object.freeze({
    schemaVersion: body.schemaVersion,
    jobDigest: required(body.jobDigest, SHA256),
    executionLockDigest: required(body.executionLockDigest, SHA256),
    grantId: required(body.grantId, SAFE_ID),
    platform: body.platform as TargetPlatform,
    steamAppId: required(body.steamAppId, APP_ID),
    buildId: required(body.buildId, APP_ID),
    betaBranch: required(body.betaBranch, BETA_BRANCH),
    redeemedAt: body.redeemedAt,
  });
}

function strictOrigin(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Steam install grant URL is invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Steam install grant URL is invalid");
  return new URL(url.origin);
}

function validateTls(tls: SteamInstallGrantClientTls): void {
  for (const value of [tls.key, tls.certificate, tls.ca]) {
    if (!Buffer.isBuffer(value) || value.byteLength < 32 || value.byteLength > 1024 * 1024) {
      throw new Error("Steam install grant TLS material is invalid");
    }
  }
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("Steam install grant timeout is invalid");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidReceipt();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalidReceipt();
}

function required(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalidReceipt();
  return value;
}

function invalidReceipt(): never { throw new Error("Steam install grant receipt is invalid"); }
