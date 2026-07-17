import { json } from "@/lib/control-plane/http";

export async function GET() {
  return json({
    status: "ok",
    service: "deviludo-control-plane-preview",
    version: "0.1.0-beta",
    capabilities: ["spec-dialogue", "agent-governance", "e2e-evidence", "steam-gates"],
    time: new Date().toISOString(),
  });
}
