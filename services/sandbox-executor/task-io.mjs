#!/usr/bin/env node
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const target = process.argv[2] ?? "";
if (target === "read-source") {
  await streamSource("/workspace/project");
  process.exit(0);
}
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
  if (value === "github") return { path: "/run/deviludo/github.key", maxBytes: 64 * 1024 };
  if (value === "ready") return { path: "/run/deviludo/ready", maxBytes: 32 };
  if (value === "collected") return { path: "/run/deviludo/collected", maxBytes: 32 };
  const input = value.match(/^input:([A-Za-z0-9._-]{1,200})$/);
  if (!input) return null;
  return {
    path: `/workspace/inputs/${input[1]}`,
    maxBytes: input[1] === "source.tar.gz" || input[1] === "checkpoint.tar.gz"
      ? Number.MAX_SAFE_INTEGER
      : input[1] === "checkpoint.json" ? 64 * 1024 : 1024 * 1024 * 1024,
  };
}

function resolveReadable(value) {
  if (value === "read-result") return "/run/deviludo/task-result.json";
  if (value === "read-manifest") return "/workspace/outputs/manifest.json";
  if (value === "read-progress") return "/run/deviludo/progress.ndjson";
  const output = value.match(/^read-output:([A-Za-z0-9._-]{1,200})$/);
  return output ? `/workspace/outputs/${output[1]}` : null;
}

async function streamSource(root) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Task source root is invalid");
  await writeChunk(Buffer.from("DEVILUDO_SOURCE_V1\0"));
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error("Task source contains a link or special file");
      }
      if (info.isDirectory()) {
        await visit(absolute);
        continue;
      }
      const path = relative(root, absolute).split(sep).join("/");
      const pathBytes = Buffer.from(path, "utf8");
      const content = await readFile(absolute);
      const header = Buffer.alloc(12);
      header.writeUInt32BE(pathBytes.length, 0);
      header.writeBigUInt64BE(BigInt(content.length), 4);
      await writeChunk(header);
      await writeChunk(pathBytes);
      await writeChunk(content);
    }
  };
  await visit(root);
}

async function writeChunk(chunk) {
  if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
}
