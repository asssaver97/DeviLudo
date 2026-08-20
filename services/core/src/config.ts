import { CORE_ROLES, type CoreRole } from "./contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isServerPoolKind, SERVER_POOL_KINDS, type ServerPoolKind } from "@/lib/runtime/server-pools";

export const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.deviludo.com/v1/active-installations";

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
  sandboxConcurrency: number;
  requiredReadyPools: readonly ServerPoolKind[];
  tlsCertificateFile: string | null;
  tlsKeyFile: string | null;
  tlsClientCaFile: string | null;
  projectsRoot: string;
  localDirectoryBindings: boolean;
  localProjectBridgeUrl: string | null;
  localProjectBridgeToken: string | null;
  telemetryEndpoint: string | null;
  installationId: string;
  releaseVersion: string;
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
  const sandboxConcurrency = parseInteger(
    env.DEVILUDO_SANDBOX_CONCURRENCY ?? "1",
    1,
    2,
    "DEVILUDO_SANDBOX_CONCURRENCY",
  );
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
  const projectsRoot = resolve(env.DEVILUDO_PROJECTS_ROOT?.trim() || ".deviludo/projects");
  if (env.NODE_ENV === "production" && !env.DEVILUDO_PROJECTS_ROOT?.startsWith("/")) {
    throw new Error("DEVILUDO_PROJECTS_ROOT must be an absolute path in production");
  }
  const localDirectoryBindings = env.NODE_ENV !== "production" && env.DEVILUDO_LOCAL_DIRECTORY_BINDINGS === "1";
  const localProjectBridgeUrl = localDirectoryBindings
    ? normalizeLocalProjectBridgeUrl(env.DEVILUDO_LOCAL_PROJECT_BRIDGE_INTERNAL_URL ?? "")
    : null;
  const localProjectBridgeToken = localDirectoryBindings
    ? env.DEVILUDO_LOCAL_PROJECT_BRIDGE_TOKEN?.trim() ?? ""
    : null;
  if (localDirectoryBindings && !/^[A-Za-z0-9_-]{40,200}$/.test(localProjectBridgeToken ?? "")) {
    throw new Error("DEVILUDO_LOCAL_PROJECT_BRIDGE_TOKEN is invalid");
  }
  const telemetryEndpoint = normalizeTelemetryEndpoint(
    env.DEVILUDO_TELEMETRY_ENDPOINT?.trim() || DEFAULT_TELEMETRY_ENDPOINT,
    env.NODE_ENV,
  );
  const installationId = (env.DEVILUDO_INSTALLATION_ID ?? "").trim().toLowerCase();
  if (!UUID.test(installationId)) {
    throw new Error("DEVILUDO_INSTALLATION_ID must be a machine-scoped UUID generated by the deployment launcher");
  }
  const releaseVersion = (env.DEVILUDO_RELEASE_VERSION ?? "development").trim();
  if (!/^(development|v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/.test(releaseVersion)) {
    throw new Error("DEVILUDO_RELEASE_VERSION is invalid");
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
    sandboxConcurrency,
    requiredReadyPools: Object.freeze(requiredReadyPools),
    tlsCertificateFile,
    tlsKeyFile,
    tlsClientCaFile,
    projectsRoot,
    localDirectoryBindings,
    localProjectBridgeUrl,
    localProjectBridgeToken,
    telemetryEndpoint,
    installationId,
    releaseVersion,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeLocalProjectBridgeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("DEVILUDO_LOCAL_PROJECT_BRIDGE_INTERNAL_URL is invalid"); }
  if (url.protocol !== "http:" || url.hostname !== "local-project-bridge-proxy"
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("DEVILUDO_LOCAL_PROJECT_BRIDGE_INTERNAL_URL is invalid");
  }
  return url.href.replace(/\/$/, "");
}

function normalizeTelemetryEndpoint(value: string, environment: string | undefined): string | null {
  if (!value.trim()) return null;
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || !["http:", "https:"].includes(url.protocol)
    || (environment === "production" && url.protocol !== "https:")
    || (url.protocol === "http:" && !local && !url.hostname.endsWith(".svc"))) {
    throw new Error("DEVILUDO_TELEMETRY_ENDPOINT is invalid");
  }
  return url.href;
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
