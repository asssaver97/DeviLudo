import { json } from "@/lib/control-plane/http";
import { readLocalDelivery } from "@/lib/local-delivery/store";

const localRuntimeUrl = loopbackRuntimeUrl();

export async function GET(request: Request) {
  try {
    const delivery = await readLocalDelivery("ember-archipelago", "SPEC-008");
    const hostname = new URL(request.url).hostname;
    let localRuntime: { status: string; godotVersion?: string | null } = { status: "NOT_CONNECTED" };
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      try {
        const response = await fetch(`${localRuntimeUrl}/health`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) localRuntime = await response.json() as { status: string; godotVersion?: string | null };
      } catch { /* the local runtime is an optional, explicit process */ }
    }
    return json({
      status: "ok",
      service: "deviludo-control-plane-preview",
      version: "0.1.0-beta",
      mode: "LOCALHOST_D1",
      delivery: { stage: delivery.stage, revision: delivery.revision, durable: true },
      dependencies: {
        d1: "READY",
        fixtureExecutor: localRuntime.status === "ok" ? "READY" : "NOT_CONNECTED",
        localGodot: localRuntime.godotVersion ?? null,
        realAgent: "OPT_IN_REQUIRED",
        windowsRunner: "NOT_CONNECTED",
        linuxRunner: "NOT_CONNECTED",
        macosRunner: "NOT_CONNECTED",
        steam: "GUARD_REQUIRED",
      },
      capabilities: ["spec-dialogue", "agent-governance", "local-delivery", "e2e-evidence", "steam-gates"],
      time: new Date().toISOString(),
    });
  } catch (error) {
    return json({
      status: "degraded",
      service: "deviludo-control-plane-preview",
      error: error instanceof Error ? error.message : "Local D1 is unavailable",
      time: new Date().toISOString(),
    }, { status: 503 });
  }
}

function loopbackRuntimeUrl() {
  const url = new URL(process.env.DEVILUDO_LOCAL_RUNTIME_URL ?? "http://127.0.0.1:4311");
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || url.username || url.password || url.search || url.hash) {
    throw new Error("DEVILUDO_LOCAL_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}
