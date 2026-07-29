import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
await execute("docker", [
  "compose",
  "-f", "infra/docker-compose.yml",
  "up",
  "-d",
  "--build",
  "--wait",
], { cwd: new URL("..", import.meta.url), maxBuffer: 10 * 1024 * 1024 });
await import("./local-prepare.mjs");
const { startLocalE2e } = await import("./local-e2e-daemon.mjs");
const e2ePid = await startLocalE2e();
console.log(`Local DeviLudo is ready with macOS E2E node ${e2ePid}.`);
