import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = Readonly<{ params: Promise<{ segments: string[] }> }>;
const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "authorization",
  "content-type",
  "cookie",
  "if-none-match",
  "idempotency-key",
  "x-request-id",
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
  const value = process.env.DEVILUDO_WEB_CORE_TOKEN ?? "";
  if (process.env.NODE_ENV === "production" && value.length < 32) throw new Error("Web-to-Core token is required");
  return value;
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { segments } = await context.params;
  const base = coreBaseUrl();
  const target = new URL(`v1/${segments.map(encodeURIComponent).join("/")}`, base.href.endsWith("/") ? base : new URL(`${base.href}/`));
  target.search = new URL(request.url).search;

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())) headers.set(name, value);
  });
  const token = serviceToken();
  if (token) headers.set("x-deviludo-web-auth", token);
  headers.set("x-forwarded-host", new URL(request.url).host);

  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
    return Response.json({ code: "REQUEST_TOO_LARGE" }, { status: 413 });
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;
  if (body && body.byteLength > MAX_BODY_BYTES) return Response.json({ code: "REQUEST_TOO_LARGE" }, { status: 413 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65_000);
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
      if (!RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) responseHeaders.append(name, value);
    });
    responseHeaders.set("cache-control", upstream.headers.get("cache-control") ?? "no-store");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const code = error instanceof Error && error.name === "AbortError" ? "CORE_TIMEOUT" : "CORE_UNAVAILABLE";
    return Response.json({ code }, { status: 503, headers: { "cache-control": "no-store" } });
  } finally {
    clearTimeout(timer);
  }
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
