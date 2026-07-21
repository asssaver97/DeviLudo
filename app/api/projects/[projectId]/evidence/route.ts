import { json, problemResponse } from "@/lib/control-plane/http";
import {
  DeliveryProjectionBrokerError,
  deliveryProjectionBrokerFromEnvironment,
} from "@/lib/delivery-projection/broker";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";
import { trustedSessionKeyFromEnvironment, verifyTrustedSpecSession } from "@/lib/spec-dialogue/broker";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    if (isLoopbackTestRequest(request)) {
      return json({ data: null, meta: { mode: "LOCAL_HEALTH" } }, { headers: { "cache-control": "no-store" } });
    }
    if (!UUID.test(projectId)) {
      return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效。" } }, { status: 400 });
    }
    const broker = deliveryProjectionBrokerFromEnvironment();
    if (!broker) return brokerRequired();
    let sessionKey: Uint8Array;
    try { sessionKey = trustedSessionKeyFromEnvironment(); }
    catch { return brokerRequired(); }
    let principal: Awaited<ReturnType<typeof verifyTrustedSpecSession>>;
    try { principal = await verifyTrustedSpecSession(request, sessionKey); }
    catch {
      return json({ error: { code: "TRUSTED_SESSION_REQUIRED", message: "需要有效的平台会话。" } }, { status: 401 });
    }
    try {
      const projection = await broker.readEvidenceCatalog({ tenantId: principal.tenantId, projectId });
      return json({ data: projection, meta: { mode: "PRODUCTION" } }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const missing = error instanceof DeliveryProjectionBrokerError && error.status === 404;
      return json({
        error: {
          code: missing ? "EVIDENCE_CATALOG_NOT_FOUND" : "EVIDENCE_CATALOG_UNAVAILABLE",
          message: missing ? "项目不存在或当前账号无权查看。" : "证据目录投影暂不可用。",
        },
      }, { status: missing ? 404 : 503 });
    }
  } catch (error) { return problemResponse(error); }
}

function brokerRequired(): Response {
  return json({
    error: {
      code: "EVIDENCE_CATALOG_PROJECTION_BROKER_REQUIRED",
      message: "生产证据目录需要租户隔离的只读投影 Broker。",
    },
  }, { status: 503 });
}
