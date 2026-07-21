import { isSea } from "node:sea";
import { runGodotTestKitCli } from "./run-cli";

declare const __DEVILUDO_NATIVE_PLATFORM_VERSION__: string;
declare const __DEVILUDO_NATIVE_SOURCE_REVISION__: string;

async function main(): Promise<void> {
  if (!isSea()) throw new Error("Godot TestKit native entry requires Node SEA");
  if (process.argv.length === 3 && process.argv[2] === "--identity") {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "deviludo.native-component-identity.v1",
      component: "godot-testkit",
      platformVersion: __DEVILUDO_NATIVE_PLATFORM_VERSION__,
      sourceRevision: __DEVILUDO_NATIVE_SOURCE_REVISION__,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    })}\n`);
    return;
  }
  await runGodotTestKitCli(process.argv.slice(2));
}

void main().catch(() => {
  process.stderr.write('{"service":"deviludo-godot-testkit","code":"FAILED"}\n');
  process.exitCode = 1;
});
