import { bodyObject, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";
import { commandLocalDelivery, readLocalDelivery } from "@/lib/local-delivery/store";
import type { LocalDeliveryAction } from "@/lib/local-delivery/model";
import {
  DeliveryProjectionBrokerError,
  deliveryProjectionBrokerFromEnvironment,
} from "@/lib/delivery-projection/broker";
import { trustedSessionKeyFromEnvironment, verifyTrustedSpecSession } from "@/lib/spec-dialogue/broker";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

const actions = new Set<LocalDeliveryAction>([
  "advance",
  "provider-fail",
  "provider-resume",
  "accept",
  "confirm-mfa",
  "external-approve",
  "reset",
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    if (isLoopbackTestRequest(request)) {
      return json({ data: await readLocalDelivery(projectId), meta: { mode: "LOCAL_D1" } });
    }
    if (!UUID.test(projectId)) return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效。" } }, { status: 400 });
    const broker = deliveryProjectionBrokerFromEnvironment();
    if (!broker) return projectionRequired();
    let sessionKey: Uint8Array;
    try { sessionKey = trustedSessionKeyFromEnvironment(); }
    catch { return projectionRequired(); }
    let principal: Awaited<ReturnType<typeof verifyTrustedSpecSession>>;
    try { principal = await verifyTrustedSpecSession(request, sessionKey); }
    catch {
      return json({ error: { code: "TRUSTED_SESSION_REQUIRED", message: "需要有效的平台会话。" } }, { status: 401 });
    }
    let projection: Awaited<ReturnType<typeof broker.read>>;
    try { projection = await broker.read({ tenantId: principal.tenantId, projectId }); }
    catch (error) {
      const missing = error instanceof DeliveryProjectionBrokerError && error.status === 404;
      return json({
        error: {
          code: missing ? "DELIVERY_PROJECTION_NOT_FOUND" : "DELIVERY_PROJECTION_UNAVAILABLE",
          message: missing ? "该项目尚未启动生产交付工作流。" : "生产交付状态暂不可用。",
        },
      }, { status: missing ? 404 : 503 });
    }
    return json({
      data: projection.snapshot,
      meta: {
        mode: "PRODUCTION",
        projectedAt: projection.projectedAt,
        snapshotDigest: projection.snapshotDigest,
      },
    });
  } catch (error) {
    return problemResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    if (!isLoopbackTestRequest(request)) {
      return json({
        error: {
          code: "DELIVERY_PROJECTION_READ_ONLY",
          message: "生产交付状态由 Temporal 投影；请通过对应的规格、反馈、验收或批准接口推进工作流。",
        },
      }, { status: 405, headers: { allow: "GET" } });
    }
    const body = await bodyObject(request);
    const action = requireString(body, "action", 64) as LocalDeliveryAction;
    if (!actions.has(action)) {
      return json({ error: { code: "UNSUPPORTED_ACTION", message: "不支持的本地交付动作" } }, { status: 400 });
    }
    const result = await commandLocalDelivery(
      projectId,
      action,
      `delivery:${projectId}:${idempotencyKey(request)}`,
    );
    return json(
      { data: result.snapshot, meta: { mode: "LOCAL_D1", idempotentReplay: result.replayed } },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    return problemResponse(error);
  }
}

function projectionRequired(): Response {
  return json({
    error: {
      code: "DELIVERY_PROJECTION_BROKER_REQUIRED",
      message: "生产项目状态需要独立的租户隔离投影 Broker。",
    },
  }, { status: 503 });
}
