import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../runner-control/src/canonical";
import { parseSteamDepotFinalizationRequest } from "./contract";
import { LockedSteamDepotPlatformSigner, type SteamDepotNativeToolProcess } from "./locked-platform-signer";
import { NativeSteamDepotController } from "./native-controller";
import {
  parseSteamDepotNativePolicy,
  signingSchemeForPlatform,
  type SteamDepotNativePolicy,
} from "./native-policy";
import {
  S3SteamDepotArtifactStore,
  type SteamDepotS3Http,
} from "./s3-artifact-store";

const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 1024 * 1024;

export type SteamDepotNativeCommand =
  | Readonly<{ kind: "PROBE"; policyFile: string }>
  | Readonly<{ kind: "FINALIZE"; policyFile: string; requestFile: string; receiptFile: string }>;

export function parseSteamDepotNativeCommand(argv: readonly string[]): SteamDepotNativeCommand {
  if (argv[0] === "probe" && argv.length === 4 && argv[1] === "--policy-file" && argv[3] === "--json") {
    return Object.freeze({ kind: "PROBE", policyFile: absolute(argv[2]) });
  }
  if (argv[0] === "finalize" && argv.length === 7 && argv[1] === "--policy-file"
    && argv[3] === "--request-file" && argv[5] === "--receipt-file") {
    const requestFile = absolute(argv[4]); const receiptFile = absolute(argv[6]);
    if (requestFile === receiptFile) invalid("arguments");
    return Object.freeze({
      kind: "FINALIZE",
      policyFile: absolute(argv[2]),
      requestFile,
      receiptFile,
    });
  }
  invalid("arguments");
}

export async function steamDepotNativeRuntimeFromPolicyFile(
  policyFile: string,
  dependencies: Readonly<{
    s3Http?: SteamDepotS3Http;
    toolProcess?: SteamDepotNativeToolProcess;
    hostPlatform?: NodeJS.Platform;
  }> = {},
) {
  const loaded = await loadCanonicalPolicy(policyFile);
  const [secretAccessKeyFile, ca] = await Promise.all([
    boundedFile(loaded.policy.artifactStore.secretAccessKeyFile, 16, 256),
    boundedFile(loaded.policy.artifactStore.caFile, 32, MAX_SECRET_BYTES),
  ]);
  const secretAccessKey = Buffer.from(secretAccessKeyFile.toString("utf8").trim(), "utf8");
  secretAccessKeyFile.fill(0);
  if (secretAccessKey.byteLength < 16 || secretAccessKey.byteLength > 256) {
    secretAccessKey.fill(0); ca.fill(0); invalid("S3 credential");
  }
  try {
    const artifacts = new S3SteamDepotArtifactStore({
      endpoint: loaded.policy.artifactStore.endpoint,
      bucket: loaded.policy.artifactStore.bucket,
      region: loaded.policy.artifactStore.region,
      accessKeyId: loaded.policy.artifactStore.accessKeyId,
      secretAccessKey,
      ca,
      ...(dependencies.s3Http ? { http: dependencies.s3Http } : {}),
    });
    const signer = new LockedSteamDepotPlatformSigner({
      policy: loaded.policy,
      ...(dependencies.toolProcess ? { process: dependencies.toolProcess } : {}),
      ...(dependencies.hostPlatform ? { hostPlatform: dependencies.hostPlatform } : {}),
    });
    return Object.freeze({
      policy: loaded.policy,
      policyDigest: loaded.policyDigest,
      controller: new NativeSteamDepotController({ artifacts, signer, workRoot: loaded.policy.workRoot }),
    });
  } finally {
    secretAccessKey.fill(0);
    ca.fill(0);
  }
}

export async function executeSteamDepotNativeCommand(
  command: SteamDepotNativeCommand,
  dependencies: Parameters<typeof steamDepotNativeRuntimeFromPolicyFile>[1] = {},
): Promise<string | null> {
  const runtime = await steamDepotNativeRuntimeFromPolicyFile(command.policyFile, dependencies);
  if (command.kind === "PROBE") {
    await runtime.controller.probe();
    return canonicalJson({
      schemaVersion: "deviludo.native-steam-depot-finalizer-probe.v1",
      status: "READY",
      policyDigest: runtime.policyDigest,
      supportedSchemes: [signingSchemeForPlatform(runtime.policy.platform)],
    });
  }
  await assertCommandFilesInWorkingDirectory(command.requestFile, command.receiptFile);
  const request = parseSteamDepotFinalizationRequest(await readJson(command.requestFile, MAX_REQUEST_BYTES));
  if (request.platform !== runtime.policy.platform) invalid("request platform");
  const receipt = await runtime.controller.finalize(request);
  await writeImmutable(command.receiptFile, Buffer.from(canonicalJson(receipt)));
  return null;
}

async function loadCanonicalPolicy(path: string): Promise<Readonly<{ policy: SteamDepotNativePolicy; policyDigest: string }>> {
  const body = await boundedFile(absolute(path), 2, MAX_POLICY_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")) as unknown; } catch { invalid("policy JSON"); }
  const policy = parseSteamDepotNativePolicy(parsed);
  const canonical = Buffer.from(canonicalJson(policy));
  if (!body.equals(canonical)) invalid("policy canonical form");
  return Object.freeze({ policy, policyDigest: digest(body) });
}

async function assertCommandFilesInWorkingDirectory(requestFile: string, receiptFile: string): Promise<void> {
  const cwd = await realpath(process.cwd());
  const requestParent = await realpath(dirname(requestFile));
  const receiptParent = await realpath(dirname(receiptFile));
  if (requestParent !== cwd || receiptParent !== cwd
    || !requestFile.startsWith(`${cwd}${sep}`) || !receiptFile.startsWith(`${cwd}${sep}`)) invalid("command boundary");
  const requestMetadata = await lstat(requestFile);
  if (!requestMetadata.isFile() || requestMetadata.isSymbolicLink()) invalid("request file");
  try { await lstat(receiptFile); invalid("receipt replay"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function readJson(path: string, maximum: number): Promise<unknown> {
  const body = await boundedFile(path, 2, maximum);
  try { return JSON.parse(body.toString("utf8")) as unknown; } catch { invalid("request JSON"); }
}

async function boundedFile(path: string, minimum: number, maximum: number): Promise<Buffer> {
  const file = await open(absolute(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < minimum || before.size > maximum) invalid("runtime file");
    const body = await file.readFile(); const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid("runtime mutation");
    return body;
  } finally { await file.close(); }
}

async function writeImmutable(path: string, body: Buffer): Promise<void> {
  const file = await open(absolute(path), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
}

function absolute(value: string | undefined): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
    || value.length > 4_096 || /[\0\r\n]/.test(value)) invalid("path");
  return value;
}
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function invalid(label: string): never { throw new Error(`Steam depot native controller ${label} is invalid`); }

async function main(): Promise<void> {
  const output = await executeSteamDepotNativeCommand(parseSteamDepotNativeCommand(process.argv.slice(2)));
  if (output !== null) process.stdout.write(`${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("[steam-depot-finalizer-native] execution failed\n");
    process.exitCode = 1;
  });
}
