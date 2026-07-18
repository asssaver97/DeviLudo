import {
  BROWSER_BINDING_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  identityBrokerFromEnvironment,
  secureCookie,
} from "@/lib/auth/identity-broker";

const STATE = /^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/;

export async function GET(request: Request) {
  const broker = identityBrokerFromEnvironment();
  if (!broker) return failed(request, "unavailable");
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!STATE.test(state) || !code || code.length > 512 || /[\u0000-\u0020]/.test(code)) return failed(request, "callback-rejected");
  let browserBinding: string;
  try {
    // The login callback intentionally has no session cookie yet; reuse the
    // strict parser by presenting the binding as both values and retaining only it.
    const cookie = request.headers.get("cookie") ?? "";
    const match = cookie.split(";").map((item) => item.trim()).filter((item) => item.startsWith(`${BROWSER_BINDING_COOKIE}=`));
    if (match.length !== 1) throw new Error();
    browserBinding = match[0]!.slice(BROWSER_BINDING_COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(browserBinding)) throw new Error();
  } catch { return failed(request, "browser-binding-lost"); }
  try {
    const result = await broker.complete({ state, code, browserBinding });
    const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer",
      location: new URL(result.returnPath, request.url).href });
    headers.append("set-cookie", secureCookie(SESSION_COOKIE, result.sessionToken, result.expiresAt));
    headers.append("set-cookie", secureCookie(BROWSER_BINDING_COOKIE, browserBinding, result.expiresAt));
    return new Response(null, { status: 303, headers });
  } catch { return failed(request, "github-login-rejected"); }
}

function failed(request: Request, code: string): Response {
  const url = new URL("/login", request.url); url.searchParams.set("error", code);
  const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer", location: url.href });
  headers.append("set-cookie", clearCookie(SESSION_COOKIE)); headers.append("set-cookie", clearCookie(BROWSER_BINDING_COOKIE));
  return new Response(null, { status: 303, headers });
}
