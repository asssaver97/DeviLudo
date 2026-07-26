import type {
  TestKitArtifactBrokerHttp,
  TestKitArtifactBrokerTls,
} from "../../runner-control/src/testkit-artifact-client";
import { testKitArtifactBrokerHttpsJson } from "../../runner-control/src/testkit-artifact-client";
import { steamCanonicalDigest } from "./artifacts";
import type { SteamTargetPlatform } from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{1,1023}$/;

export type SteamDepotSigningScheme =
  | "LINUX_SIGSTORE"
  | "MACOS_DEVELOPER_ID"
  | "WINDOWS_AUTHENTICODE";

export interface SteamDepotFinalizationInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly mainCommitSha: string;
  readonly evidenceBundleDigest: string;
  readonly platform: SteamTargetPlatform;
  readonly sourceObjectKey: string;
  readonly sourceArtifactDigest: string;
}

export interface FinalizedSteamDepot {
  readonly platform: SteamTargetPlatform;
  readonly sourceArtifactDigest: string;
  readonly artifactObjectKey: string;
  readonly artifactDigest: string;
  readonly signingScheme: SteamDepotSigningScheme;
  readonly signingIdentityDigest: string;
  readonly signingEvidenceObjectKey: string;
  readonly signingEvidenceDigest: string;
  readonly notarizationEvidenceObjectKey: string | null;
  readonly notarizationEvidenceDigest: string | null;
}

export interface SteamDepotFinalizer {
  /** Must durably replay the exact release/platform operation after interruption. */
  finalize(input: SteamDepotFinalizationInput): Promise<FinalizedSteamDepot>;
  probe(): Promise<void>;
}

export function validateFinalizedSteamDepot(
  value: FinalizedSteamDepot,
  input: SteamDepotFinalizationInput,
): FinalizedSteamDepot {
  const body = record(value);
  exactKeys(body, [
    "platform", "sourceArtifactDigest", "artifactObjectKey", "artifactDigest", "signingScheme",
    "signingIdentityDigest", "signingEvidenceObjectKey", "signingEvidenceDigest",
    "notarizationEvidenceObjectKey", "notarizationEvidenceDigest",
  ]);
  if (body.platform !== input.platform || body.sourceArtifactDigest !== input.sourceArtifactDigest
    || typeof body.artifactDigest !== "string" || !SHA256.test(body.artifactDigest)
    || typeof body.signingIdentityDigest !== "string" || !SHA256.test(body.signingIdentityDigest)
    || typeof body.signingEvidenceDigest !== "string" || !SHA256.test(body.signingEvidenceDigest)
    || body.signingScheme !== expectedScheme(input.platform)) invalid("finalized binding");
  const artifactObjectKey = requiredObjectKey(body.artifactObjectKey);
  const signingObjectKey = requiredObjectKey(body.signingEvidenceObjectKey);
  if (artifactObjectKey !== signedDepotObjectKey(
    input.tenantId, input.projectId, input.releaseId, input.platform, body.artifactDigest,
  ) || signingObjectKey !== signingEvidenceObjectKey(
    input.tenantId, input.projectId, input.releaseId, input.platform, body.signingEvidenceDigest,
  )) invalid("finalized object scope");
  let notarizationObjectKey: string | null = null;
  let notarizationDigest: string | null = null;
  if (input.platform === "macos") {
    if (typeof body.notarizationEvidenceDigest !== "string" || !SHA256.test(body.notarizationEvidenceDigest)) {
      invalid("macOS notarization");
    }
    notarizationDigest = body.notarizationEvidenceDigest;
    notarizationObjectKey = requiredObjectKey(body.notarizationEvidenceObjectKey);
    if (notarizationObjectKey !== notarizationEvidenceObjectKey(
      input.tenantId, input.projectId, input.releaseId, notarizationDigest,
    )) invalid("macOS notarization scope");
  } else if (body.notarizationEvidenceObjectKey !== null || body.notarizationEvidenceDigest !== null) {
    invalid("unexpected notarization");
  }
  return deepFreeze({
    platform: input.platform,
    sourceArtifactDigest: input.sourceArtifactDigest,
    artifactObjectKey,
    artifactDigest: body.artifactDigest,
    signingScheme: body.signingScheme as SteamDepotSigningScheme,
    signingIdentityDigest: body.signingIdentityDigest,
    signingEvidenceObjectKey: signingObjectKey,
    signingEvidenceDigest: body.signingEvidenceDigest,
    notarizationEvidenceObjectKey: notarizationObjectKey,
    notarizationEvidenceDigest: notarizationDigest,
  });
}

/**
 * Delegates OS-native signing and notarization to a credential-isolated mTLS
 * Broker. This process receives only content addresses and public evidence.
 */
