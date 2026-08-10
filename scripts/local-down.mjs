import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stopLocalE2e } from "./local-e2e-daemon.mjs";
import { stopLocalGitImport } from "./local-git-import-daemon.mjs";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);
await Promise.all([stopLocalE2e(), stopLocalGitImport()]);
const args = ["compose", "-f", "infra/docker-compose.yml", "down"];
if (process.argv.includes("--volumes")) args.push("--volumes");
const result = await execute("docker", args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
