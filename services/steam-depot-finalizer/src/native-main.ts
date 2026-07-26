import { isSea } from "node:sea";
import {
  executeSteamDepotNativeCommand,
  parseSteamDepotNativeCommand,
} from "./run-native-controller";

declare const __DEVILUDO_NATIVE_PLATFORM_VERSION__: string;
declare const __DEVILUDO_NATIVE_SOURCE_REVISION__: string;

const IDENTITY = Object.freeze({
  schemaVersion: "deviludo.native-component-identity.v1",
  component: "steam-depot-finalizer-controller",
  platformVersion: __DEVILUDO_NATIVE_PLATFORM_VERSION__,
  sourceRevision: __DEVILUDO_NATIVE_SOURCE_REVISION__,
});

async function main(): Promise<void> {
  if (!isSea()) throw new Error("Steam depot finalizer native entry requires Node SEA");
  if (process.argv.length === 3 && process.argv[2] === "--identity") {
    process.stdout.write(`${JSON.stringify({
      ...IDENTITY,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    })}\n`);
    return;
  }
  const output = await executeSteamDepotNativeCommand(
    parseSteamDepotNativeCommand(process.argv.slice(2)),
  );
  if (output !== null) process.stdout.write(`${output}\n`);
}

void main().catch(() => {
  process.stderr.write("[steam-depot-finalizer-native] execution failed\n");
  process.exitCode = 1;
});
