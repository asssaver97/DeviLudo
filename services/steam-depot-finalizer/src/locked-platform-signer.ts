import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import type { SteamTargetPlatform } from "../../steam-publisher/src/contracts";
import type {
  SteamDepotPlatformSigner,
  SteamDepotSigningResult,
} from "./native-controller";
import {
  parseSteamDepotNativePolicy,
  signingSchemeForPlatform,
  steamDepotSigningIdentityDigest,
  type SteamDepotNativePolicy,
  type SteamDepotNativeTool,
} from "./native-policy";

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PUBLIC_EVIDENCE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 50 * 60_000;
const FORBIDDEN_OUTPUT = /api.?key|authorization|bearer|password|secret|token|config\.vdf|private.?key/i;

export interface SteamDepotNativeToolResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SteamDepotNativeToolProcess = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
) => Promise<SteamDepotNativeToolResult>;

/** Fixed-argv adapter for one policy-pinned host signing toolchain. */
export class LockedSteamDepotPlatformSigner implements SteamDepotPlatformSigner {
  readonly platform: SteamTargetPlatform;
  readonly signingScheme;
  readonly #policy: SteamDepotNativePolicy;
  readonly #process: SteamDepotNativeToolProcess;
  readonly #timeoutMs: number;

  constructor(options: Readonly<{
    policy: SteamDepotNativePolicy;
    process?: SteamDepotNativeToolProcess;
    timeoutMs?: number;
    hostPlatform?: NodeJS.Platform;
  }>) {
    this.#policy = parseSteamDepotNativePolicy(options.policy);
    this.platform = this.#policy.platform;
    this.signingScheme = signingSchemeForPlatform(this.platform);
    if (this.#policy.signer.scheme !== this.signingScheme) invalid("scheme");
    const hostPlatform = options.hostPlatform ?? process.platform;
    if (nodePlatform(hostPlatform) !== this.platform && options.process === undefined) invalid("host platform");
    this.#process = options.process ?? executeSteamDepotNativeTool;
    this.#timeoutMs = integer(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000, 55 * 60_000);
  }

  async probe(): Promise<void> {
    await Promise.all(nativeTools(this.#policy).map((tool) => verifyTool(tool)));
    if (this.#policy.signer.scheme === "LINUX_SIGSTORE") {
      await verifyFile(this.#policy.signer.publicKeyFile, this.#policy.signer.publicKeyDigest, 1024 * 1024, false);
    }
  }

  async sign(input: Parameters<SteamDepotPlatformSigner["sign"]>[0]): Promise<SteamDepotSigningResult> {
    if (input.request.platform !== this.platform) invalid("request platform");
    await this.probe();
    const exportRoot = await canonicalDirectory(input.exportRoot);
    const signingTarget = await canonicalTarget(input.signingTarget, exportRoot);
    const identityDigest = steamDepotSigningIdentityDigest(this.#policy.signer);
    if (this.#policy.signer.scheme === "WINDOWS_AUTHENTICODE") {
      const signing = await this.#run(this.#policy.signer.signtool, [
        "sign", "/fd", "SHA256", "/sha1", this.#policy.signer.certificateSha1,
        "/tr", this.#policy.signer.timestampUrl, "/td", "SHA256", signingTarget,
      ], exportRoot);
      const verification = await this.#run(this.#policy.signer.signtool, [
        "verify", "/pa", "/all", "/v", signingTarget,
      ], exportRoot);
      return Object.freeze({
        signingIdentityDigest: identityDigest,
        signingEvidence: evidence("deviludo.native-steam-depot-signing-evidence.v1", input.request.requestDigest,
          this.platform, this.signingScheme, identityDigest, this.#policy.signer.signtool.version, [signing, verification]),
        notarizationEvidence: null,
      });
    }
    if (this.#policy.signer.scheme === "LINUX_SIGSTORE") {
      const bundle = join(exportRoot, "DeviLudo.x86_64.sigstore.json");
      const signing = await this.#run(this.#policy.signer.cosign, [
        "sign-blob", "--yes", "--key", this.#policy.signer.signingKeyRef,
        "--tlog-upload=true", "--bundle", bundle, signingTarget,
      ], exportRoot);
      const bundleDigest = await boundedPublicJsonDigest(bundle);
      const verification = await this.#run(this.#policy.signer.cosign, [
        "verify-blob", "--key", this.#policy.signer.publicKeyFile, "--bundle", bundle, signingTarget,
      ], exportRoot);
      return Object.freeze({
        signingIdentityDigest: identityDigest,
        signingEvidence: evidence("deviludo.native-steam-depot-signing-evidence.v1", input.request.requestDigest,
          this.platform, this.signingScheme, identityDigest, this.#policy.signer.cosign.version,
          [signing, verification], { transparencyBundleDigest: bundleDigest }),
        notarizationEvidence: null,
      });
    }
    const archive = join(dirname(exportRoot), "notarization-submission.zip");
    try {
      const signing = await this.#run(this.#policy.signer.codesign, [
        "--force", "--options", "runtime", "--timestamp", "--sign",
        this.#policy.signer.developerIdIdentity, signingTarget,
      ], exportRoot);
      const verification = await this.#run(this.#policy.signer.codesign, [
        "--verify", "--deep", "--strict", "--verbose=2", signingTarget,
      ], exportRoot);
      const packaging = await this.#run(this.#policy.signer.ditto, [
        "-c", "-k", "--keepParent", signingTarget, archive,
      ], exportRoot);
      const notarization = await this.#run(this.#policy.signer.xcrun, [
        "notarytool", "submit", archive, "--keychain-profile", this.#policy.signer.notaryKeychainProfile,
        "--wait", "--output-format", "json",
      ], exportRoot);
      const notary = acceptedNotarization(notarization.stdout);
      const stapling = await this.#run(this.#policy.signer.xcrun, ["stapler", "staple", signingTarget], exportRoot);
      const assessment = await this.#run(this.#policy.signer.spctl, [
        "--assess", "--type", "execute", "--verbose=4", signingTarget,
      ], exportRoot);
      return Object.freeze({
        signingIdentityDigest: identityDigest,
        signingEvidence: evidence("deviludo.native-steam-depot-signing-evidence.v1", input.request.requestDigest,
          this.platform, this.signingScheme, identityDigest, this.#policy.signer.codesign.version,
          [signing, verification, stapling, assessment]),
        notarizationEvidence: evidence("deviludo.native-steam-depot-notarization-evidence.v1",
          input.request.requestDigest, this.platform, this.signingScheme, identityDigest,
          this.#policy.signer.xcrun.version, [packaging, notarization, stapling], { notarizationId: notary.id }),
      });
    } finally {
      await rm(archive, { force: true });
    }
  }

  async #run(tool: SteamDepotNativeTool, args: readonly string[], cwd: string): Promise<SteamDepotNativeToolResult> {
    const result = await this.#process(tool.path, Object.freeze([...args]), Object.freeze({
      cwd,
      env: controlledEnvironment(cwd),
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    }));
    if (!result || result.exitCode !== 0 || typeof result.stdout !== "string" || typeof result.stderr !== "string"
      || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES || Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES
      || FORBIDDEN_OUTPUT.test(`${result.stdout}\n${result.stderr}`)) invalid("tool result");
    return Object.freeze({ exitCode: 0, stdout: result.stdout, stderr: result.stderr });
  }
}

