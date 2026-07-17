import { json } from "@/lib/control-plane/http";
import {
  githubBrokerRuntimeFromEnvironment,
  githubCallbackIdempotencyKey,
  requireGitHubOauthParameters,
  verifyTrustedGitHubSession,
} from "@/lib/connections/github-broker";

/** OAuth codes and state are intentionally not parsed or reflected here. */
export async function GET(request: Request) {
  let runtime: ReturnType<typeof githubBrokerRuntimeFromEnvironment>;
  try {
    runtime = githubBrokerRuntimeFromEnvironment();
  } catch {
    return json({ error: { code: "GITHUB_APP_AUTHORIZATION_MISCONFIGURED", message: "GitHub authorization broker configuration is invalid." } }, { status: 503 });
  }
  if (runtime) {
    let principal: Awaited<ReturnType<typeof verifyTrustedGitHubSession>>;
    try {
      principal = await verifyTrustedGitHubSession(request, runtime.sessionHmacKey);
    } catch {
      return json({ error: { code: "GITHUB_APP_SESSION_REJECTED", message: "GitHub user authorization requires a valid authenticated session." } }, { status: 401 });
    }
    let parameters: ReturnType<typeof requireGitHubOauthParameters>;
    try {
      parameters = requireGitHubOauthParameters(new URL(request.url));
    } catch {
      return json({ error: { code: "GITHUB_USER_AUTHORIZATION_REJECTED", message: "GitHub user authorization callback is invalid." } }, { status: 400 });
    }
    try {
      const result = await runtime.broker.complete({
        principal,
        ...parameters,
        idempotencyKey: await githubCallbackIdempotencyKey("oauth", parameters.state),
      });
      const location = new URL(result.returnPath, "https://deviludo.invalid");
      location.searchParams.set("github", "connected");
      return new Response(null, {
        status: 303,
        headers: {
          location: `${location.pathname}${location.search}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return json({
        error: {
          code: "GITHUB_APP_AUTHORIZATION_BROKER_UNAVAILABLE",
          message: "GitHub user authorization could not be completed by the authorization broker.",
        },
      }, { status: 502 });
    }
  }
  return json({
    error: {
      code: "GITHUB_APP_INSTALLATION_BROKER_REQUIRED",
      message: "GitHub user authorization callbacks require the production authorization broker.",
    },
  }, { status: 503 });
}
