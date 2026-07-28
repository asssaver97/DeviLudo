import { json } from "@/lib/control-plane/http";
import { evaluateLocalP0BootstrapReadiness } from "@/lib/health/local-p0-readiness";
import { evaluateProductionWebReadiness } from "@/lib/health/production-readiness";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function GET(request: Request) {
  const local = isLoopbackTestRequest(request);
  const readiness = local
    ? await evaluateLocalP0BootstrapReadiness()
    : await evaluateProductionWebReadiness(process.env, { profile: "P0_INTERNAL" });
  return json({
    schemaVersion: "deviludo.platform-bootstrap-readiness.v1",
    status: readiness.ready ? "BOOTSTRAP_READY" : "BOOTSTRAP_BLOCKED",
    mode: local ? "LOCAL" : "PRODUCTION_INTERNAL",
    ready: readiness.ready,
    dependencies: readiness.dependencies,
    time: new Date().toISOString(),
  }, { status: readiness.ready ? 200 : 503, headers: { "cache-control": "no-store" } });
}
