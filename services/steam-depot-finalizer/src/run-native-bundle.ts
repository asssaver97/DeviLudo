import { runSteamDepotFinalizer } from "./run-service";

void runSteamDepotFinalizer().catch(() => {
  process.stderr.write(`${JSON.stringify({ service: "deviludo-steam-depot-finalizer", event: "FAILED" })}\n`);
  process.exitCode = 1;
});
