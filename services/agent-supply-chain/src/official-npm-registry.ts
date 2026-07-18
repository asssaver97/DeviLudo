import { createHash, createPublicKey, createVerify } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { AgentKind } from "../../control-plane/src/contracts";
import type { NativeAgentSupplyChainPolicy } from "./native-policy-config";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;

export interface OfficialAgentRelease {
  readonly agent: AgentKind;
  readonly packageName: "@anthropic-ai/claude-code" | "@openai/codex";
  readonly version: string;
  readonly tarballUrl: string;
  readonly integrity: string;
  readonly signatureKeyIds: readonly string[];
  readonly sourceDigest: string;
}

export interface VerifiedAgentPackage {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly sha512Base64: string;
}

export interface OfficialNpmTransport {
  getJson(url: URL, maximumBytes: number): Promise<unknown>;
  download(url: URL, destinationPath: string, maximumBytes: number): Promise<VerifiedAgentPackage>;
  probe(): Promise<void>;
}

export class OfficialPackagePolicyError extends Error {
  constructor(readonly code: "SIGNATURE_INVALID" | "INTEGRITY_MISMATCH", readonly evidenceDigest: string) {
    super("Official Agent package failed policy");
    this.name = "OfficialPackagePolicyError";
  }
}

/** Fixed-host NPM catalog and package verifier. No registry credential exists. */
export class OfficialNpmAgentRegistry {
  readonly #transport: OfficialNpmTransport;
  readonly #now: () => Date;

  constructor(
    private readonly policy: NativeAgentSupplyChainPolicy,
    options: Readonly<{ transport?: OfficialNpmTransport; now?: () => Date }> = {},
  ) {
    this.#transport = options.transport ?? new PinnedOfficialNpmTransport();
    this.#now = options.now ?? (() => new Date());
  }

  async probe(): Promise<void> { await this.#transport.probe(); }

  async resolve(agent: AgentKind, requestedVersion: string | null): Promise<OfficialAgentRelease> {
    const packageName = this.policy.agents[agent].packageName;
    let version = requestedVersion;
    if (version === null) {
      const catalog = record(await this.#transport.getJson(registryUrl(packageName), MAX_METADATA_BYTES));
      const tags = record(catalog["dist-tags"]);
      if (typeof tags.latest !== "string" || !exactVersion(tags.latest)) invalid();
      version = tags.latest;
    }
    if (!exactVersion(version)) invalid();
    const metadata = record(await this.#transport.getJson(registryUrl(packageName, version), MAX_METADATA_BYTES));
    if (metadata.name !== packageName || metadata.version !== version) invalid();
    const dist = record(metadata.dist);
    const tarballUrl = officialTarball(agent, version);
    if (dist.tarball !== tarballUrl || typeof dist.integrity !== "string" || !SHA512_INTEGRITY.test(dist.integrity)) invalid();
    const signatures = signatureSet(dist.signatures);
    await this.#verifyRegistrySignature(packageName, version, dist.integrity, signatures);
    const signatureKeyIds = Object.freeze(signatures.map((signature) => signature.keyid).sort());
    const sourceDigest = sha256Canonical({ packageName, version, tarballUrl, integrity: dist.integrity, signatures });
    return Object.freeze({ agent, packageName, version, tarballUrl, integrity: dist.integrity, signatureKeyIds, sourceDigest });
  }

  async download(release: OfficialAgentRelease, destinationPath: string): Promise<VerifiedAgentPackage> {
    const artifact = await this.#transport.download(new URL(release.tarballUrl), destinationPath, this.policy.maxPackageBytes);
    const expected = SHA512_INTEGRITY.exec(release.integrity)?.[1];
    if (!expected || artifact.sha512Base64 !== expected) {
      throw new OfficialPackagePolicyError("INTEGRITY_MISMATCH", sha256Canonical({ release, artifact }));
    }
    return artifact;
  }

  async #verifyRegistrySignature(
    packageName: string,
    version: string,
    integrity: string,
    signatures: readonly NpmSignature[],
  ): Promise<void> {
    const keysPayload = record(await this.#transport.getJson(new URL("https://registry.npmjs.org/-/npm/v1/keys"), MAX_METADATA_BYTES));
    if (!Array.isArray(keysPayload.keys)) invalid();
    const keys = keysPayload.keys.map(npmKey);
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) invalid();
    const signed = `${packageName}@${version}:${integrity}`;
    const valid = signatures.some((signature) => {
      if (!this.policy.trustedNpmKeyIds.includes(signature.keyid)) return false;
      const key = keys.find((candidate) => candidate.keyid === signature.keyid);
      if (!key || key.expires !== null && Date.parse(key.expires) <= now.getTime()) return false;
      try {
        const verifier = createVerify("SHA256");
        verifier.update(signed, "utf8");
        verifier.end();
        return verifier.verify(createPublicKey({ key: Buffer.from(key.key, "base64"), format: "der", type: "spki" }), Buffer.from(signature.sig, "base64"));
      } catch { return false; }
    });
    if (!valid) {
      throw new OfficialPackagePolicyError("SIGNATURE_INVALID", sha256Canonical({ packageName, version, integrity, signatures }));
    }
  }
}

type NpmSignature = Readonly<{ keyid: string; sig: string }>;
type NpmKey = Readonly<{ keyid: string; key: string; expires: string | null }>;

function signatureSet(value: unknown): readonly NpmSignature[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) invalid();
  const result = value.map((item) => {
    const signature = record(item);
    if (typeof signature.keyid !== "string" || signature.keyid.length < 16 || signature.keyid.length > 256
      || typeof signature.sig !== "string" || !SIGNATURE.test(signature.sig)) invalid();
    return Object.freeze({ keyid: signature.keyid, sig: signature.sig });
  }).sort((left, right) => left.keyid.localeCompare(right.keyid));
  if (new Set(result.map((item) => item.keyid)).size !== result.length) invalid();
  return Object.freeze(result);
}

function npmKey(value: unknown): NpmKey {
  const key = record(value);
  if (typeof key.keyid !== "string" || key.keyid.length < 16 || key.keyid.length > 256
    || typeof key.key !== "string" || !SIGNATURE.test(key.key)
    || key.expires !== null && (typeof key.expires !== "string" || !Number.isFinite(Date.parse(key.expires)))) invalid();
  const encodedKey = Buffer.from(key.key, "base64");
  if (`SHA256:${createHash("sha256").update(encodedKey).digest("base64")}` !== key.keyid) invalid();
  return Object.freeze({ keyid: key.keyid, key: key.key, expires: key.expires as string | null });
}

export class PinnedOfficialNpmTransport implements OfficialNpmTransport {
  async probe(): Promise<void> {
    const addresses = await resolvePublic("registry.npmjs.org");
    if (!addresses.length) invalid();
  }

