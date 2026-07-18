import { createPrivateKey } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import { ephemeralRunTokenSecretResolverFromEnv } from "./ephemeral-secret-client";
import { nativeGuestInferenceRelayFromEnv } from "./native-inference-relay";
import { Ed25519GuestCandidateArtifactSigner, NativeMicrovmAgentGuest } from "./native-microvm-guest";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 150 * 1024 * 1024;

/** Entry point packaged into the immutable Linux guest image, never run by the Web process. */
export async function runNativeMicrovmGuestService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runRoot = await directory(env, "DEVILUDO_MICROVM_GUEST_RUN_ROOT");
  const workspaceRoot = await directory(env, "DEVILUDO_MICROVM_GUEST_WORKSPACE_ROOT");
  const requestFile = child(runRoot, required(env, "DEVILUDO_MICROVM_GUEST_REQUEST_FILE"));
  const responseFile = child(runRoot, required(env, "DEVILUDO_MICROVM_GUEST_RESPONSE_FILE"));
  if (!workspaceRoot.startsWith(`${runRoot}${sep}`) || requestFile === responseFile) invalid();
  const [requestBytes, privateKeyBytes, resolver] = await Promise.all([
    readBounded(requestFile, MAX_REQUEST_BYTES),
    readBounded(absolute(env, "DEVILUDO_MICROVM_GUEST_ATTESTATION_PRIVATE_KEY_FILE"), 1024 * 1024),
    ephemeralRunTokenSecretResolverFromEnv(env),
  ]);
  const relay = await nativeGuestInferenceRelayFromEnv(resolver, env);
  const privateKey = createPrivateKey(privateKeyBytes);
  const signer = new Ed25519GuestCandidateArtifactSigner(privateKey,
    safeId(env, "DEVILUDO_MICROVM_GUEST_ATTESTATION_KEY_ID"));
  const guest = new NativeMicrovmAgentGuest({ relay, signer });
  const result = await guest.execute(parseJson(requestBytes), { runRoot, workspaceRoot });
  const bytes = Buffer.from(canonicalJson(result));
  if (bytes.byteLength < 64 || bytes.byteLength > MAX_RESPONSE_BYTES) invalid();
  const output = await open(responseFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await output.writeFile(bytes); await output.sync(); }
  finally { await output.close(); }
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < 2 || metadata.size > maximum) invalid();
    return await file.readFile(); } finally { await file.close(); }
}
async function directory(env: Readonly<Record<string, string | undefined>>, name: string): Promise<string> {
  const value = absolute(env, name); const canonical = await realpath(value); if (canonical !== value) invalid();
  const file = await open(value, constants.O_RDONLY | constants.O_NOFOLLOW); try { if (!(await file.stat()).isDirectory()) invalid(); }
  finally { await file.close(); } return canonical;
}
function child(root: string, value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || !value.startsWith(`${root}${sep}`) || value.length > 4_096 || value.includes("\0")) invalid();
  return value;
}
function absolute(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name); if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || value.includes("\0")) invalid(); return value;
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) invalid(); return value; }
function safeId(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = required(env, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(value)) invalid(); return value; }
function parseJson(value: Buffer): unknown { try { return JSON.parse(value.toString("utf8")) as unknown; } catch { invalid(); } }
function invalid(): never { throw new Error("Native Agent microVM guest service configuration is invalid"); }

if (process.argv[1]?.endsWith("run-native-microvm-guest-service.ts")) {
  runNativeMicrovmGuestService().catch(() => { process.exitCode = 1; });
}
