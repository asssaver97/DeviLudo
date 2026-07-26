import { createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalJson } from "../../services/runner-control/src/canonical.ts";
import { MtlsSteamDepotFinalizerHostActivationClient } from "../../services/steam-depot-finalizer/src/host-activation-client.ts";

const MAX_SECRET_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;

export async function steamDepotFinalizerHostActivationClientFromEnv(env = process.env, dependencies = {}) {
  const [key, certificate, ca, trust] = await Promise.all([
    readSecureFile(requiredAbsoluteEnvironment(env,
      "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_CLIENT_TLS_KEY_FILE"), MAX_SECRET_BYTES),
    readSecureFile(requiredAbsoluteEnvironment(env,
      "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_CLIENT_TLS_CERT_FILE"), MAX_SECRET_BYTES),
    readSecureFile(requiredAbsoluteEnvironment(env,
      "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_CLIENT_TLS_CA_FILE"), MAX_SECRET_BYTES),
    steamDepotFinalizerHostActivationTrustFromEnv(env),
  ]);
  return new MtlsSteamDepotFinalizerHostActivationClient({
    endpoint: requiredEnvironment(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_AUTHORITY_URL"),
    tls: { key, certificate, ca },
    publicKey: trust.publicKey,
    keyId: trust.keyId,
    timeoutMs: boundedInteger(env.DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_REQUEST_TIMEOUT_MS,
      30_000, 1_000, 60_000),
    ...(dependencies.http === undefined ? {} : { http: dependencies.http }),
  });
}

export async function steamDepotFinalizerHostActivationTrustFromEnv(env = process.env) {
  const publicKeyBytes = await readSecureFile(requiredAbsoluteEnvironment(env,
    "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_PUBLIC_KEY_FILE"), 16 * 1024);
  let publicKey;
  try { publicKey = createPublicKey(publicKeyBytes); } catch { invalid(); }
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") invalid();
  const keyId = requiredEnvironment(env, "DEVILUDO_STEAM_DEPOT_FINALIZER_HOST_ACTIVATION_KEY_ID");
  if (!SAFE_ID.test(keyId)) invalid();
  return Object.freeze({ publicKey, keyId });
}

export async function readSecureJson(path, maximum = 1024 * 1024) {
  const body = await readSecureFile(path, maximum);
  try { return JSON.parse(body.toString("utf8")); } catch { invalid(); }
}

export async function readSecureFile(path, maximum) {
  if (!absolute(path) || !Number.isSafeInteger(maximum) || maximum < 2 || maximum > 1024 * 1024 * 1024) invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > maximum) invalid();
    const body = await file.readFile();
    const after = await file.stat();
    if (body.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    return body;
  } finally { await file.close(); }
}

export async function createOnlyCanonicalJson(path, value) {
  if (!absolute(path)) invalid();
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  const body = `${canonicalJson(value)}\n`;
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try { await file.writeFile(body, "utf8"); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST" || canonicalJson(await readSecureJson(path)) !== canonicalJson(value)) throw error;
  }
}

export function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  if (!value || /[\0\r\n]/.test(value)) invalid();
  return value;
}
export function requiredAbsoluteEnvironment(env, name) {
  const value = requiredEnvironment(env, name);
  if (!absolute(value)) invalid();
  return value;
}
export function absolute(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value
    && value.length <= 4_096 && !/[\0\r\n]/.test(value);
}
function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) invalid();
  return parsed;
}
function invalid() { throw new Error("Steam depot Finalizer host activation client input is invalid"); }
