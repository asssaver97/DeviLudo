import {
  testKitArtifactBrokerHttpsJson,
  type TestKitArtifactBrokerHttp,
  type TestKitArtifactBrokerTls,
} from "../../runner-control/src/testkit-artifact-client";
import type { GitHubAppJwtSigner } from "./github-contracts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const SIGNING_INPUT = /^[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,2048}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Delegates RS256 to a fixed mTLS Vault/KMS Broker; private-key bytes never enter this process. */
export class MtlsGitHubAppJwtSigner implements GitHubAppJwtSigner {
  readonly keyId: string;
  readonly #endpoint: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: TestKitArtifactBrokerHttp;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly keyId: string;
    readonly tls: TestKitArtifactBrokerTls;
    readonly timeoutMs?: number;
    readonly http?: TestKitArtifactBrokerHttp;
  }) {
    this.#endpoint = strictOrigin(options.endpoint);
    if (!SAFE_ID.test(options.keyId)) invalid("key ID");
    validateTls(options.tls);
    this.keyId = options.keyId;
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 60_000);
    this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }

  async signRs256(signingInput: Uint8Array): Promise<Uint8Array> {
    if (!(signingInput instanceof Uint8Array) || signingInput.byteLength < 20 || signingInput.byteLength > 4_096) invalid("input");
    const message = Buffer.from(signingInput).toString("utf8");
    if (!SIGNING_INPUT.test(message) || Buffer.byteLength(message, "utf8") !== signingInput.byteLength) invalid("input");
    const url = new URL(this.#endpoint.href);
    url.pathname = "/v1/github-app/sign-rs256";
    const response = await this.#http({
      url,
      body: JSON.stringify({
        schemaVersion: "deviludo.github-app-sign-request.v1",
        keyId: this.keyId,
        algorithm: "RS256",
        signingInput: Buffer.from(signingInput).toString("base64url"),
      }),
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
    });
    if (response.statusCode !== 200) throw new Error(`GitHub App signing Broker rejected the request with status ${response.statusCode}`);
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "keyId", "algorithm", "signature"]);
    if (body.schemaVersion !== "deviludo.github-app-sign-receipt.v1" || body.keyId !== this.keyId
      || body.algorithm !== "RS256" || typeof body.signature !== "string" || !BASE64URL.test(body.signature)) invalid("receipt");
    const signature = Buffer.from(body.signature, "base64url");
    if (signature.byteLength < 128 || signature.byteLength > 1_024
      || signature.toString("base64url") !== body.signature) invalid("signature");
    return new Uint8Array(signature);
  }
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
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("receipt");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("receipt");
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("timeout");
  return value;
}

function invalid(label: string): never {
  throw new Error(`GitHub App signing Broker ${label} is invalid`);
}
