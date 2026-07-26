import type { KeyObject } from "node:crypto";
import { canonicalJson } from "../../runner-control/src/canonical";
import {
  testKitArtifactBrokerHttpsJson,
  type TestKitArtifactBrokerHttp,
  type TestKitArtifactBrokerTls,
} from "../../runner-control/src/testkit-artifact-client";
import {
  validateSteamDepotFinalizerHostActivationRequest,
  validateSteamDepotFinalizerHostActuationReceipt,
  validateSteamDepotFinalizerHostDrainReceipt,
  verifySteamDepotFinalizerHostActivationGrant,
  type SignedSteamDepotFinalizerHostActivationGrant,
  type SteamDepotFinalizerHostActuationReceipt,
  type SteamDepotFinalizerHostDrainReceipt,
} from "./host-activation";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;

export class MtlsSteamDepotFinalizerHostActivationClient {
  readonly #endpoint: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #publicKey: KeyObject;
  readonly #keyId: string;
  readonly #timeoutMs: number;
  readonly #http: TestKitArtifactBrokerHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    tls: TestKitArtifactBrokerTls;
    publicKey: KeyObject;
    keyId: string;
    timeoutMs?: number;
    http?: TestKitArtifactBrokerHttp;
  }>) {
    this.#endpoint = strictOrigin(options.endpoint);
    validateTls(options.tls);
    if (options.publicKey?.type !== "public" || options.publicKey.asymmetricKeyType !== "ed25519"
      || !SAFE_ID.test(options.keyId)) invalidConfig();
    this.#tls = Object.freeze({ ...options.tls });
    this.#publicKey = options.publicKey;
    this.#keyId = options.keyId;
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 60_000);
    this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }

  async authorize(
    requestValue: unknown,
    now = new Date(),
  ): Promise<SteamDepotFinalizerHostDrainReceipt | SignedSteamDepotFinalizerHostActivationGrant> {
    const request = validateSteamDepotFinalizerHostActivationRequest(requestValue);
    validNow(now);
    const response = await this.#post("/v1/steam-depot-finalizer-host-activations/authorize", request);
    const data = activationResponse(response);
    if (record(data).schemaVersion === "deviludo.steam-depot-finalizer-host-drain-receipt.v1") {
      return validateSteamDepotFinalizerHostDrainReceipt(data, request);
    }
    return verifySteamDepotFinalizerHostActivationGrant(data, {
      publicKey: this.#publicKey,
      keyId: this.#keyId,
      request,
      now,
    });
  }

  async complete(
    grantValue: unknown,
    receiptValue: unknown,
    now = new Date(),
  ): Promise<SteamDepotFinalizerHostActuationReceipt> {
    validNow(now);
    const grant = verifySteamDepotFinalizerHostActivationGrant(grantValue, {
      publicKey: this.#publicKey,
      keyId: this.#keyId,
      now,
      allowExpired: true,
    });
    const receipt = validateSteamDepotFinalizerHostActuationReceipt(receiptValue, grant);
    const response = await this.#post("/v1/steam-depot-finalizer-host-activations/complete", {
      schemaVersion: "deviludo.steam-depot-finalizer-host-activation-completion.v1",
      grant,
      receipt,
    });
    const body = record(response.payload);
    exactKeys(body, ["data", "schemaVersion"]);
    if (response.statusCode !== 200
      || body.schemaVersion !== "deviludo.steam-depot-finalizer-host-activation-completion-response.v1") invalidResponse();
    const stored = validateSteamDepotFinalizerHostActuationReceipt(body.data, grant);
    if (stored.receiptDigest !== receipt.receiptDigest || canonicalJson(stored) !== canonicalJson(receipt)) invalidResponse();
    return stored;
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href); url.pathname = "/healthz";
    const response = await this.#http({ url, method: "GET", body: "", tls: this.#tls, timeoutMs: this.#timeoutMs });
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "service", "status"]);
    if (response.statusCode !== 200
      || body.schemaVersion !== "deviludo.steam-depot-finalizer-host-activation-health.v1"
      || body.status !== "ok" || body.service !== "deviludo-steam-depot-finalizer-host-activation") invalidResponse();
  }

  async #post(path: string, value: unknown) {
    const url = new URL(this.#endpoint.href); url.pathname = path;
    const response = await this.#http({
      url,
      body: canonicalJson(value),
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
    });
    if (response.statusCode !== 200) invalidResponse();
    return response;
  }
}

function activationResponse(response: Awaited<ReturnType<TestKitArtifactBrokerHttp>>): unknown {
  const body = record(response.payload);
  exactKeys(body, ["data", "schemaVersion"]);
  if (response.statusCode !== 200
    || body.schemaVersion !== "deviludo.steam-depot-finalizer-host-activation-response.v1") invalidResponse();
  return body.data;
}
function strictOrigin(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); } catch { invalidConfig(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) invalidConfig();
  url.pathname = "/";
  return url;
}
function validateTls(value: TestKitArtifactBrokerTls): void {
  if (![value?.key, value?.certificate, value?.ca].every((item) => Buffer.isBuffer(item)
    && item.byteLength >= 32 && item.byteLength <= 1024 * 1024)) invalidConfig();
}
function validNow(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) invalidConfig();
}
function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalidConfig();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidResponse();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalidResponse();
}
function invalidConfig(): never { throw new Error("Steam depot Finalizer host activation client configuration is invalid"); }
function invalidResponse(): never { throw new Error("Steam depot Finalizer host activation authority response is invalid"); }
