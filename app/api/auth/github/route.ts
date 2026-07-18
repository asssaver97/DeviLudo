import { BROWSER_BINDING_COOKIE, identityBrokerFromEnvironment, secureCookie } from "@/lib/auth/identity-broker";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

const INVITATION = /^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/;

export async function GET(request: Request) {
  if (isLoopbackTestRequest(request)) return Response.redirect(new URL("/", request.url), 303);
  const broker = identityBrokerFromEnvironment();
  if (!broker) return failure(request, "unavailable", 503);
  const invitationToken = new URL(request.url).searchParams.get("invite") ?? "";
  if (!INVITATION.test(invitationToken)) return failure(request, "invalid-invitation", 400);
  const browserBinding = randomValue();
  try {
    const login = await broker.begin({ invitationToken, browserBinding });
    const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer", location: login.authorizeUrl });
    headers.append("set-cookie", secureCookie(BROWSER_BINDING_COOKIE, browserBinding, login.expiresAt));
    return new Response(null, { status: 303, headers });
  } catch { return failure(request, "invalid-invitation", 400); }
}

function randomValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}
function failure(request: Request, code: string, status: number): Response {
  const url = new URL("/login", request.url); url.searchParams.set("error", code);
  return new Response(null, { status: status === 503 ? 307 : 303,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer", location: url.href } });
}
