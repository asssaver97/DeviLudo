import { CORE_ROLES, type CoreRole } from "./contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isServerPoolKind, SERVER_POOL_KINDS, type ServerPoolKind } from "@/lib/runtime/server-pools";

export const ACCESS_MODES = ["standalone", "platform"] as const;
export type AccessMode = typeof ACCESS_MODES[number];

export type CoreConfig = Readonly<{
  role: CoreRole;
  port: number;
  databaseUrl: string;
  databaseRole: "deviludo_api" | "deviludo_scheduler" | "deviludo_sandbox";
  setDatabaseRole: boolean;
  webToken: string;
  e2eDevelopmentToken: string | null;
  pollMilliseconds: number;
  projectDocumentIdleSeconds: number;
  assetGenerationPollMilliseconds: number;
  requiredReadyPools: readonly ServerPoolKind[];
  tlsCertificateFile: string | null;
  tlsKeyFile: string | null;
  tlsClientCaFile: string | null;
  accessMode: AccessMode;
  platformAccountApiUrl: string | null;
  platformInternalToken: string | null;
  projectsRoot: string;
}>;

export function loadCoreConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const role = env.DEVILUDO_CORE_ROLE ?? "";
  if (!(CORE_ROLES as readonly string[]).includes(role)) {
    throw new Error("DEVILUDO_CORE_ROLE must be api, scheduler, or sandbox");
  }
  const typedRole = role as CoreRole;
  const databaseKey = `DEVILUDO_CORE_${typedRole.toUpperCase()}_DATABASE_URL`;
  const databaseUrl = secretValue(env, databaseKey);
  if (!databaseUrl) throw new Error(`${databaseKey} is required`);
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || url.pathname.length < 2) {
    throw new Error("Core database URL is invalid");
  }
  const port = parseInteger(env.PORT ?? "8080", 1, 65535, "PORT");
  const pollMilliseconds = parseInteger(env.DEVILUDO_CORE_POLL_MS ?? "500", 50, 60_000, "DEVILUDO_CORE_POLL_MS");
  const projectDocumentIdleSeconds = parseInteger(
    env.DEVILUDO_PROJECT_DOCUMENT_IDLE_SECONDS ?? "86400",
    60,
    2_592_000,
    "DEVILUDO_PROJECT_DOCUMENT_IDLE_SECONDS",
  );
  // Asset generation sweeps on its own cadence rather than the sub-second
  // scheduler tick: each item takes tens of seconds of provider time, so claiming
  // more often would only add database churn.
  const assetGenerationPollMilliseconds = parseInteger(
    env.DEVILUDO_ASSET_GENERATION_POLL_SECONDS ?? "15",
    1,
    3_600,
    "DEVILUDO_ASSET_GENERATION_POLL_SECONDS",
  ) * 1_000;
  const webToken = secretValue(env, "DEVILUDO_WEB_CORE_TOKEN");
  if (typedRole === "api" && env.NODE_ENV === "production" && webToken.length < 32) {
    throw new Error("The Web-to-Core token is required in production");
  }
  const e2eDevelopmentToken = env.NODE_ENV === "production"
    ? null
    : env.DEVILUDO_E2E_NODE_TOKEN ?? "local-e2e-node-token";
  const defaultReadyPools = env.NODE_ENV === "production"
    ? SERVER_POOL_KINDS.join(",")
    : "WEB,CORE,E2E_MACOS";
  const requiredReadyPools = (env.DEVILUDO_REQUIRED_READY_POOLS ?? defaultReadyPools)
    .split(",")
    .map(value => value.trim())
    .filter(isServerPoolKind);
  if (requiredReadyPools.length < 1
    || new Set(requiredReadyPools).size !== requiredReadyPools.length) {
    throw new Error("DEVILUDO_REQUIRED_READY_POOLS is invalid");
  }
  const tlsCertificateFile = env.DEVILUDO_CORE_TLS_CERT_FILE ?? null;
  const tlsKeyFile = env.DEVILUDO_CORE_TLS_KEY_FILE ?? null;
  const tlsClientCaFile = env.DEVILUDO_CORE_TLS_CLIENT_CA_FILE ?? null;
  if (env.NODE_ENV === "production" && (![tlsCertificateFile, tlsKeyFile, tlsClientCaFile].every(value => value?.startsWith("/")))) {
    throw new Error("Production Core API requires TLS certificate, key, and E2E client CA files");
  }
  const configuredAccessMode = env.DEVILUDO_ACCESS_MODE?.trim();
  if (env.NODE_ENV === "production" && !configuredAccessMode) {
    throw new Error("DEVILUDO_ACCESS_MODE must be explicitly configured in production");
  }
  const accessMode = configuredAccessMode || "standalone";
  if (!(ACCESS_MODES as readonly string[]).includes(accessMode)) {
    throw new Error("DEVILUDO_ACCESS_MODE must be standalone or platform");
  }
  const platformAccountApiUrl = accessMode === "platform"
    ? normalizeServiceBaseUrl(env.DEVILUDO_PLATFORM_ACCOUNT_API_URL ?? "", env.NODE_ENV)
    : null;
  const platformInternalToken = accessMode === "platform"
    ? secretValue(env, "DEVILUDO_PLATFORM_INTERNAL_TOKEN")
    : null;
  if (accessMode === "platform" && (!platformInternalToken || platformInternalToken.length < 32)) {
    throw new Error("DEVILUDO_PLATFORM_INTERNAL_TOKEN is required in platform mode");
  }
  const projectsRoot = resolve(env.DEVILUDO_PROJECTS_ROOT?.trim() || ".deviludo/projects");
  if (env.NODE_ENV === "production" && !env.DEVILUDO_PROJECTS_ROOT?.startsWith("/")) {
    throw new Error("DEVILUDO_PROJECTS_ROOT must be an absolute path in production");
  }
  return Object.freeze({
    role: typedRole,
    port,
    databaseUrl,
    databaseRole: `deviludo_${typedRole}` as CoreConfig["databaseRole"],
    setDatabaseRole: env.DEVILUDO_DATABASE_SET_ROLE === "1",
    webToken,
    e2eDevelopmentToken,
    pollMilliseconds,
    projectDocumentIdleSeconds,
    assetGenerationPollMilliseconds,
    requiredReadyPools: Object.freeze(requiredReadyPools),
    tlsCertificateFile,
    tlsKeyFile,
    tlsClientCaFile,
    accessMode: accessMode as AccessMode,
    platformAccountApiUrl,
    platformInternalToken,
    projectsRoot,
  });
}

function normalizeServiceBaseUrl(value: string, environment: string | undefined): string {
  if (!value) throw new Error("DEVILUDO_PLATFORM_ACCOUNT_API_URL is required in platform mode");
  const url = new URL(value);
  const clusterLocal = url.hostname.endsWith(".svc") || !url.hostname.includes(".");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !["http:", "https:"].includes(url.protocol)
    || (environment === "production" && url.protocol !== "https:" && !clusterLocal)) {
    throw new Error("DEVILUDO_PLATFORM_ACCOUNT_API_URL is invalid");
  }
  return url.href.replace(/\/$/, "");
}

function secretValue(env: NodeJS.ProcessEnv, key: string): string {
  const direct = env[key];
  const file = env[`${key}_FILE`];
  if (direct && file) throw new Error(`${key} and ${key}_FILE cannot both be set`);
  if (!file) return direct ?? "";
  if (!file.startsWith("/")) throw new Error(`${key}_FILE must be absolute`);
  const value = readFileSync(file, "utf8").trim();
  if (!value) throw new Error(`${key}_FILE is empty`);
  return value;
}

function parseInteger(value: string, minimum: number, maximum: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} is invalid`);
  return parsed;
}
