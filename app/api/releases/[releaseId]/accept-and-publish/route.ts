import { idempotencyKey, json } from "@/lib/control-plane/http";
import { verifyTrustedPlatformSession } from "@/lib/connections/github-broker";
import { releaseAuthorizationRuntimeFromEnvironment } from "@/lib/releases/publish-broker";

export async function POST(request: Request, context: { params: Promise<{ releaseId: string }> }) {
  let runtime: ReturnType<typeof releaseAuthorizationRuntimeFromEnvironment>;
  try {
    runtime = releaseAuthorizationRuntimeFromEnvironment();
  } catch {
    return json({ error: { code: "STEAM_PUBLISH_DISPATCH_MISCONFIGURED", message: "Release authorization broker configuration is invalid." } }, { status: 503 });
  }
  if (runtime) {
    if (request.headers.has("x-mfa-proof")) {
      return json({ error: { code: "MFA_PROOF_HEADER_REJECTED", message: "MFA proofs are accepted only by the isolated authorization broker." } }, { status: 400 });
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (request.body !== null || !Number.isFinite(contentLength) || contentLength !== 0 || request.headers.has("transfer-encoding")) {
      return json({ error: { code: "CLIENT_RELEASE_BINDINGS_REJECTED", message: "Release evidence and commit bindings are resolved authoritatively by the broker." } }, { status: 400 });
    }
    let principal: Awaited<ReturnType<typeof verifyTrustedPlatformSession>>;
    try {
      principal = await verifyTrustedPlatformSession(request, runtime.sessionHmacKey);
    } catch {
      return json({ error: { code: "RELEASE_AUTHORIZATION_SESSION_REJECTED", message: "Accept and publish requires a valid authenticated session." } }, { status: 401 });
    }
    try {
      const { releaseId } = await context.params;
      const authorization = await runtime.broker.begin(principal, releaseId, idempotencyKey(request));
      return json({ data: authorization }, { status: authorization.state === "DISPATCHED" ? 200 : 202 });
    } catch {
      return json({ error: { code: "RELEASE_AUTHORIZATION_BROKER_UNAVAILABLE", message: "Release authorization broker did not accept the request." } }, { status: 502 });
    }
  }
  return json({
    error: {
      code: "STEAM_PUBLISH_DISPATCH_REQUIRED",
      message: "Accept and publish requires the production MFA signer, Steam publisher and authoritative evidence dispatcher.",
      details: { storesPrimaryPassword: false, acceptsHeaderMfaProof: false, acceptsClientEvidenceStatus: false },
    },
  }, { status: 503 });
}
