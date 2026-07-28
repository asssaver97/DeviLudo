import { json } from "@/lib/control-plane/http";

export async function GET() {
  return json({
    schemaVersion: "deviludo.platform-liveness.v1",
    status: "ok",
    service: "deviludo-web",
    time: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
