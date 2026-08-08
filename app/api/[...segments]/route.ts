import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { externalRequestHost, requestOriginMatchesHost } from "@/lib/web/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = Readonly<{ params: Promise<{ segments: string[] }> }>;
const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "authorization",
  "content-type",
  "cookie",
  "origin",
  "if-none-match",
  "idempotency-key",
  "x-request-id",
  "x-csrf-token",
]);
const RESPONSE_HEADER_DENYLIST = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_ARCHIVE_BYTES = 64 * 1024 * 1024;
/**
 * Asset uploads carry an 8 MB image base64-encoded in JSON, so the envelope is
 * 4/3 the size of the file. Core enforces the real per-asset ceiling on the
 * decoded bytes; this only has to be loose enough to let a legal upload through.
 */
const MAX_ASSET_UPLOAD_BYTES = 12 * 1024 * 1024;
const ASSET_UPLOAD_PATH = /^projects\/[^/]+\/asset-manifest\/uploads$/;

function bodyLimitFor(routePath: string): number {
  if (routePath === "projects/import/archive") return MAX_PROJECT_ARCHIVE_BYTES;
  if (ASSET_UPLOAD_PATH.test(routePath)) return MAX_ASSET_UPLOAD_BYTES;
  return MAX_BODY_BYTES;
}

function coreBaseUrl(): URL {
  const raw = process.env.DEVILUDO_CORE_API_URL ?? "http://127.0.0.1:8080";
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Core API URL is invalid");
  }
  const clusterLocal = url.hostname.endsWith(".svc") || !url.hostname.includes(".");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:" && !clusterLocal) {
    throw new Error("Production Core API must use TLS or a cluster-local service");
  }
  return url;
}

function serviceToken(): string {
  const file = process.env.DEVILUDO_WEB_CORE_TOKEN_FILE;
  if (file && process.env.DEVILUDO_WEB_CORE_TOKEN) throw new Error("Set only one Web-to-Core token source");
  const value = file ? readFileSync(file, "utf8").trim() : process.env.DEVILUDO_WEB_CORE_TOKEN ?? "";
  if (process.env.NODE_ENV === "production" && value.length < 32) throw new Error("Web-to-Core token is required");
  return value;
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { segments } = await context.params;
  const routePath = segments.join("/");
  const bodyLimit = bodyLimitFor(routePath);
  const base = coreBaseUrl();
  const target = new URL(`v1/${segments.map(encodeURIComponent).join("/")}`, base.href.endsWith("/") ? base : new URL(`${base.href}/`));
  target.search = new URL(request.url).search;

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())) headers.set(name, value);
  });
  const token = serviceToken();
  if (token) headers.set("x-deviludo-web-auth", token);
  const externalHost = externalRequestHost(request);
  headers.set("x-forwarded-host", externalHost);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (!requestOriginMatchesHost(origin, externalHost)) {
      return Response.json({ code: "ORIGIN_REJECTED", message: "请求来源校验失败" }, { status: 403 });
    }
    headers.set("x-deviludo-origin-verified", "1");
    const csrf = cookieValue(request.headers.get("cookie"), "deviludo_csrf");
    if (csrf) headers.set("x-deviludo-csrf", csrf);
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length < 0 || length > bodyLimit) {
    return Response.json({ code: "REQUEST_TOO_LARGE" }, { status: 413 });
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;
  if (body && body.byteLength > bodyLimit) return Response.json({ code: "REQUEST_TOO_LARGE" }, { status: 413 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), routePath.startsWith("projects/import/") ? 120_000 : 65_000);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (name.toLowerCase() === "set-cookie") return;
      if (!RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) responseHeaders.append(name, value);
    });
    for (const value of upstream.headers.getSetCookie()) responseHeaders.append("set-cookie", value);
    responseHeaders.set("cache-control", upstream.headers.get("cache-control") ?? "no-store");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const code = error instanceof Error && error.name === "AbortError" ? "CORE_TIMEOUT" : "CORE_UNAVAILABLE";
    const message = code === "CORE_TIMEOUT" ? "Core 请求超时" : "Core 暂时不可用";
    return Response.json({ code, message }, { status: 503, headers: { "cache-control": "no-store" } });
  } finally {
    clearTimeout(timer);
  }
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;

export function equalServiceTokens(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
