import { bodyObject, idempotencyKey, json, problemResponse } from "@/lib/control-plane/http";
import { commandLocalDelivery } from "@/lib/local-delivery/store";
import {
  authorizeLocalProjectAccess,
  authorizeProjectAccess,
  ProjectAccessError,
  projectAccessResponse,
} from "@/lib/projects/project-read-access";
import {
  candidateAcceptanceOperationKey,
  userAcceptanceBrokerFromEnvironment,
} from "@/lib/user-acceptance/broker";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

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
    if (isLoopbackTestRequest(request)) {
      await authorizeLocalProjectAccess(projectId);
      const result = await commandLocalDelivery(projectId, "accept", `acceptance:${projectId}:${requestKey}`);
      return json(
        { data: result.snapshot, meta: { mode: "LOCAL_D1", idempotentReplay: result.replayed } },
        { status: result.replayed ? 200 : 201 },
      );
    }
    if (!UUID.test(projectId)) return invalidProject();
    const broker = userAcceptanceBrokerFromEnvironment();
    if (!broker) return brokerRequired();
    const principal = await authorizeProjectAccess(request, projectId);
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
    return error instanceof ProjectAccessError ? projectAccessResponse(error) : problemResponse(error);
  }
}

function invalidProject(): Response {
  return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效" } }, { status: 400 });
}

function brokerRequired(): Response {
  return json({
    error: {
      code: "USER_ACCEPTANCE_BROKER_REQUIRED",
      message: "生产候选验收需要独立 Broker；Web 进程不会接受客户端提交、PR 或证据绑定。",
    },
  }, { status: 503 });
}
