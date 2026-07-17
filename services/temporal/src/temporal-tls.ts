import { readFile } from "node:fs/promises";
import type { TLSConfig } from "@temporalio/client";

export async function temporalTlsConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TLSConfig | undefined> {
  const allowInsecure = env.DEVILUDO_ALLOW_INSECURE_LOCAL_TEMPORAL === "1";
  if (allowInsecure) {
    if (env.NODE_ENV === "production") throw new Error("Production Temporal connections cannot disable TLS");
    return undefined;
  }
  const paths = [
    env.DEVILUDO_TEMPORAL_TLS_CA_FILE?.trim(),
    env.DEVILUDO_TEMPORAL_TLS_CERT_FILE?.trim(),
    env.DEVILUDO_TEMPORAL_TLS_KEY_FILE?.trim(),
  ] as const;
  if (paths.every((path) => !path)) {
    if (env.NODE_ENV === "production") throw new Error("Production Temporal mTLS material is required");
    return undefined;
  }
  if (paths.some((path) => !path)) throw new Error("Temporal mTLS material is incomplete");
  const serverNameOverride = env.DEVILUDO_TEMPORAL_TLS_SERVER_NAME?.trim();
  if (serverNameOverride && (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(serverNameOverride)
    || serverNameOverride.includes(".."))) {
    throw new Error("Temporal TLS server name is invalid");
  }
  const [serverRootCACertificate, crt, key] = await Promise.all(
    paths.map((path) => readPem(path as string)),
  );
  return Object.freeze({
    serverRootCACertificate,
    clientCertPair: Object.freeze({ crt, key }),
    ...(serverNameOverride ? { serverNameOverride } : {}),
  });
}

async function readPem(path: string): Promise<Buffer> {
  if (!path.startsWith("/") || path.length > 4_096 || /\0/.test(path)) {
    throw new Error("Temporal TLS material path is invalid");
  }
  const value = await readFile(path);
  if (value.byteLength < 32 || value.byteLength > 1024 * 1024) {
    throw new Error("Temporal TLS material file is invalid");
  }
  return value;
}
