#!/usr/bin/env node
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";

const target = process.argv[2];
const turnId = process.argv[3];
if (!/^[0-9a-f-]{36}$/i.test(turnId ?? "")) throw new Error("Runtime injection turn is invalid");
const directory = `/run/deviludo/${turnId}`;
if (target === "cancel") {
  await cancelTurn(directory, turnId);
} else {
  const path = target === "provider" ? `${directory}/provider-credential`
    : target === "mcp" ? `${directory}/mcp-token`
      : target === "models" ? `${directory}/models-cache.json` : null;
  const maximum = target === "provider" ? 64 * 1024
    : target === "mcp" ? 8 * 1024
      : target === "models" ? 8 * 1024 * 1024 : 0;
  if (!path) throw new Error("Runtime injection target is not allowed");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = createWriteStream(path, { flags: "w", mode: 0o600 });
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > maximum) throw new Error("Runtime injection exceeds its limit");
      if (!output.write(chunk)) await once(output, "drain");
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    await rm(path, { force: true });
    throw error;
  }
}

async function cancelTurn(directory, expectedTurnId) {
  const pid = Number((await readFile(`${directory}/turn.pid`, "utf8")).trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Runtime turn pid is invalid");
  const environment = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
  if (!environment.split("\0").includes(`DEVILUDO_AGENT_TURN_ID=${expectedTurnId}`)) {
    throw new Error("Runtime turn pid is stale");
  }
  process.kill(pid, "SIGTERM");
  for (let index = 0; index < 100; index += 1) {
    if (!processExists(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (processExists(pid)) process.kill(pid, "SIGKILL");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
