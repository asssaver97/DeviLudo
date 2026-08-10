import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

if (process.env.NODE_ENV !== "test") throw new Error("The local project bridge fixture is test-only");

const port = Number(process.env.PORT ?? "3199");
const token = process.env.DEVILUDO_LOCAL_PROJECT_BRIDGE_TOKEN ?? "";
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !/^[A-Za-z0-9_-]{40,200}$/.test(token)) {
  throw new Error("Local project bridge fixture configuration is invalid");
}

const files = Object.freeze([
  Object.freeze({ path: "README.md", bytes: Buffer.from("# Clock Game\nA time-loop puzzle adventure.") }),
  Object.freeze({ path: "project.godot", bytes: Buffer.from("[application]\nrun/main_scene=\"res://main.tscn\"") }),
  Object.freeze({ path: "scripts/main.gd", bytes: Buffer.from("extends Node\nfunc reset_timeline(): pass") }),
].sort((left, right) => left.path.localeCompare(right.path)));
const source = encodeSource(files);
const digest = sourceDigest(files);

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ready: true });
    return;
  }
  const actual = String(request.headers["x-deviludo-bridge-token"] ?? "");
  if (request.method !== "POST" || !equalToken(actual, token)) {
    request.resume();
    sendJson(response, 403, { code: "BRIDGE_FIXTURE_REJECTED" });
    return;
  }
  if (request.url === "/internal/directory/source") {
    request.resume();
    response.writeHead(200, {
      "content-type": "application/x-deviludo-source-v1",
      "content-length": String(source.length),
      "x-deviludo-source-digest": digest,
      "cache-control": "no-store",
    });
    response.end(source);
    return;
  }
  if (request.url === "/internal/directory/sync") {
    request.resume();
    sendJson(response, 200, { synced: true, digest });
    return;
  }
  if (request.url === "/internal/directory/git/commit") {
    request.resume();
    sendJson(response, 200, { outcome: "NOT_GIT", commitHash: null, branch: null });
    return;
  }
  request.resume();
  sendJson(response, 404, { code: "NOT_FOUND" });
});

server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ ready: true, port })));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

function encodeSource(entries) {
  const parts = [Buffer.from("DEVILUDO_SOURCE_V1\0")];
  for (const file of entries) {
    const path = Buffer.from(file.path, "utf8");
    const header = Buffer.allocUnsafe(12);
    header.writeUInt32BE(path.length, 0);
    header.writeBigUInt64BE(BigInt(file.bytes.length), 4);
    parts.push(header, path, file.bytes);
  }
  return Buffer.concat(parts);
}

function sourceDigest(entries) {
  const hash = createHash("sha256");
  for (const file of entries) {
    const path = Buffer.from(file.path, "utf8");
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(path).update("\0").update(size).update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function equalToken(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}
