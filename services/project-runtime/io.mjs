#!/usr/bin/env node
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";

const target = process.argv[2];
const turnId = process.argv[3];
if (!/^[0-9a-f-]{36}$/i.test(turnId ?? "")) throw new Error("Runtime injection turn is invalid");
const directory = `/run/deviludo/${turnId}`;
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
