import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, statfs } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentMicrovmCredentialImageRequest } from "./guest-credential-contracts";

const IMAGE_SIZE_BYTES = 8 * 1024 * 1024;
const IMAGE_BLOCKS = String(IMAGE_SIZE_BYTES / 4096);
const SHA256 = /^[a-f0-9]{64}$/;

export interface GuestCredentialStaticMaterial {
  readonly attestationPrivateKey: Buffer;
  readonly relayServerKey: Buffer;
  readonly relayServerCertificate: Buffer;
  readonly gatewayClientKey: Buffer;
  readonly gatewayClientCertificate: Buffer;
  readonly gatewayCa: Buffer;
  readonly ephemeralSecretClientKey: Buffer;
  readonly ephemeralSecretClientCertificate: Buffer;
  readonly ephemeralSecretCa: Buffer;
  readonly relayOrigin: string;
  readonly ephemeralSecretBrokerUrl: string;
}

export interface GuestCredentialImage {
  readonly image: Buffer;
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface GuestCredentialImageBuilder {
  build(request: AgentMicrovmCredentialImageRequest): Promise<GuestCredentialImage>;
  probe(): Promise<void>;
}

export type CredentialImageProcess = (executable: string, args: readonly string[], options: Readonly<{
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number;
}>) => Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;

/** Builds one no-journal ext4 drive in a private work root using one digest-pinned mke2fs. */
export class LockedExt4GuestCredentialImageBuilder implements GuestCredentialImageBuilder {
  readonly #workRoot: string;
  readonly #mke2fs: string;
  readonly #mke2fsDigest: string;
  readonly #material: GuestCredentialStaticMaterial;
  readonly #process: CredentialImageProcess;

  constructor(options: Readonly<{ workRoot: string; mke2fsExecutable: string; mke2fsDigest: string;
    material: GuestCredentialStaticMaterial; process?: CredentialImageProcess }>) {
    this.#workRoot = absolute(options.workRoot);
    this.#mke2fs = absolute(options.mke2fsExecutable);
    if (!SHA256.test(options.mke2fsDigest)) invalid();
    this.#mke2fsDigest = options.mke2fsDigest;
    validateMaterial(options.material);
    this.#material = options.material;
    this.#process = options.process ?? execute;
  }

