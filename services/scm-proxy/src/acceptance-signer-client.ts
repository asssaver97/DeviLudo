import type { KeyObject } from "node:crypto";
import {
  testKitArtifactBrokerHttpsJson,
  type TestKitArtifactBrokerHttp,
  type TestKitArtifactBrokerTls,
} from "../../runner-control/src/testkit-artifact-client";
import { sha256Canonical } from "./canonical";
import { verifyCandidateAcceptance } from "./github-artifacts";
import type { CandidateAcceptanceClaims, SignedCandidateAcceptance } from "./github-contracts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

export interface CandidateAcceptanceSigner {
  sign(claims: CandidateAcceptanceClaims): Promise<SignedCandidateAcceptance>;
  probe(): Promise<void>;
}

/** Delegates the short-lived acceptance proof to Vault/KMS and verifies it locally. */
export class MtlsCandidateAcceptanceSigner implements CandidateAcceptanceSigner {
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

  async sign(claims: CandidateAcceptanceClaims): Promise<SignedCandidateAcceptance> {
    const claimsDigest = sha256Canonical(claims);
    const url = new URL(this.#endpoint.href);
    url.pathname = "/v1/github-candidate-acceptance/sign-ed25519";
    const response = await this.#http({
      url,
      body: JSON.stringify({
        schemaVersion: "deviludo.github-candidate-acceptance-sign-request.v1",
        keyId: this.#keyId,
        algorithm: "Ed25519",
        claimsDigest,
        claims,
      }),
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
    });
    if (response.statusCode !== 200) throw new Error(`Acceptance signing Broker rejected the request with status ${response.statusCode}`);
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "keyId", "algorithm", "claimsDigest", "acceptance"]);
    if (body.schemaVersion !== "deviludo.github-candidate-acceptance-sign-receipt.v1"
      || body.keyId !== this.#keyId || body.algorithm !== "Ed25519" || body.claimsDigest !== claimsDigest) invalid("receipt");
    const acceptance = signedAcceptance(body.acceptance);
    if (sha256Canonical(acceptance.claims) !== claimsDigest || acceptance.signature.keyId !== this.#keyId
      || !verifyCandidateAcceptance(acceptance, new Map([[this.#keyId, this.#publicKey]]), {
        tenantId: claims.tenantId,
        projectId: claims.projectId,
        candidateCommitSha: claims.candidateCommitSha,
        sourceDigest: claims.sourceDigest,
        specRevisionId: claims.specRevisionId,
        evidenceBundleDigest: claims.evidenceBundleDigest,
      }, claims.iat)) invalid("signed proof");
    return acceptance;
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href);
    url.pathname = "/healthz";
    const response = await this.#http({ url, method: "GET", body: "{}", tls: this.#tls, timeoutMs: this.#timeoutMs });
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "status", "keyId", "algorithm"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.github-candidate-acceptance-signer-health.v1"
      || body.status !== "ok" || body.keyId !== this.#keyId || body.algorithm !== "Ed25519") invalid("health");
  }
}

function signedAcceptance(value: unknown): SignedCandidateAcceptance {
  const body = record(value); const claims = record(body.claims); const signature = record(body.signature);
  exactKeys(body, ["claims", "signature"]); exactKeys(signature, ["algorithm", "keyId", "value"]);
  if (signature.algorithm !== "Ed25519" || typeof signature.keyId !== "string" || typeof signature.value !== "string") invalid("proof");
  return Object.freeze({ claims: Object.freeze(claims as unknown as CandidateAcceptanceClaims),
    signature: Object.freeze({ algorithm: "Ed25519", keyId: signature.keyId, value: signature.value }) });
}
function strictOrigin(value: string | URL): URL { let url: URL; try { url = new URL(value); } catch { invalid("endpoint"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) invalid("endpoint"); return url; }
function validateTls(value: TestKitArtifactBrokerTls): void { if (![value.key, value.certificate, value.ca].every((item) => Buffer.isBuffer(item)
  && item.byteLength >= 32 && item.byteLength <= 1024 * 1024)) invalid("TLS"); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid("response"); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { const actual = Object.keys(value).sort(); const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("response fields"); }
function integer(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("timeout"); return value; }
function invalid(label: string): never { throw new Error(`Candidate acceptance signing ${label} is invalid`); }
