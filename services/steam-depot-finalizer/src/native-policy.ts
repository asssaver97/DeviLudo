import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import type { SteamTargetPlatform } from "../../steam-publisher/src/contracts";
import type { SteamDepotSigningScheme } from "../../steam-publisher/src/depot-finalization";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ACCESS_KEY = /^[A-Za-z0-9][A-Za-z0-9+/=_-]{7,127}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9 ._+@():/-]{2,255}$/;
const KMS_REF = /^kms:\/\/[A-Za-z0-9][A-Za-z0-9._~:/?=&%-]{2,1000}$/;

export interface SteamDepotNativeTool {
  readonly path: string;
  readonly digest: string;
  readonly version: string;
}

export interface SteamDepotArtifactStorePolicy {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKeyFile: string;
  readonly caFile: string;
}

export type SteamDepotSignerPolicy =
  | Readonly<{
    scheme: "WINDOWS_AUTHENTICODE";
    certificateSha1: string;
    timestampUrl: string;
    signtool: SteamDepotNativeTool;
  }>
  | Readonly<{
    scheme: "LINUX_SIGSTORE";
    signingKeyRef: string;
    publicKeyFile: string;
    publicKeyDigest: string;
    cosign: SteamDepotNativeTool;
  }>
  | Readonly<{
    scheme: "MACOS_DEVELOPER_ID";
    developerIdIdentity: string;
    notaryKeychainProfile: string;
    codesign: SteamDepotNativeTool;
    ditto: SteamDepotNativeTool;
    spctl: SteamDepotNativeTool;
    xcrun: SteamDepotNativeTool;
  }>;

export interface SteamDepotNativePolicy {
  readonly schemaVersion: "deviludo.steam-depot-native-policy.v1";
  readonly policyVersion: string;
  readonly platform: SteamTargetPlatform;
  readonly workRoot: string;
  readonly artifactStore: SteamDepotArtifactStorePolicy;
  readonly signer: SteamDepotSignerPolicy;
}

export function parseSteamDepotNativePolicy(value: unknown): SteamDepotNativePolicy {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "policyVersion", "platform", "workRoot", "artifactStore", "signer"]);
  if (body.schemaVersion !== "deviludo.steam-depot-native-policy.v1"
    || typeof body.policyVersion !== "string" || !exactVersion(body.policyVersion)
    || !isPlatform(body.platform) || typeof body.workRoot !== "string" || !absolute(body.workRoot)) invalid();
  const artifactStore = artifactStorePolicy(body.artifactStore);
  const signer = signerPolicy(body.signer, body.platform);
  return Object.freeze({
    schemaVersion: body.schemaVersion,
    policyVersion: body.policyVersion,
    platform: body.platform,
    workRoot: body.workRoot,
    artifactStore,
    signer,
  });
}

export function steamDepotNativePolicyDigest(policy: SteamDepotNativePolicy): string {
  return createHash("sha256").update(canonicalJson(parseSteamDepotNativePolicy(policy))).digest("hex");
}

