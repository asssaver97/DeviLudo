import { CORE_ROLES, type CoreRole } from "./contracts";
import { isServerPoolKind, SERVER_POOL_KINDS, type ServerPoolKind } from "@/lib/runtime/server-pools";

export type CoreConfig = Readonly<{
  role: CoreRole;
  port: number;
  databaseUrl: string;
  databaseRole: "deviludo_api" | "deviludo_scheduler" | "deviludo_sandbox";
  setDatabaseRole: boolean;
  webToken: string;
  e2eDevelopmentToken: string | null;
  pollMilliseconds: number;
  requiredReadyPools: readonly ServerPoolKind[];
}>;

export function loadCoreConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const role = env.DEVILUDO_CORE_ROLE ?? "";
  if (!(CORE_ROLES as readonly string[]).includes(role)) {
    throw new Error("DEVILUDO_CORE_ROLE must be api, scheduler, or sandbox");
  }
  const typedRole = role as CoreRole;
  const databaseKey = `DEVILUDO_CORE_${typedRole.toUpperCase()}_DATABASE_URL`;
  const databaseUrl = env[databaseKey] ?? "";
  if (!databaseUrl) throw new Error(`${databaseKey} is required`);
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || url.pathname.length < 2) {
    throw new Error("Core database URL is invalid");
  }
  const port = parseInteger(env.PORT ?? "8080", 1, 65535, "PORT");
  const pollMilliseconds = parseInteger(env.DEVILUDO_CORE_POLL_MS ?? "500", 50, 60_000, "DEVILUDO_CORE_POLL_MS");
  const webToken = env.DEVILUDO_WEB_CORE_TOKEN ?? "";
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
  return Object.freeze({
    role: typedRole,
    port,
    databaseUrl,
    databaseRole: `deviludo_${typedRole}` as CoreConfig["databaseRole"],
    setDatabaseRole: env.DEVILUDO_DATABASE_SET_ROLE === "1",
    webToken,
    e2eDevelopmentToken,
    pollMilliseconds,
    requiredReadyPools: Object.freeze(requiredReadyPools),
  });
}

function parseInteger(value: string, minimum: number, maximum: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} is invalid`);
  return parsed;
}
