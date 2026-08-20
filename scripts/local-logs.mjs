import { spawn } from "node:child_process";
const follow = !process.argv.slice(2).includes("--no-follow");
const arguments_ = ["compose", "-f", "infra/docker-compose.yml", "logs", "--tail", "200"];
if (follow) arguments_.push("--follow");
const child = spawn("docker", arguments_, {
  cwd: new URL("..", import.meta.url), stdio: "inherit", shell: false,
});
process.exitCode = await new Promise(resolve => child.once("close", resolve));
