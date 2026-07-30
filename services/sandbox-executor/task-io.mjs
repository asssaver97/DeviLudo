#!/usr/bin/env node
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

const target = process.argv[2] ?? "";
const readable = resolveReadable(target);
if (readable) {
  const info = await lstat(readable);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Task output must be a regular file");
  await pipeline(createReadStream(readable), process.stdout);
  process.exit(0);
}
const route = resolveTarget(target);
if (!route) throw new Error("Task injection target is not allowed");
await mkdir(dirname(route.path), { recursive: true, mode: 0o700 });
const output = createWriteStream(route.path, { flags: route.flags ?? "w", mode: 0o600 });
let bytes = 0;
try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > route.maxBytes) throw new Error("Task injection exceeds its fixed limit");
    if (!output.write(chunk)) await once(output, "drain");
  }
  output.end();
  await once(output, "finish");
} catch (error) {
  output.destroy();
  await rm(route.path, { force: true });
  throw error;
}

function resolveTarget(value) {
  if (value === "plan") return { path: "/run/deviludo/plan.json", maxBytes: 2 * 1024 * 1024 };
  if (value === "provider") return { path: "/run/deviludo/provider.key", maxBytes: 64 * 1024 };
  if (value === "steam") return { path: "/run/deviludo/steam.json", maxBytes: 64 * 1024 };
  if (value === "ready") return { path: "/run/deviludo/ready", maxBytes: 32 };
  if (value === "collected") return { path: "/run/deviludo/collected", maxBytes: 32 };
  if (value === "guidance") return { path: "/run/deviludo/guidance.ndjson", maxBytes: 8 * 1024, flags: "a" };
  const input = value.match(/^input:([A-Za-z0-9._-]{1,200})$/);
  return input ? { path: `/workspace/inputs/${input[1]}`, maxBytes: 1024 * 1024 * 1024 } : null;
}

function resolveReadable(value) {
  if (value === "read-result") return "/run/deviludo/task-result.json";
  if (value === "read-manifest") return "/workspace/outputs/manifest.json";
  if (value === "read-progress") return "/run/deviludo/progress.ndjson";
  const output = value.match(/^read-output:([A-Za-z0-9._-]{1,200})$/);
  return output ? `/workspace/outputs/${output[1]}` : null;
}
