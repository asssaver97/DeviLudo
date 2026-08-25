import { createLocalHostServices } from "./access";
import { startCore } from "./start";

async function main(): Promise<void> {
  await startCore(createLocalHostServices(process.env.DEVILUDO_HOST_SERVICE_TOKEN ?? ""));
}

main().catch(error => {
  console.error(JSON.stringify({
    level: "fatal",
    event: "core_start_failed",
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
