import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runningPid } from "./local-e2e-daemon.mjs";

const execute = promisify(execFile);
const { stdout } = await execute("docker", ["compose", "-f", "infra/docker-compose.yml", "ps", "--format", "json"], {
  cwd: new URL("..", import.meta.url), maxBuffer: 2 * 1024 * 1024,
});
const services = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).map(service => ({
  service: service.Service,
  state: service.State,
  health: service.Health || null,
  ports: (service.Publishers ?? [])
    .filter(publisher => publisher.PublishedPort)
    .map(publisher => `${publisher.URL || "0.0.0.0"}:${publisher.PublishedPort}->${publisher.TargetPort}/${publisher.Protocol}`),
}));
console.log(JSON.stringify({ services, macE2ePid: await runningPid() }, null, 2));
