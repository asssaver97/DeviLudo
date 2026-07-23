import { bodyObject, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";
import { commandLocalDelivery, readLocalDelivery } from "@/lib/local-delivery/store";
import { LocalDeliveryGateError, type LocalDeliveryAction } from "@/lib/local-delivery/model";
import {
  DeliveryProjectionBrokerError,
  deliveryProjectionBrokerFromEnvironment,
} from "@/lib/delivery-projection/broker";
import { authorizeLocalProjectAccess, authorizeProjectAccess, projectAccessResponse } from "@/lib/projects/project-read-access";
import {
  deliveryCancellationOperationKey,
  userAcceptanceBrokerFromEnvironment,
} from "@/lib/user-acceptance/broker";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

const actions = new Set<LocalDeliveryAction>([
  "advance",
  "provider-fail",
  "provider-resume",
  "confirm-mfa",
  "main-gate-fail",
  "steam-reinstall-fail",
  "external-approve",
  "cancel",
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
      await authorizeLocalProjectAccess(projectId);
      return json({ data: await readLocalDelivery(projectId), meta: { mode: "LOCAL_D1" } });
    }
    if (!UUID.test(projectId)) return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效。" } }, { status: 400 });
    const broker = deliveryProjectionBrokerFromEnvironment();
    if (!broker) return projectionRequired();
    let principal: Awaited<ReturnType<typeof authorizeProjectAccess>>;
    try { principal = await authorizeProjectAccess(request, projectId); }
    catch (error) { return projectAccessResponse(error); }
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
      const body = await bodyObject(request);
      if (body.action !== "cancel") {
        return json({
          error: {
            code: "DELIVERY_PROJECTION_READ_ONLY",
            message: "生产交付状态由 Temporal 投影；只有经过认证的取消请求可以从此入口发送。",
          },
        }, { status: 405, headers: { allow: "GET, POST" } });
      }
      if (!UUID.test(projectId)
        || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["action", "reason"])) {
        return json({ error: { code: "INVALID_DELIVERY_CANCELLATION_REQUEST", message: "取消请求格式无效。" } }, { status: 400 });
      }
      const reason = requireString(body, "reason", 2_000);
      const broker = userAcceptanceBrokerFromEnvironment();
      if (!broker) return cancellationBrokerRequired();
      let principal: Awaited<ReturnType<typeof authorizeProjectAccess>>;
      try { principal = await authorizeProjectAccess(request, projectId); }
      catch (error) { return projectAccessResponse(error); }
      const receipt = await broker.cancel({
        operationKey: await deliveryCancellationOperationKey({
          tenantId: principal.tenantId,
          projectId,
          userId: principal.userId,
          idempotencyKey: idempotencyKey(request),
        }),
        tenantId: principal.tenantId,
        projectId,
        actorId: principal.userId,
        reason,
      });
      return json({ data: receipt, meta: { mode: "PRODUCTION" } }, { status: 202 });
    }
    await authorizeLocalProjectAccess(projectId);
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
    if (error instanceof LocalDeliveryGateError) {
      return json({ error: { code: error.code, message: error.message } }, { status: 409 });
    }
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

function cancellationBrokerRequired(): Response {
  return json({
    error: {
      code: "DELIVERY_CANCELLATION_BROKER_REQUIRED",
      message: "生产取消需要独立的用户决定 Broker；Web 进程不会直接持有 Temporal 或数据库权限。",
    },
  }, { status: 503 });
}
