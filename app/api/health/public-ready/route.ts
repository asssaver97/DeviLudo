import { json } from "@/lib/control-plane/http";
import { evaluateProductionWebReadiness } from "@/lib/health/production-readiness";

export async function GET() {
  if (process.env.PUBLIC_PRODUCT_ENABLED !== "1") {
    return json({
      schemaVersion: "deviludo.platform-public-readiness.v1",
      status: "EXTERNAL_APPROVAL_REQUIRED",
      ready: false,
      gates: ["PUBLIC_DOMAIN", "DNS_DELEGATION", "PUBLIC_TLS", "EXTERNAL_OAUTH"],
      time: new Date().toISOString(),
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const readiness = await evaluateProductionWebReadiness(process.env, { profile: "FULL" });
  return json({
    schemaVersion: "deviludo.platform-public-readiness.v1",
    status: readiness.ready ? "PUBLIC_READY" : "PUBLIC_BLOCKED",
    ready: readiness.ready,
    dependencies: readiness.dependencies,
    time: new Date().toISOString(),
  }, { status: readiness.ready ? 200 : 503, headers: { "cache-control": "no-store" } });
}
