import { isSea } from "node:sea";
import { startObservability } from "../../../lib/observability/register.mjs";
import { runPhysicalRunnerService } from "./run-physical-runner";

declare const __DEVILUDO_NATIVE_PLATFORM_VERSION__: string;
declare const __DEVILUDO_NATIVE_SOURCE_REVISION__: string;

const IDENTITY = Object.freeze({
  schemaVersion: "deviludo.native-component-identity.v1",
  component: "physical-runner",
  platformVersion: __DEVILUDO_NATIVE_PLATFORM_VERSION__,
  sourceRevision: __DEVILUDO_NATIVE_SOURCE_REVISION__,
});

async function main(): Promise<void> {
  if (!isSea()) throw new Error("Physical Runner native entry requires Node SEA");
  if (process.argv.length === 3 && process.argv[2] === "--identity") {
    process.stdout.write(`${JSON.stringify({
      ...IDENTITY,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    })}\n`);
    return;
  }
  if (process.argv.length !== 2) throw new Error("Physical Runner arguments are forbidden");
  const telemetry = await startObservability("physical-runner", IDENTITY.platformVersion, process.env);
  try { await runPhysicalRunnerService(); }
  finally { await telemetry.shutdown(); }
}

void main().catch(() => {
  process.stderr.write('{"service":"deviludo-physical-runner","code":"FAILED"}\n');
  process.exitCode = 1;
});
