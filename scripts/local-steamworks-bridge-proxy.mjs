import { timingSafeEqual } from "node:crypto";
import { request as httpRequest, createServer } from "node:http";

const port = Number(process.env.PORT ?? "8792");
const target = new URL(process.env.DEVILUDO_STEAMWORKS_BRIDGE_HOST_URL ?? "http://host.docker.internal:8792");
const token = process.env.DEVILUDO_STEAMWORKS_BRIDGE_TOKEN ?? "";
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || target.protocol !== "http:"
  || target.hostname !== "host.docker.internal" || target.username || target.password
  || target.pathname !== "/" || target.search || target.hash || !/^[A-Za-z0-9_-]{40,200}$/.test(token)) {
  throw new Error("Local Steamworks bridge proxy configuration is invalid");
}
const allowed = new Set(["/internal/steamworks/session", "/internal/steamworks/sync"]);
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"ready":true}'); return;
  }
  const url = new URL(request.url ?? "/", "http://proxy");
  const actual = String(request.headers["x-deviludo-bridge-token"] ?? "");
  const validToken = Buffer.byteLength(actual) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(actual), Buffer.from(token));
  if (!allowed.has(url.pathname) || !["GET", "POST", "DELETE"].includes(request.method ?? "") || !validToken) {
    response.writeHead(403, { "content-type": "application/json" }); response.end('{"code":"BRIDGE_PROXY_REJECTED"}'); request.resume(); return;
  }
  const upstream = httpRequest(new URL(`${url.pathname}${url.search}`, target), {
    method: request.method,
    headers: { "content-type": "application/json", "content-length": request.headers["content-length"] ?? "0", "x-deviludo-bridge-token": token },
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode ?? 502, { "content-type": "application/json", "cache-control": "no-store" });
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(10 * 60_000, () => upstream.destroy());
  upstream.once("error", () => { if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" }); if (!response.writableEnded) response.end('{"code":"BRIDGE_PROXY_UNAVAILABLE"}'); });
  request.pipe(upstream);
});
server.listen(port, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
