import { bodyObject, idempotencyKey, json, problemResponse } from "@/lib/control-plane/http";
import { commandLocalDelivery } from "@/lib/local-delivery/store";
import { specDialogueBrokerRuntimeFromEnvironment, verifyTrustedSpecSession } from "@/lib/spec-dialogue/broker";
import {
  candidateAcceptanceOperationKey,
  userAcceptanceBrokerFromEnvironment,
} from "@/lib/user-acceptance/broker";

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    if (!PROJECT.test(projectId)) return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效" } }, { status: 400 });
    const body = await bodyObject(request);
    if (Object.keys(body).length !== 0) {
      return json({ error: { code: "INVALID_CANDIDATE_ACCEPTANCE_REQUEST", message: "候选验收不接受客户端证据或提交绑定" } }, { status: 400 });
    }
    const requestKey = idempotencyKey(request);
    if (isLocal(request)) {
      const result = await commandLocalDelivery(projectId, "accept", `acceptance:${projectId}:${requestKey}`);
      return json(
        { data: result.snapshot, meta: { mode: "LOCAL_D1", idempotentReplay: result.replayed } },
        { status: result.replayed ? 200 : 201 },
      );
    }
    const session = specDialogueBrokerRuntimeFromEnvironment();
    const broker = userAcceptanceBrokerFromEnvironment();
    if (!session || !broker) return brokerRequired();
    const principal = await verifyTrustedSpecSession(request, session.sessionHmacKey);
    const receipt = await broker.accept({
      operationKey: await candidateAcceptanceOperationKey({
        tenantId: principal.tenantId,
        projectId,
        userId: principal.userId,
        idempotencyKey: requestKey,
      }),
      tenantId: principal.tenantId,
      projectId,
      actorId: principal.userId,
    });
    return json({ data: receipt, meta: { idempotentReplay: receipt.delivery.replayed } }, { status: 201 });
  } catch (error) {
    return problemResponse(error);
  }
}

function isLocal(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "127.0.0.1" || host === "localhost";
}

function brokerRequired(): Response {
  return json({
    error: {
      code: "USER_ACCEPTANCE_BROKER_REQUIRED",
      message: "生产候选验收需要独立 Broker；Web 进程不会接受客户端提交、PR 或证据绑定。",
    },
  }, { status: 503 });
}
