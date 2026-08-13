import { timingSafeEqual } from "node:crypto";
import { request as httpRequest, createServer } from "node:http";

const port = Number(process.env.PORT ?? "3199");
const target = new URL(process.env.DEVILUDO_LOCAL_PROJECT_BRIDGE_HOST_URL ?? "");
const token = process.env.DEVILUDO_LOCAL_PROJECT_BRIDGE_TOKEN ?? "";
const allowedPaths = new Set([
  "/internal/directory/source",
  "/internal/directory/delete",
  "/internal/directory/sync",
  "/internal/directory/git/commit",
]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535
  || target.protocol !== "http:" || target.hostname !== "host.docker.internal"
  || target.username || target.password || target.pathname !== "/" || target.search || target.hash
  || !/^[A-Za-z0-9_-]{40,200}$/.test(token)) {
  throw new Error("Local project bridge proxy configuration is invalid");
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ready: true }));
    return;
  }
  if (request.method !== "POST" || !allowedPaths.has(request.url ?? "")
    || !equalToken(String(request.headers["x-deviludo-bridge-token"] ?? ""), token)) {
    response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ code: "BRIDGE_PROXY_REJECTED" }));
    request.resume();
    return;
  }
  const contentLength = Number(request.headers["content-length"] ?? "0");
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ code: "BRIDGE_PROXY_INVALID_REQUEST" }));
    request.resume();
    return;
  }
  const upstream = httpRequest(new URL(request.url, target), {
    method: "POST",
    headers: Object.fromEntries([
      "content-type",
      "content-length",
      "x-deviludo-directory-binding",
      "x-deviludo-base-digest",
    ].flatMap(name => typeof request.headers[name] === "string" ? [[name, request.headers[name]]] : [])),
  }, upstreamResponse => {
    const headers = Object.fromEntries([
      "content-type",
      "content-length",
      "x-deviludo-source-digest",
      "cache-control",
      "x-content-type-options",
    ].flatMap(name => typeof upstreamResponse.headers[name] === "string" ? [[name, upstreamResponse.headers[name]]] : []));
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(response);
  });
  upstream.setHeader("x-deviludo-bridge-token", token);
  upstream.setTimeout(10 * 60 * 1_000, () => upstream.destroy(new Error("Local project bridge timed out")));
  upstream.once("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    if (!response.writableEnded) response.end(JSON.stringify({ code: "BRIDGE_PROXY_UNAVAILABLE" }));
  });
  request.pipe(upstream);
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ ready: true, port }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

function equalToken(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