export class MtlsSteamDepotFinalizer implements SteamDepotFinalizer {
  readonly #endpoint: URL;
  readonly #platform: SteamTargetPlatform | null;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: TestKitArtifactBrokerHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    platform?: SteamTargetPlatform;
    tls: TestKitArtifactBrokerTls;
    timeoutMs?: number;
    http?: TestKitArtifactBrokerHttp;
  }>) {
    this.#endpoint = strictOrigin(options.endpoint);
    this.#platform = options.platform ?? null;
    if (options.platform !== undefined && !isPlatform(options.platform)) invalid("platform");
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 30 * 60_000, 1_000, 60 * 60_000);
    this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }

  async finalize(input: SteamDepotFinalizationInput): Promise<FinalizedSteamDepot> {
    validateInput(input);
    if (this.#platform !== null && input.platform !== this.#platform) invalid("platform route");
    const operationKey = `steam-depot-finalize:${input.releaseId}:${input.platform}`;
    const requestCore = Object.freeze({
      schemaVersion: "deviludo.steam-depot-finalization.v1" as const,
      operationKey,
      tenantId: input.tenantId,
      projectId: input.projectId,
      releaseId: input.releaseId,
      mainCommitSha: input.mainCommitSha,
      evidenceBundleDigest: input.evidenceBundleDigest,
      platform: input.platform,
      sourceObjectKey: input.sourceObjectKey,
      sourceArtifactDigest: input.sourceArtifactDigest,
    });
    const requestDigest = steamCanonicalDigest(requestCore);
    const url = new URL(this.#endpoint.href);
    url.pathname = "/v1/steam-depots/finalize";
    const response = await this.#http({
      url,
      body: JSON.stringify({ ...requestCore, requestDigest }),
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
    });
    if (response.statusCode !== 200) {
      throw new Error(`Steam depot finalization Broker rejected the request with status ${response.statusCode}`);
    }
    return parseReceipt(response.payload, input, operationKey, requestDigest);
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href);
    url.pathname = "/healthz";
    const response = await this.#http({ url, body: "{}", tls: this.#tls, timeoutMs: this.#timeoutMs });
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "status", "service", "supportedSchemes"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.steam-depot-finalizer-health.v1"
      || body.status !== "ok" || body.service !== "deviludo-steam-depot-finalizer"
      || JSON.stringify(body.supportedSchemes) !== JSON.stringify(this.#platform === null
        ? ["LINUX_SIGSTORE", "MACOS_DEVELOPER_ID", "WINDOWS_AUTHENTICODE"]
        : [expectedScheme(this.#platform)])) invalid("health");
  }
}

/** Routes each target to a distinct platform-native mTLS signing service. */
export class PlatformSteamDepotFinalizer implements SteamDepotFinalizer {
  readonly #finalizers: Readonly<Record<SteamTargetPlatform, SteamDepotFinalizer>>;

  constructor(finalizers: Readonly<Record<SteamTargetPlatform, SteamDepotFinalizer>>) {
    if (!finalizers || typeof finalizers !== "object" || Array.isArray(finalizers)
      || JSON.stringify(Object.keys(finalizers).sort()) !== JSON.stringify(["linux", "macos", "windows"])) {
      invalid("platform finalizers");
    }
    for (const platform of ["windows", "linux", "macos"] as const) {
      const finalizer = finalizers[platform];
      if (!finalizer || typeof finalizer.finalize !== "function" || typeof finalizer.probe !== "function") {
        invalid("platform finalizer");
      }
    }
    this.#finalizers = Object.freeze({ ...finalizers });
  }

  async finalize(input: SteamDepotFinalizationInput): Promise<FinalizedSteamDepot> {
    validateInput(input);
    return validateFinalizedSteamDepot(await this.#finalizers[input.platform].finalize(input), input);
  }

  async probe(): Promise<void> {
    await Promise.all(["windows", "linux", "macos"].map((platform) =>
      this.#finalizers[platform as SteamTargetPlatform].probe()));
  }
}

export function signedDepotObjectKey(
  tenantId: string,
  projectId: string,
  releaseId: string,
  platform: SteamTargetPlatform,
  digest: string,
): string {
  return finalizationObjectKey(tenantId, projectId, releaseId, platform, "artifact", digest);
}

export function signingEvidenceObjectKey(
  tenantId: string,
  projectId: string,
  releaseId: string,
  platform: SteamTargetPlatform,
  digest: string,
): string {
  return finalizationObjectKey(tenantId, projectId, releaseId, platform, "signing-evidence", digest);
}

export function notarizationEvidenceObjectKey(
  tenantId: string,
  projectId: string,
  releaseId: string,
  digest: string,
): string {
  return finalizationObjectKey(tenantId, projectId, releaseId, "macos", "notarization-evidence", digest);
}

function parseReceipt(
  value: unknown,
  input: SteamDepotFinalizationInput,
  operationKey: string,
  requestDigest: string,
): FinalizedSteamDepot {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "operationKey", "requestDigest", "tenantId", "projectId", "releaseId",
    "mainCommitSha", "evidenceBundleDigest", "platform", "sourceArtifactDigest",
    "artifactObjectKey", "artifactDigest", "signingScheme", "signingIdentityDigest",
    "signingEvidenceObjectKey", "signingEvidenceDigest", "notarizationEvidenceObjectKey",
    "notarizationEvidenceDigest",
  ]);
  if (body.schemaVersion !== "deviludo.steam-depot-finalization-receipt.v1"
    || body.operationKey !== operationKey || body.requestDigest !== requestDigest
    || body.tenantId !== input.tenantId || body.projectId !== input.projectId || body.releaseId !== input.releaseId
    || body.mainCommitSha !== input.mainCommitSha || body.evidenceBundleDigest !== input.evidenceBundleDigest
    || body.platform !== input.platform || body.sourceArtifactDigest !== input.sourceArtifactDigest
    || typeof body.artifactDigest !== "string" || !SHA256.test(body.artifactDigest)
    || typeof body.signingIdentityDigest !== "string" || !SHA256.test(body.signingIdentityDigest)
    || typeof body.signingEvidenceDigest !== "string" || !SHA256.test(body.signingEvidenceDigest)
    || body.signingScheme !== expectedScheme(input.platform)) invalid("receipt binding");
  const artifactObjectKey = requiredObjectKey(body.artifactObjectKey);
  const signingObjectKey = requiredObjectKey(body.signingEvidenceObjectKey);
  if (artifactObjectKey !== signedDepotObjectKey(
    input.tenantId, input.projectId, input.releaseId, input.platform, body.artifactDigest,
  ) || signingObjectKey !== signingEvidenceObjectKey(
    input.tenantId, input.projectId, input.releaseId, input.platform, body.signingEvidenceDigest,
  )) invalid("receipt object scope");

  let notarizationObjectKey: string | null = null;
  let notarizationDigest: string | null = null;
  if (input.platform === "macos") {
    if (typeof body.notarizationEvidenceDigest !== "string" || !SHA256.test(body.notarizationEvidenceDigest)) {
      invalid("macOS notarization");
    }
    notarizationDigest = body.notarizationEvidenceDigest;
    notarizationObjectKey = requiredObjectKey(body.notarizationEvidenceObjectKey);
    if (notarizationObjectKey !== notarizationEvidenceObjectKey(
      input.tenantId, input.projectId, input.releaseId, notarizationDigest,
    )) invalid("macOS notarization scope");
  } else if (body.notarizationEvidenceObjectKey !== null || body.notarizationEvidenceDigest !== null) {
    invalid("unexpected notarization");
  }

  return validateFinalizedSteamDepot(deepFreeze({
    platform: input.platform,
    sourceArtifactDigest: input.sourceArtifactDigest,
    artifactObjectKey,
    artifactDigest: body.artifactDigest,
    signingScheme: body.signingScheme as SteamDepotSigningScheme,
    signingIdentityDigest: body.signingIdentityDigest,
    signingEvidenceObjectKey: signingObjectKey,
    signingEvidenceDigest: body.signingEvidenceDigest,
    notarizationEvidenceObjectKey: notarizationObjectKey,
    notarizationEvidenceDigest: notarizationDigest,
  }), input);
}

function validateInput(input: SteamDepotFinalizationInput): void {
  if (!UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.releaseId)
    || !SHA1.test(input.mainCommitSha) || !SHA256.test(input.evidenceBundleDigest)
    || !SHA256.test(input.sourceArtifactDigest) || !isPlatform(input.platform)) invalid("request");
  requiredObjectKey(input.sourceObjectKey);
}

function expectedScheme(platform: SteamTargetPlatform): SteamDepotSigningScheme {
  if (platform === "windows") return "WINDOWS_AUTHENTICODE";
  if (platform === "macos") return "MACOS_DEVELOPER_ID";
  return "LINUX_SIGSTORE";
}

function finalizationObjectKey(
  tenantId: string,
  projectId: string,
  releaseId: string,
  platform: SteamTargetPlatform,
  kind: "artifact" | "signing-evidence" | "notarization-evidence",
  digest: string,
): string {
  if (!UUID.test(tenantId) || !UUID.test(projectId) || !UUID.test(releaseId) || !isPlatform(platform)
    || !SHA256.test(digest)) invalid("object binding");
  return `tenants/${tenantId}/projects/${projectId}/steam-releases/${releaseId}/depots/${platform}/${kind}/${digest}`;
}

function requiredObjectKey(value: unknown): string {
  if (typeof value !== "string" || !SAFE_OBJECT_KEY.test(value) || value.includes("..")
    || value.startsWith("/") || value.endsWith("/")) invalid("object key");
  return value;
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

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("timeout");
  return value;
}

function isPlatform(value: unknown): value is SteamTargetPlatform {
  return value === "windows" || value === "linux" || value === "macos";
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(label: string): never {
  throw new Error(`Steam depot finalization ${label} is invalid`);
}
