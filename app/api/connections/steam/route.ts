import { idempotencyKey, json } from "@/lib/control-plane/http";
import { verifyTrustedPlatformSession } from "@/lib/connections/github-broker";
import { steamEnrollmentRuntimeFromEnvironment } from "@/lib/connections/steam-broker";

export async function GET(request: Request) {
  let runtime: ReturnType<typeof steamEnrollmentRuntimeFromEnvironment>;
  try {
    runtime = steamEnrollmentRuntimeFromEnvironment();
  } catch {
    return json({ error: { code: "STEAM_GUARD_ENROLLMENT_MISCONFIGURED", message: "Steam Guard enrollment broker configuration is invalid." } }, { status: 503 });
  }
  if (!runtime) {
    return json({ error: { code: "STEAM_GUARD_ENROLLMENT_BROKER_REQUIRED", message: "Steam connection status requires the isolated production enrollment broker." } }, { status: 503 });
  }
  let session: Awaited<ReturnType<typeof verifyTrustedPlatformSession>>;
  try {
    session = await verifyTrustedPlatformSession(request, runtime.sessionHmacKey);
  } catch {
    return json({ error: { code: "STEAM_CONNECTION_STATUS_UNAVAILABLE", message: "Steam connection status could not be verified." } }, { status: 401 });
  }
  try {
    return json({ data: await runtime.broker.connectionStatus(session) });
  } catch {
    return json({ error: { code: "STEAM_GUARD_ENROLLMENT_BROKER_UNAVAILABLE", message: "Steam connection status broker is unavailable." } }, { status: 502 });
  }
}

export async function POST(request: Request) {
  let runtime: ReturnType<typeof steamEnrollmentRuntimeFromEnvironment>;
  try {
    runtime = steamEnrollmentRuntimeFromEnvironment();
  } catch {
    return json({ error: { code: "STEAM_GUARD_ENROLLMENT_MISCONFIGURED", message: "Steam Guard enrollment broker configuration is invalid." } }, { status: 503 });
  }
  if (runtime) {
    let session: Awaited<ReturnType<typeof verifyTrustedPlatformSession>>;
    try {
      session = await verifyTrustedPlatformSession(request, runtime.sessionHmacKey);
    } catch {
      return json({ error: { code: "STEAM_GUARD_SESSION_REJECTED", message: "Steam Guard enrollment requires a valid authenticated session." } }, { status: 401 });
    }
    try {
      const enrollment = await runtime.broker.begin(session, idempotencyKey(request));
      return json({ data: enrollment }, { status: enrollment.state === "READY" ? 200 : 202 });
    } catch {
      return json({ error: { code: "STEAM_GUARD_ENROLLMENT_BROKER_UNAVAILABLE", message: "Steam Guard enrollment broker did not accept the request." } }, { status: 502 });
    }
  }
  return json({
    error: {
      code: "STEAM_GUARD_ENROLLMENT_BROKER_REQUIRED",
      message: "Steam Guard enrollment requires the isolated production enrollment broker.",
      details: {
        acceptedCredential: "encrypted-config-vdf-session-only",
        storesPrimaryPassword: false,
      },
    },
  }, { status: 503 });
}
