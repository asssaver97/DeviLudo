import { idempotencyKey, json } from "@/lib/control-plane/http";
import {
  githubBrokerRuntimeFromEnvironment,
  verifyTrustedGitHubSession,
} from "@/lib/connections/github-broker";

export async function GET(request: Request) {
  let runtime: ReturnType<typeof githubBrokerRuntimeFromEnvironment>;
  try {
    runtime = githubBrokerRuntimeFromEnvironment();
  } catch {
    return json({ error: { code: "GITHUB_APP_AUTHORIZATION_MISCONFIGURED", message: "GitHub authorization broker configuration is invalid." } }, { status: 503 });
  }
  if (!runtime) {
    return json({ error: { code: "GITHUB_APP_INSTALLATION_BROKER_REQUIRED", message: "GitHub connection status requires the production authorization broker." } }, { status: 503 });
  }
  let principal: Awaited<ReturnType<typeof verifyTrustedGitHubSession>>;
  try {
    principal = await verifyTrustedGitHubSession(request, runtime.sessionHmacKey);
  } catch {
    return json({ error: { code: "GITHUB_CONNECTION_STATUS_UNAVAILABLE", message: "GitHub connection status could not be verified." } }, { status: 401 });
  }
  try {
    return json({ data: await runtime.broker.connectionStatus(principal) });
  } catch {
    return json({ error: { code: "GITHUB_APP_AUTHORIZATION_BROKER_UNAVAILABLE", message: "GitHub connection status broker is unavailable." } }, { status: 502 });
  }
}

export async function POST(request: Request) {
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
      return json({
        error: {
          code: "GITHUB_APP_AUTHORIZATION_REJECTED",
          message: "GitHub authorization could not be started from this authenticated session.",
        },
      }, { status: 401 });
    }
    try {
      const authorization = await runtime.broker.begin(principal, idempotencyKey(request));
      return json({ data: authorization }, { status: 201 });
    } catch {
      return json({ error: { code: "GITHUB_APP_AUTHORIZATION_BROKER_UNAVAILABLE", message: "GitHub authorization broker did not accept the request." } }, { status: 502 });
    }
  }
  return json({
    error: {
      code: "GITHUB_APP_INSTALLATION_BROKER_REQUIRED",
      message: "GitHub authorization requires an authenticated session and the production installation-state broker.",
      details: {
        mode: "github-app-installation",
        requestedPermissions: ["contents:write", "pull_requests:write", "metadata:read"],
        passwordAccepted: false,
      },
    },
  }, { status: 503 });
}
