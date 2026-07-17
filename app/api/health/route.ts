import { json } from "@/lib/control-plane/http";
import { readLocalDelivery } from "@/lib/local-delivery/store";

export async function GET() {
  try {
    const delivery = await readLocalDelivery("ember-archipelago", "SPEC-008");
    return json({
      status: "ok",
      service: "deviludo-control-plane-preview",
      version: "0.1.0-beta",
      mode: "LOCALHOST_D1",
      delivery: { stage: delivery.stage, revision: delivery.revision, durable: true },
      dependencies: {
        d1: "READY",
        fixtureExecutor: "READY",
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
