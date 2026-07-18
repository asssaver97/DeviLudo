import type { KeyObject } from "node:crypto";
import {
  testKitArtifactBrokerHttpsJson,
  type TestKitArtifactBrokerHttp,
  type TestKitArtifactBrokerTls,
} from "../../runner-control/src/testkit-artifact-client";
import { S3ImmutableObjectStore } from "../../evidence-archive/src/s3-store";
import { steamCanonicalDigest, verifySteamRcArtifact } from "./artifacts";
import type { SignedSteamRcArtifact, SteamRcArtifactClaims } from "./contracts";
import { validateSignedSteamRcArtifact, type SteamRcArtifactSigner, type SteamRcObjectInspector } from "./rc-issuance";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Verifies RC exports through the same checksum-enforcing S3 boundary as Runner evidence. */
export class S3SteamRcObjectInspector implements SteamRcObjectInspector {
  constructor(private readonly objects: Pick<S3ImmutableObjectStore, "verifyObject" | "probe">, private readonly bucket: string) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) invalid("bucket");
  }

  async inspect(input: Parameters<SteamRcObjectInspector["inspect"]>[0]) {
    if (!safeObjectKey(input.objectKey) || !SHA256.test(input.artifactDigest)) invalid("object binding");
    const verified = await this.objects.verifyObject({ objectKey: input.objectKey, artifactDigest: input.artifactDigest });
    if (!Number.isSafeInteger(verified.sizeBytes) || verified.sizeBytes < 1) invalid("object receipt");
    return Object.freeze({ objectRef: `s3://${this.bucket}/${input.objectKey}`, sizeBytes: verified.sizeBytes });
  }

  async probe(): Promise<void> { await this.objects.probe(); }
}

/** Delegates Ed25519 RC signing to a fixed mTLS Vault/KMS Broker and verifies the result locally. */
export class MtlsSteamRcArtifactSigner implements SteamRcArtifactSigner {
  readonly #endpoint: URL;
  readonly #keyId: string;
  readonly #publicKey: KeyObject;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: TestKitArtifactBrokerHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    keyId: string;
    publicKey: KeyObject;
    tls: TestKitArtifactBrokerTls;
    timeoutMs?: number;
    http?: TestKitArtifactBrokerHttp;
  }>) {
    this.#endpoint = strictOrigin(options.endpoint);
    if (!SAFE_ID.test(options.keyId) || options.publicKey.type !== "public"
      || options.publicKey.asymmetricKeyType !== "ed25519") invalid("verification key");
    validateTls(options.tls);
    this.#keyId = options.keyId;
    this.#publicKey = options.publicKey;
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 60_000);
    this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }

  async sign(claims: SteamRcArtifactClaims): Promise<SignedSteamRcArtifact> {
    const claimsDigest = steamCanonicalDigest(claims);
    const url = new URL(this.#endpoint.href);
    url.pathname = "/v1/steam-rc/sign-ed25519";
    const response = await this.#http({
      url,
      body: JSON.stringify({
        schemaVersion: "deviludo.steam-rc-sign-request.v1",
        keyId: this.#keyId,
        algorithm: "Ed25519",
        claimsDigest,
        claims,
      }),
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
    });
    if (response.statusCode !== 200) throw new Error(`Steam RC signing Broker rejected the request with status ${response.statusCode}`);
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "keyId", "algorithm", "claimsDigest", "artifact"]);
    if (body.schemaVersion !== "deviludo.steam-rc-sign-receipt.v1" || body.keyId !== this.#keyId
      || body.algorithm !== "Ed25519" || body.claimsDigest !== claimsDigest) invalid("signing receipt");
    const artifact = validateSignedSteamRcArtifact(body.artifact);
    if (artifact.keyId !== this.#keyId || steamCanonicalDigest(artifact.claims) !== claimsDigest
      || !verifySteamRcArtifact(this.#publicKey, artifact)) invalid("signed artifact");
    return artifact;
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href);
    url.pathname = "/healthz";
    const response = await this.#http({ url, body: "{}", tls: this.#tls, timeoutMs: this.#timeoutMs });
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "status", "keyId", "algorithm"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.steam-rc-signer-health.v1"
      || body.status !== "ok" || body.keyId !== this.#keyId || body.algorithm !== "Ed25519") invalid("health");
  }
}

function safeObjectKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9/_.-]{1,1023}$/.test(value)
    && !value.includes("..") && !value.endsWith("/");
}

function strictOrigin(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { invalid("endpoint"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) invalid("endpoint");
  return url;
}

function validateTls(value: TestKitArtifactBrokerTls): void {
  if (!Buffer.isBuffer(value.key) || !Buffer.isBuffer(value.certificate) || !Buffer.isBuffer(value.ca)
    || value.key.byteLength < 32 || value.certificate.byteLength < 32 || value.ca.byteLength < 32
    || value.key.byteLength > 1024 * 1024 || value.certificate.byteLength > 1024 * 1024
    || value.ca.byteLength > 1024 * 1024) invalid("TLS");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("response");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("response fields");
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("timeout");
  return value;
}

function invalid(label: string): never {
  throw new Error(`Steam RC production dependency ${label} is invalid`);
}
