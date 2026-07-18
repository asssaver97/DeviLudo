import { createPublicKey } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TargetPlatform } from "../../../lib/domain/types";
import { SteamClientConnectorService } from "./connector";
import { createSteamClientConnectorHandler, createSteamClientConnectorHttpsServer } from "./ingress-http";
import { LockedNativeSteamClientExecutor } from "./locked-native-executor";

const SHA256 = /^[a-f0-9]{64}$/;

export async function steamClientConnectorServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtimePlatform: NodeJS.Platform = process.platform,
) {
  const platform = targetPlatform(required(env, "DEVILUDO_STEAM_CONNECTOR_PLATFORM"));
  if (platform !== targetPlatform(runtimePlatform)) throw new Error("Steam Client Connector platform does not match this host");
  const [jobKeyPem, tlsKey, tlsCertificate, tlsCa, stagingRoot, workRoot] = await Promise.all([
    safeFile(env, "DEVILUDO_STEAM_CONNECTOR_JOB_PUBLIC_KEY_FILE", 32, 1024 * 1024),
    safeFile(env, "DEVILUDO_STEAM_CONNECTOR_TLS_KEY_FILE", 32, 1024 * 1024),
    safeFile(env, "DEVILUDO_STEAM_CONNECTOR_TLS_CERT_FILE", 32, 1024 * 1024),
    safeFile(env, "DEVILUDO_STEAM_CONNECTOR_TLS_CA_FILE", 32, 1024 * 1024),
    safeDirectory(env, "DEVILUDO_STEAM_CONNECTOR_STAGING_ROOT"),
    safeDirectory(env, "DEVILUDO_STEAM_CONNECTOR_WORK_ROOT"),
  ]);
  const jobPublicKey = createPublicKey(jobKeyPem);
  const executor = new LockedNativeSteamClientExecutor({
    executable: requiredAbsolute(env, "DEVILUDO_STEAM_CONNECTOR_NATIVE_EXECUTABLE"),
    executableDigest: digest(env, "DEVILUDO_STEAM_CONNECTOR_NATIVE_EXECUTABLE_DIGEST"),
    workRoot,
    timeoutMs: seconds(env.DEVILUDO_STEAM_CONNECTOR_EXECUTION_TIMEOUT_SECONDS, 3_000, 30, 3_600) * 1_000,
  });
  const service = new SteamClientConnectorService({
    jobPublicKey,
    jobKeyId: safeId(env, "DEVILUDO_STEAM_CONNECTOR_JOB_KEY_ID"),
    runnerId: safeId(env, "DEVILUDO_STEAM_CONNECTOR_RUNNER_ID"),
    platform,
    stagingRoot,
    executor,
  });
  const handler = createSteamClientConnectorHandler({
    service,
    allowedSpiffeIds: spiffeIds(required(env, "DEVILUDO_STEAM_CONNECTOR_ALLOWED_SPIFFE_IDS")),
  });
  const server = createSteamClientConnectorHttpsServer({
    tls: { key: tlsKey, cert: tlsCertificate, ca: tlsCa },
    handler,
    requestTimeoutMs: seconds(env.DEVILUDO_STEAM_CONNECTOR_REQUEST_TIMEOUT_SECONDS, 3_300, 30, 3_600) * 1_000,
  });
  return Object.freeze({ service, executor, server });
}

export async function runSteamClientConnectorService(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const composed = await steamClientConnectorServiceFromEnv(env);
  await composed.service.probe();
  const host = env.DEVILUDO_STEAM_CONNECTOR_HOST?.trim() || "0.0.0.0";
  const port = integer(env.DEVILUDO_STEAM_CONNECTOR_PORT, 4_843, 1, 65_535);
  await new Promise<void>((accept, reject) => {
    composed.server.once("error", reject);
    composed.server.listen(port, host, () => { composed.server.off("error", reject); accept(); });
  });
  process.stdout.write("[steam-client-connector] READY\n");
  const shutdown = () => composed.server.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function targetPlatform(value: string): TargetPlatform {
  if (value === "win32" || value === "windows") return "windows";
  if (value === "linux") return "linux";
  if (value === "darwin" || value === "macos") return "macos";
  throw new Error("Steam Client Connector platform is invalid");
}

async function safeFile(env: Readonly<Record<string, string | undefined>>, name: string, minimum: number, maximum: number): Promise<Buffer> {
  const path = requiredAbsolute(env, name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < minimum || metadata.size > maximum) throw new Error(`${name} file is invalid`);
  return readFile(path);
}

async function safeDirectory(env: Readonly<Record<string, string | undefined>>, name: string): Promise<string> {
  const path = requiredAbsolute(env, name);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${name} directory is invalid`);
  return realpath(path);
}

function requiredAbsolute(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) throw new Error(`${name} path is invalid`);
  return value;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function digest(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!SHA256.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function safeId(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function spiffeIds(value: string): ReadonlySet<string> {
  const ids = value.split(",").map((item) => item.trim());
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => {
    try {
      const url = new URL(id);
      return url.protocol !== "spiffe:" || !url.hostname || url.username !== "" || url.password !== ""
        || url.search !== "" || url.hash !== "" || url.pathname === "/";
    } catch { return true; }
  })) throw new Error("Steam Client Connector SPIFFE allow-list is invalid");
  return new Set(ids);
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  return integer(value, fallback, minimum, maximum);
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) throw new Error("Steam Client Connector integer is invalid");
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSteamClientConnectorService();
}