export function steamDepotSigningIdentityDigest(policy: SteamDepotSignerPolicy): string {
  const identity = policy.scheme === "WINDOWS_AUTHENTICODE"
    ? { scheme: policy.scheme, certificateSha1: policy.certificateSha1, timestampUrl: policy.timestampUrl }
    : policy.scheme === "LINUX_SIGSTORE"
      ? { scheme: policy.scheme, signingKeyRef: policy.signingKeyRef, publicKeyDigest: policy.publicKeyDigest }
      : { scheme: policy.scheme, developerIdIdentity: policy.developerIdIdentity };
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

function artifactStorePolicy(value: unknown): SteamDepotArtifactStorePolicy {
  const body = record(value);
  exactKeys(body, ["endpoint", "bucket", "region", "accessKeyId", "secretAccessKeyFile", "caFile"]);
  if (typeof body.endpoint !== "string" || strictEndpoint(body.endpoint) !== body.endpoint
    || typeof body.bucket !== "string" || !BUCKET.test(body.bucket) || body.bucket.includes("..")
    || typeof body.region !== "string" || !REGION.test(body.region)
    || typeof body.accessKeyId !== "string" || !ACCESS_KEY.test(body.accessKeyId)
    || typeof body.secretAccessKeyFile !== "string" || !absolute(body.secretAccessKeyFile)
    || typeof body.caFile !== "string" || !absolute(body.caFile)
    || body.secretAccessKeyFile === body.caFile) invalid();
  return Object.freeze({
    endpoint: body.endpoint,
    bucket: body.bucket,
    region: body.region,
    accessKeyId: body.accessKeyId,
    secretAccessKeyFile: body.secretAccessKeyFile,
    caFile: body.caFile,
  });
}

function signerPolicy(value: unknown, platform: SteamTargetPlatform): SteamDepotSignerPolicy {
  const body = record(value);
  if (platform === "windows") {
    exactKeys(body, ["scheme", "certificateSha1", "timestampUrl", "signtool"]);
    if (body.scheme !== "WINDOWS_AUTHENTICODE" || typeof body.certificateSha1 !== "string"
      || !/^[A-F0-9]{40}$/.test(body.certificateSha1) || typeof body.timestampUrl !== "string"
      || strictHttpsUrl(body.timestampUrl) !== body.timestampUrl) invalid();
    return Object.freeze({
      scheme: body.scheme,
      certificateSha1: body.certificateSha1,
      timestampUrl: body.timestampUrl,
      signtool: nativeTool(body.signtool),
    });
  }
  if (platform === "linux") {
    exactKeys(body, ["scheme", "signingKeyRef", "publicKeyFile", "publicKeyDigest", "cosign"]);
    if (body.scheme !== "LINUX_SIGSTORE" || typeof body.signingKeyRef !== "string" || !KMS_REF.test(body.signingKeyRef)
      || typeof body.publicKeyFile !== "string" || !absolute(body.publicKeyFile)
      || typeof body.publicKeyDigest !== "string" || !SHA256.test(body.publicKeyDigest)) invalid();
    return Object.freeze({
      scheme: body.scheme,
      signingKeyRef: body.signingKeyRef,
      publicKeyFile: body.publicKeyFile,
      publicKeyDigest: body.publicKeyDigest,
      cosign: nativeTool(body.cosign),
    });
  }
  exactKeys(body, ["scheme", "developerIdIdentity", "notaryKeychainProfile", "codesign", "ditto", "spctl", "xcrun"]);
  if (body.scheme !== "MACOS_DEVELOPER_ID" || typeof body.developerIdIdentity !== "string"
    || !SAFE_ID.test(body.developerIdIdentity) || typeof body.notaryKeychainProfile !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(body.notaryKeychainProfile)) invalid();
  return Object.freeze({
    scheme: body.scheme,
    developerIdIdentity: body.developerIdIdentity,
    notaryKeychainProfile: body.notaryKeychainProfile,
    codesign: nativeTool(body.codesign),
    ditto: nativeTool(body.ditto),
    spctl: nativeTool(body.spctl),
    xcrun: nativeTool(body.xcrun),
  });
}

function nativeTool(value: unknown): SteamDepotNativeTool {
  const body = record(value);
  exactKeys(body, ["path", "digest", "version"]);
  if (typeof body.path !== "string" || !absolute(body.path) || typeof body.digest !== "string" || !SHA256.test(body.digest)
    || typeof body.version !== "string" || !exactVersion(body.version)) invalid();
  return Object.freeze({ path: body.path, digest: body.digest, version: body.version });
}

function strictEndpoint(value: string): string {
  const url = strictHttps(value, new Set(["", "443", "8443", "9000"]));
  if (url.pathname !== "/") invalid();
  return url.href;
}
function strictHttpsUrl(value: string): string {
  const url = strictHttps(value, new Set(["", "443"]));
  return url.href;
}
function strictHttps(value: string, ports: ReadonlySet<string>): URL {
  let url: URL;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || !ports.has(url.port) || url.toString() !== value) invalid();
  return url;
}
function isPlatform(value: unknown): value is SteamTargetPlatform { return value === "windows" || value === "linux" || value === "macos"; }
function exactVersion(value: string): boolean { return VERSION.test(value) && !/(?:latest|stable|default)/i.test(value); }
function absolute(value: string): boolean { return isAbsolute(value) && resolve(value) === value && value.length <= 4_096 && !/[\0\r\n]/.test(value); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void { if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalid(); }
function invalid(): never { throw new Error("Steam depot native policy is invalid"); }

export function signingSchemeForPlatform(platform: SteamTargetPlatform): SteamDepotSigningScheme {
  return platform === "windows" ? "WINDOWS_AUTHENTICODE" : platform === "linux" ? "LINUX_SIGSTORE" : "MACOS_DEVELOPER_ID";
}