export function executeSteamDepotNativeTool(
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>,
): Promise<SteamDepotNativeToolResult> {
  return new Promise((accept) => {
    execFile(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      shell: false,
    }, (error, stdout, stderr) => accept(Object.freeze({
      exitCode: nativeExitCode(error),
      stdout: bounded(stdout),
      stderr: bounded(stderr),
    })));
  });
}

function evidence(
  schemaVersion: string,
  requestDigest: string,
  platform: SteamTargetPlatform,
  signingScheme: LockedSteamDepotPlatformSigner["signingScheme"],
  signingIdentityDigest: string,
  toolVersion: string,
  results: readonly SteamDepotNativeToolResult[],
  extension: Readonly<Record<string, string>> = {},
): Buffer {
  return Buffer.from(canonicalJson({
    schemaVersion,
    requestDigest,
    platform,
    signingScheme,
    status: "VERIFIED",
    signingIdentityDigest,
    toolVersion,
    verificationDigest: createHash("sha256").update(canonicalJson(results.map((result) => ({
      exitCode: result.exitCode,
      stdoutDigest: digest(Buffer.from(result.stdout)),
      stderrDigest: digest(Buffer.from(result.stderr)),
    })))).digest("hex"),
    ...extension,
  }));
}

async function boundedPublicJsonDigest(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_PUBLIC_EVIDENCE_BYTES) invalid("Sigstore bundle");
    const body = await file.readFile(); const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || FORBIDDEN_OUTPUT.test(body.toString("utf8"))) {
      invalid("Sigstore bundle");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString("utf8")) as unknown; } catch { invalid("Sigstore bundle"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("Sigstore bundle");
    return digest(body);
  } finally { await file.close(); }
}

