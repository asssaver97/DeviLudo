import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const webPort = process.env.DEVILUDO_WEB_HOST_PORT?.trim() || "3100";
if (!/^\d+$/.test(webPort) || Number(webPort) < 1 || Number(webPort) > 65535) {
  throw new Error("DEVILUDO_WEB_HOST_PORT must be a valid TCP port");
}
if (webPort === "3000") {
  throw new Error("Port 3000 is reserved; choose another DEVILUDO_WEB_HOST_PORT");
}
const [claudeVersion, codexVersion] = await Promise.all([
  detectLocalRuntime("claude"),
  detectLocalRuntime("codex"),
]);
const environment = {
  ...process.env,
  DEVILUDO_WEB_HOST_PORT: webPort,
  DEVILUDO_AGENT_RUNTIME_DETECTION_SCOPE: "LOCAL_HOST",
  DEVILUDO_CLAUDE_CODE_VERSION: claudeVersion ?? "NOT_INSTALLED",
  DEVILUDO_CODEX_CLI_VERSION: codexVersion ?? "NOT_INSTALLED",
};
await execute("docker", [
  "compose",
  "-f", "infra/docker-compose.yml",
  "up",
  "-d",
  "--build",
  "--wait",
], { cwd: new URL("..", import.meta.url), env: environment, maxBuffer: 10 * 1024 * 1024 });
await import("./local-prepare.mjs");
const { startLocalE2e } = await import("./local-e2e-daemon.mjs");
const e2ePid = await startLocalE2e();
console.log(JSON.stringify({
  ready: true,
  webUrl: `http://127.0.0.1:${webPort}`,
  macE2ePid: e2ePid,
  runtimes: {
    claudeCode: claudeVersion,
    codexCli: codexVersion,
  },
}));

async function detectLocalRuntime(command) {
  try {
    const result = await execute(command, ["--version"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 2_500,
    });
    return `${result.stdout}\n${result.stderr}`.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1] ?? null;
  } catch {
    return null;
  }
}
