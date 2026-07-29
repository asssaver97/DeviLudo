export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    schemaVersion: "deviludo.web-liveness.v1",
    service: "web",
    status: "ok",
    time: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