  async getJson(url: URL, maximumBytes: number): Promise<unknown> {
    const response = await requestPinned(url);
    if (response.statusCode !== 200 || !String(response.headers["content-type"] ?? "").toLowerCase().includes("json")) {
      response.destroy(); invalid();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.byteLength;
      if (size > maximumBytes) { response.destroy(); invalid(); }
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { invalid(); }
  }

  async download(url: URL, destinationPath: string, maximumBytes: number): Promise<VerifiedAgentPackage> {
    const response = await requestPinned(url);
    if (response.statusCode !== 200) { response.destroy(); invalid(); }
    const file = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    const sha256 = createHash("sha256");
    const sha512 = createHash("sha512");
    let sizeBytes = 0;
    let complete = false;
    try {
      for await (const value of response) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > maximumBytes) { response.destroy(); invalid(); }
        sha256.update(chunk); sha512.update(chunk);
        await writeAll(file, chunk);
      }
      if (sizeBytes < 512) invalid();
      await file.sync();
      complete = true;
    } finally {
      await file.close();
      if (!complete) await unlink(destinationPath).catch(() => undefined);
    }
    return Object.freeze({
      path: destinationPath,
      sizeBytes,
      sha256: sha256.digest("hex"),
      sha512Base64: sha512.digest("base64"),
    });
  }
}

async function requestPinned(url: URL) {
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port || url.username || url.password
    || url.search || url.hash) invalid();
  const [selected] = await resolvePublic(url.hostname);
  if (!selected) invalid();
  const options: RequestOptions = {
    method: "GET",
    hostname: url.hostname,
    servername: url.hostname,
    path: url.pathname,
    minVersion: "TLSv1.3",
    rejectUnauthorized: true,
    headers: { accept: "application/json, application/octet-stream", "user-agent": "DeviLudo-Agent-Supply-Chain/1" },
    lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
      callback(null, selected.address, selected.family);
    }) as RequestOptions["lookup"],
  };
  return new Promise<import("node:http").IncomingMessage>((accept, reject) => {
    const request = httpsRequest(options, accept);
    request.setTimeout(30_000, () => request.destroy(new Error("Official NPM request timed out")));
    request.once("error", reject);
    request.end();
  });
}

async function resolvePublic(hostname: string): Promise<readonly { address: string; family: 4 | 6 }[]> {
  if (hostname !== "registry.npmjs.org") invalid();
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !publicIp(entry.address))) invalid();
  return Object.freeze(addresses.map((entry) => Object.freeze({ address: entry.address, family: entry.family as 4 | 6 })));
}

function publicIp(value: string): boolean {
  const family = isIP(value);
  if (family === 4) {
    const bytes = value.split(".").map(Number);
    const [a, b] = bytes;
    return bytes.length === 4 && bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
      && a !== 0 && a !== 10 && a !== 127 && a! < 224
      && !(a === 100 && b! >= 64 && b! <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b! >= 16 && b! <= 31)
      && !(a === 192 && (b === 0 || b === 168)) && !(a === 192 && b === 0 && bytes[2] === 2)
      && !(a === 198 && (b === 18 || b === 19 || b === 51 && bytes[2] === 100))
      && !(a === 203 && b === 0 && bytes[2] === 113);
  }
  if (family !== 6) return false;
  const lower = value.toLowerCase();
  if (lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd")
    || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("2001:db8")) return false;
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return !mapped || publicIp(mapped[1]!);
}

function registryUrl(packageName: string, version?: string): URL {
  const encoded = encodeURIComponent(packageName);
  return new URL(`https://registry.npmjs.org/${encoded}${version ? `/${version}` : ""}`);
}

function officialTarball(agent: AgentKind, version: string): string {
  return agent === "claude-code"
    ? `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`
    : `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`;
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, value: Buffer): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
    if (bytesWritten < 1) invalid();
    offset += bytesWritten;
  }
}

function exactVersion(value: string): boolean { return VERSION.test(value) && !/(?:latest|stable|default)/i.test(value); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function invalid(): never { throw new Error("Official NPM Agent registry response is invalid"); }
