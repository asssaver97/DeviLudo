#!/usr/bin/env node
import { mkdir } from "node:fs/promises";

const stateRoot = process.env.DEVILUDO_RUNTIME_STATE_ROOT ?? "/var/lib/deviludo-runtime";
await mkdir(`${stateRoot}/sessions`, { recursive: true, mode: 0o700 });
await mkdir(`${stateRoot}/codex`, { recursive: true, mode: 0o700 });

process.stdout.write(`${JSON.stringify({
  schemaVersion: "deviludo.project-runtime.v2",
  state: "READY",
  runtime: process.env.DEVILUDO_AGENT_RUNTIME,
})}\n`);

await new Promise(resolve => {
  // Signal listeners alone do not keep Node's event loop alive; without this
  // referenced timer the container exits with an unsettled top-level await.
  const keepAlive = setInterval(() => {}, 60_000);
  const stop = () => {
    clearInterval(keepAlive);
    resolve();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
});
