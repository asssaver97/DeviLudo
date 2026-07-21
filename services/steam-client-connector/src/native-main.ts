import { isSea } from "node:sea";
import { startObservability } from "../../../lib/observability/register.mjs";
import { runSteamClientConnectorService } from "./run-service";

declare const __DEVILUDO_NATIVE_PLATFORM_VERSION__: string;
declare const __DEVILUDO_NATIVE_SOURCE_REVISION__: string;

const IDENTITY = Object.freeze({
  schemaVersion: "deviludo.native-component-identity.v1",
  component: "steam-client-connector",
  platformVersion: __DEVILUDO_NATIVE_PLATFORM_VERSION__,
  sourceRevision: __DEVILUDO_NATIVE_SOURCE_REVISION__,
});

async function main(): Promise<void> {
  if (!isSea()) throw new Error("Steam Client Connector native entry requires Node SEA");
  if (process.argv.length === 3 && process.argv[2] === "--identity") {
    process.stdout.write(`${JSON.stringify({
      ...IDENTITY,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    })}\n`);
    return;
  }
  if (process.argv.length !== 2) throw new Error("Steam Client Connector arguments are forbidden");
  if (process.env.DEVILUDO_STEAM_CONNECTOR_VERSION !== IDENTITY.platformVersion) {
    throw new Error("Steam Client Connector version does not match its embedded release identity");
  }
  const telemetry = await startObservability("steam-client-connector", IDENTITY.platformVersion, process.env);
  try { await runSteamClientConnectorService(); }
  finally { await telemetry.shutdown(); }
}

void main().catch(() => {
  process.stderr.write('{"service":"deviludo-steam-client-connector","code":"FAILED"}\n');
  process.exitCode = 1;
});
