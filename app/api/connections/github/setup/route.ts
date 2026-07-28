import { json } from "@/lib/control-plane/http";
import {
  githubBrokerRuntimeFromEnvironment,
  githubCallbackIdempotencyKey,
  requireGitHubSetupParameters,
  verifyTrustedGitHubSession,
} from "@/lib/connections/github-broker";
import { LocalGitHubRuntimeClient, localGitHubImportEnabled } from "@/lib/connections/local-github-runtime";

/** Untrusted setup parameters are handled only by the authenticated broker. */
export async function GET(request: Request) {
  if (localGitHubImportEnabled(request)) {
    let parameters: ReturnType<typeof requireGitHubSetupParameters>;
    try { parameters = requireGitHubSetupParameters(new URL(request.url)); }
    catch { return json({ error: { code: "GITHUB_APP_SETUP_REJECTED", message: "GitHub App setup callback is invalid." } }, { status: 400 }); }
    try {
      const result = await new LocalGitHubRuntimeClient().setup(parameters);
      return redirectTo(result.authorizeUrl);
    } catch {
      return json({ error: { code: "LOCAL_GITHUB_RUNTIME_UNAVAILABLE", message: "本机 GitHub App setup 未完成。" } }, { status: 502 });
    }
  }
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
      return json({ error: { code: "GITHUB_APP_SESSION_REJECTED", message: "GitHub App setup requires a valid authenticated session." } }, { status: 401 });
    }
    let parameters: ReturnType<typeof requireGitHubSetupParameters>;
    try {
      parameters = requireGitHubSetupParameters(new URL(request.url));
    } catch {
      return json({ error: { code: "GITHUB_APP_SETUP_REJECTED", message: "GitHub App setup callback is invalid." } }, { status: 400 });
    }
    try {
      const result = await runtime.broker.setup({
        principal,
        ...parameters,
        idempotencyKey: await githubCallbackIdempotencyKey("setup", parameters.state),
      });
      return redirectTo(result.authorizeUrl);
    } catch {
      return json({
        error: {
          code: "GITHUB_APP_AUTHORIZATION_BROKER_UNAVAILABLE",
          message: "GitHub App setup could not be completed by the authorization broker.",
        },
      }, { status: 502 });
    }
  }
  return json({
    error: {
      code: "GITHUB_APP_INSTALLATION_BROKER_REQUIRED",
      message: "GitHub App setup callbacks require the production authorization broker.",
    },
  }, { status: 503 });
}

function redirectTo(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