function acceptedNotarization(value: string): Readonly<{ id: string }> {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { invalid("notarization response"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("notarization response");
  const body = parsed as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["id", "message", "status"].sort())
    || body.status !== "Accepted" || typeof body.id !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.id)
    || typeof body.message !== "string" || body.message.length > 1_024 || FORBIDDEN_OUTPUT.test(body.message)) {
    invalid("notarization response");
  }
  return Object.freeze({ id: body.id });
}

async function verifyTool(tool: SteamDepotNativeTool): Promise<void> {
  await verifyFile(tool.path, tool.digest, 1024 * 1024 * 1024, true);
}

async function verifyFile(path: string, expectedDigest: string, maximumBytes: number, executable: boolean): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes
    || executable && (metadata.mode & 0o111) === 0) invalid("runtime file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, metadata.size - position), position);
      if (bytesRead < 1) invalid("runtime file");
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || hash.digest("hex") !== expectedDigest) {
      invalid("runtime digest");
    }
  } finally { await file.close(); }
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) invalid("export root");
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("export root");
  return realpath(path);
}

async function canonicalTarget(path: string, root: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) invalid("signing target");
  const canonical = await realpath(path);
  if (!canonical.startsWith(`${root}${sep}`)) invalid("signing target boundary");
  const metadata = await lstat(canonical);
  if (metadata.isSymbolicLink() || !(metadata.isFile() || metadata.isDirectory())) invalid("signing target");
  return canonical;
}

function nativeTools(policy: SteamDepotNativePolicy): readonly SteamDepotNativeTool[] {
  return policy.signer.scheme === "WINDOWS_AUTHENTICODE" ? [policy.signer.signtool]
    : policy.signer.scheme === "LINUX_SIGSTORE" ? [policy.signer.cosign]
      : [policy.signer.codesign, policy.signer.ditto, policy.signer.spctl, policy.signer.xcrun];
}

function controlledEnvironment(root: string): NodeJS.ProcessEnv {
  return Object.freeze({
    NODE_ENV: "production",
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    PATH: "",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  });
}
function nodePlatform(value: NodeJS.Platform): SteamTargetPlatform | null {
  return value === "win32" ? "windows" : value === "linux" ? "linux" : value === "darwin" ? "macos" : null;
}
function bounded(value: string): string { return value.length <= MAX_OUTPUT_BYTES ? value : value.slice(0, MAX_OUTPUT_BYTES); }
function nativeExitCode(error: Error | null): number {
  if (!error) return 0;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) && code > 0 && code <= 255 ? code : 1;
}
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function integer(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("timeout"); return value; }
function invalid(label: string): never { throw new Error(`Locked Steam depot platform signer ${label} is invalid`); }
