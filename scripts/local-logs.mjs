import { spawn } from "node:child_process";
const child = spawn("docker", ["compose", "-f", "infra/docker-compose.yml", "logs", "--follow", "--tail", "200"], {
  cwd: new URL("..", import.meta.url), stdio: "inherit", shell: false,
});
process.exitCode = await new Promise(resolve => child.once("close", resolve));
