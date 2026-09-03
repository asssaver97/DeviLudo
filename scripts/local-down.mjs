import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stopLocalE2e } from "./local-e2e-daemon.mjs";
import { stopLocalGitImport } from "./local-git-import-daemon.mjs";
import { stopLocalSteamworksBridge } from "./local-steamworks-bridge-daemon.mjs";
import { cleanupLocalTartOrphans } from "./local-tart-orphans.mjs";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);
const startedAt = Date.now();

console.log("\nStopping the DeviLudo local environment\n");

const composeArguments = ["compose", "-f", "infra/docker-compose.yml", "down", "--remove-orphans"];
if (process.argv.includes("--volumes")) composeArguments.push("--volumes");

const shutdownResults = await Promise.allSettled([
  runShutdownStage("Stop the macOS E2E service", stopLocalE2e),
  runShutdownStage("Stop the local project bridge", stopLocalGitImport),
  runShutdownStage("Stop the managed Steamworks browser bridge", stopLocalSteamworksBridge),
  runShutdownStage("Stop and remove local containers", async () => {
    const result = await execute("docker", composeArguments, {
      cwd: root,
      timeout: 5 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }),
]);

const recoveryResults = await Promise.allSettled([
  runShutdownStage("Remove abandoned task containers", cleanupManagedTaskContainers),
  runShutdownStage("Remove abandoned local E2E virtual machines", cleanupLocalTartOrphans),
]);

const failures = [...shutdownResults, ...recoveryResults]
  .filter(result => result.status === "rejected")
  .map(result => result.reason);

if (failures.length) {
  throw new AggregateError(failures, `Local shutdown completed with ${failures.length} cleanup error(s)`);
}

console.log(`\n✓ DeviLudo local environment stopped (${formatDuration(Date.now() - startedAt)})\n`);

async function cleanupManagedTaskContainers() {
  const { stdout } = await execute("docker", [
    "ps", "-aq", "--filter", "label=deviludo.managed=true",
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const ids = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  for (const id of ids) {
    await execute("docker", ["rm", "-f", id], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  }
  if (ids.length) console.log(`    Removed ${ids.length} abandoned task container(s).`);
}

async function runShutdownStage(label, operation) {
  const stageStartedAt = Date.now();
  console.log(`• ${label}...`);
  const heartbeat = setInterval(() => {
    console.log(`    Still working: ${label} (${formatDuration(Date.now() - stageStartedAt)})`);
  }, 10_000);
  heartbeat.unref();
  try {
    await operation();
    console.log(`    ✓ Done (${formatDuration(Date.now() - stageStartedAt)})`);
  } catch (error) {
    console.error(`    ✗ Failed (${formatDuration(Date.now() - stageStartedAt)}): ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