  async build(request: AgentMicrovmCredentialImageRequest): Promise<GuestCredentialImage> {
    await Promise.all([privateRoot(this.#workRoot), verifyExecutable(this.#mke2fs, this.#mke2fsDigest)]);
    const attemptRoot = await mkdtemp(join(this.#workRoot, ".credential-image-"));
    const staging = join(attemptRoot, "staging");
    const imagePath = join(attemptRoot, "credentials.ext4");
    try {
      await mkdir(staging, { mode: 0o700 });
      const runtime = runtimeConfiguration(request, this.#material);
      await Promise.all([
        writeSensitive(join(staging, "guest-runtime.json"), Buffer.from(JSON.stringify(runtime))),
        writeSensitive(join(staging, "attestation-private.pem"), this.#material.attestationPrivateKey),
        writeSensitive(join(staging, "relay-server.key"), this.#material.relayServerKey),
        writeSensitive(join(staging, "relay-server.crt"), this.#material.relayServerCertificate),
        writeSensitive(join(staging, "inference-gateway-client.key"), this.#material.gatewayClientKey),
        writeSensitive(join(staging, "inference-gateway-client.crt"), this.#material.gatewayClientCertificate),
        writeSensitive(join(staging, "inference-gateway-ca.crt"), this.#material.gatewayCa),
        writeSensitive(join(staging, "ephemeral-secret-client.key"), this.#material.ephemeralSecretClientKey),
        writeSensitive(join(staging, "ephemeral-secret-client.crt"), this.#material.ephemeralSecretClientCertificate),
        writeSensitive(join(staging, "ephemeral-secret-ca.crt"), this.#material.ephemeralSecretCa),
      ]);
      await chmod(staging, 0o500);
      const output = await open(imagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await output.truncate(IMAGE_SIZE_BYTES); await output.sync(); } finally { await output.close(); }
      const result = await this.#process(this.#mke2fs, ["-q", "-t", "ext4", "-F", "-b", "4096", "-I", "256",
        "-m", "0", "-L", "DEVILUDO_CRED", "-U", filesystemUuid(request.nativeRequestDigest),
        "-O", "^has_journal,^orphan_file", "-d", staging, imagePath, IMAGE_BLOCKS], processOptions(attemptRoot));
      if (result.exitCode !== 0 || result.stdout || result.stderr) invalid();
      await chmod(imagePath, 0o400);
      const image = await readImage(imagePath);
      const digest = createHash("sha256").update(image).digest("hex");
      return Object.freeze({ image, digest, sizeBytes: image.byteLength });
    } finally {
      await chmod(staging, 0o700).catch(() => undefined);
      await rm(attemptRoot, { recursive: true, force: true });
    }
  }

  async probe(): Promise<void> {
    await Promise.all([privateRoot(this.#workRoot), verifyExecutable(this.#mke2fs, this.#mke2fsDigest)]);
    const result = await this.#process(this.#mke2fs, ["-V"], processOptions(this.#workRoot));
    if (result.exitCode !== 0 || result.stdout.length > 8_192 || result.stderr.length > 8_192) invalid();
  }
}

function runtimeConfiguration(request: AgentMicrovmCredentialImageRequest, material: GuestCredentialStaticMaterial) {
  return Object.freeze({
    DEVILUDO_EPHEMERAL_SECRET_BROKER_URL: material.ephemeralSecretBrokerUrl,
    DEVILUDO_EPHEMERAL_SECRET_CA_FILE: "/run/deviludo-credentials/ephemeral-secret-ca.crt",
    DEVILUDO_EPHEMERAL_SECRET_TLS_CERT_FILE: "/run/deviludo-credentials/ephemeral-secret-client.crt",
    DEVILUDO_EPHEMERAL_SECRET_TLS_KEY_FILE: "/run/deviludo-credentials/ephemeral-secret-client.key",
    DEVILUDO_MICROVM_GUEST_ATTESTATION_KEY_ID: request.attestationKeyId,
    DEVILUDO_MICROVM_GUEST_ATTESTATION_PRIVATE_KEY_FILE: "/run/deviludo-credentials/attestation-private.pem",
    DEVILUDO_MICROVM_GUEST_GATEWAY_CA_FILE: "/run/deviludo-credentials/inference-gateway-ca.crt",
    DEVILUDO_MICROVM_GUEST_GATEWAY_TLS_CERT_FILE: "/run/deviludo-credentials/inference-gateway-client.crt",
    DEVILUDO_MICROVM_GUEST_GATEWAY_TLS_KEY_FILE: "/run/deviludo-credentials/inference-gateway-client.key",
    DEVILUDO_MICROVM_GUEST_RELAY_ORIGIN: material.relayOrigin,
    DEVILUDO_MICROVM_GUEST_RELAY_TLS_CERT_FILE: "/run/deviludo-credentials/relay-server.crt",
    DEVILUDO_MICROVM_GUEST_RELAY_TLS_KEY_FILE: "/run/deviludo-credentials/relay-server.key",
    DEVILUDO_MICROVM_GUEST_REQUEST_DIGEST: request.nativeRequestDigest,
  });
}

async function writeSensitive(path: string, value: Buffer): Promise<void> {
  if (!Buffer.isBuffer(value) || value.byteLength < 2 || value.byteLength > 1024 * 1024) invalid();
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}
async function readImage(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== IMAGE_SIZE_BYTES || (metadata.mode & 0o022) !== 0) invalid();
    const image = await file.readFile();
    if (image.byteLength !== IMAGE_SIZE_BYTES || image.readUInt16LE(1024 + 56) !== 0xef53) invalid();
    return image;
  } finally { await file.close(); }
}
async function privateRoot(path: string): Promise<void> {
  const [metadata, canonical, filesystem] = await Promise.all([lstat(path), realpath(path), statfs(path)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== path || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) invalid();
  const fileSystemType = filesystem.type >>> 0;
  if (process.platform === "linux" && fileSystemType !== 0x01021994 && fileSystemType !== 0x858458f6) invalid();
}
async function verifyExecutable(path: string, digest: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 1024 * 1024 * 1024 || (metadata.mode & 0o022) !== 0) invalid();
    const bytes = await file.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== digest) invalid();
  } finally { await file.close(); }
}
function validateMaterial(value: GuestCredentialStaticMaterial): void {
  const buffers = [value.attestationPrivateKey, value.relayServerKey, value.relayServerCertificate,
    value.gatewayClientKey, value.gatewayClientCertificate, value.gatewayCa, value.ephemeralSecretClientKey,
    value.ephemeralSecretClientCertificate, value.ephemeralSecretCa];
  if (buffers.some((item) => !Buffer.isBuffer(item) || item.byteLength < 32 || item.byteLength > 1024 * 1024)) invalid();
  const relay = new URL(value.relayOrigin);
  const broker = new URL(value.ephemeralSecretBrokerUrl);
  if (relay.protocol !== "https:" || relay.hostname !== "127.0.0.1" || relay.port !== "8443"
    || relay.pathname !== "/" || relay.username || relay.password || relay.search || relay.hash
    || broker.protocol !== "https:" || broker.username || broker.password || broker.search || broker.hash
    || (broker.pathname !== "/" && broker.pathname !== "")) invalid();
}
function filesystemUuid(digest: string): string {
  const value = digest.slice(0, 32).split(""); value[12] = "4"; value[16] = "8";
  const joined = value.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
function processOptions(cwd: string) { return Object.freeze({ cwd,
  env: Object.freeze({ NODE_ENV: "production", PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", TZ: "UTC" }),
  timeoutMs: 30_000, maxOutputBytes: 32 * 1024 }); }
function execute(executable: string, args: readonly string[], options: Readonly<{
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number;
}>): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  return new Promise((accept) => execFile(executable, [...args], { cwd: options.cwd, env: options.env,
    encoding: "utf8", windowsHide: true, timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes, shell: false },
  (error, stdout, stderr) => accept(Object.freeze({ exitCode: error ? 1 : 0, stdout, stderr }))));
}
function absolute(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || value.includes("\0")) invalid();
  return value;
}
function invalid(): never { throw new Error("Agent microVM credential image builder is invalid"); }
