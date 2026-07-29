import { isAbsolute } from "node:path";
import {
  assertPoolOperatingSystem,
  isServerPoolKind,
  type ServerOperatingSystem,
  type ServerPoolKind,
} from "@/lib/runtime/server-pools";

export type E2eNodeConfig = Readonly<{
  nodeId: string;
  poolKind: Extract<ServerPoolKind, `E2E_${string}`>;
  operatingSystem: ServerOperatingSystem;
  coreUrl: URL;
  developmentToken: string | null;
  certificateFile: string | null;
  keyFile: string | null;
  caFile: string | null;
  pollMilliseconds: number;
}>;

export function loadE2eNodeConfig(env: NodeJS.ProcessEnv = process.env): E2eNodeConfig {
  const poolKind = env.DEVILUDO_E2E_POOL_KIND ?? "";
  if (!isServerPoolKind(poolKind) || !poolKind.startsWith("E2E_")) {
    throw new Error("DEVILUDO_E2E_POOL_KIND must be one of the three fixed E2E pools");
  }
  const operatingSystem = configuredOperatingSystem(env);
  assertPoolOperatingSystem(poolKind, operatingSystem);
  const nodeId = env.DEVILUDO_E2E_NODE_ID ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(nodeId)) throw new Error("DEVILUDO_E2E_NODE_ID must be a UUID");
  const coreUrl = new URL(env.DEVILUDO_CORE_API_URL ?? "http://127.0.0.1:8080");
  const production = env.NODE_ENV === "production";
  if (production && coreUrl.protocol !== "https:") throw new Error("Production E2E nodes require Core TLS");
  if (!["http:", "https:"].includes(coreUrl.protocol) || coreUrl.username || coreUrl.password) {
    throw new Error("Core URL is invalid");
  }
  const certificateFile = optionalAbsolute(env.DEVILUDO_E2E_CLIENT_CERT_FILE);
  const keyFile = optionalAbsolute(env.DEVILUDO_E2E_CLIENT_KEY_FILE);
  const caFile = optionalAbsolute(env.DEVILUDO_E2E_CORE_CA_FILE);
  if (production && (!certificateFile || !keyFile || !caFile)) {
    throw new Error("Production E2E nodes require mTLS certificate, key, and CA files");
  }
  const pollMilliseconds = Number(env.DEVILUDO_E2E_POLL_MS ?? "750");
  if (!Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 100 || pollMilliseconds > 60_000) {
    throw new Error("DEVILUDO_E2E_POLL_MS is invalid");
  }
  return Object.freeze({
    nodeId,
    poolKind: poolKind as E2eNodeConfig["poolKind"],
    operatingSystem,
    coreUrl,
    developmentToken: production ? null : env.DEVILUDO_E2E_NODE_TOKEN ?? "local-e2e-node-token",
    certificateFile,
    keyFile,
    caFile,
    pollMilliseconds,
  });
}

function configuredOperatingSystem(env: NodeJS.ProcessEnv): ServerOperatingSystem {
  const override = env.DEVILUDO_E2E_OPERATING_SYSTEM_OVERRIDE;
  if (!override) return hostOperatingSystem();
  if (env.NODE_ENV !== "test") {
    throw new Error("DEVILUDO_E2E_OPERATING_SYSTEM_OVERRIDE is restricted to NODE_ENV=test");
  }
  if (!(["linux", "windows", "macos"] as readonly string[]).includes(override)) {
    throw new Error("DEVILUDO_E2E_OPERATING_SYSTEM_OVERRIDE is invalid");
  }
  return override as ServerOperatingSystem;
}

export function hostOperatingSystem(platform: NodeJS.Platform = process.platform): ServerOperatingSystem {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  throw new Error(`Unsupported E2E host operating system: ${platform}`);
}

function optionalAbsolute(value: string | undefined): string | null {
  if (!value) return null;
  if (!isAbsolute(value)) throw new Error("E2E credential paths must be absolute");
  return value;
}
