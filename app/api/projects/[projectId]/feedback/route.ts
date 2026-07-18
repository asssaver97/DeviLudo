import { appendDemoAudit, getDemoStore, withIdempotency } from "@/lib/control-plane/demo-store";
import { bodyObject, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";
import { invalidateLocalEvidence } from "@/lib/local-delivery/store";
import { specDialogueBrokerRuntimeFromEnvironment, verifyTrustedSpecSession } from "@/lib/spec-dialogue/broker";
import { userAcceptanceBrokerFromEnvironment, userFeedbackOperationKey } from "@/lib/user-acceptance/broker";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  if (isLoopbackTestRequest(request)) return json({ data: getDemoStore().feedback, meta: { projectId } });
  return json({ error: { code: "METHOD_NOT_ALLOWED", message: "生产反馈历史由项目迭代视图读取" } }, {
    status: 405,
    headers: { allow: "POST" },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    if (!PROJECT.test(projectId)) return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效" } }, { status: 400 });
    const body = await bodyObject(request);
    if (JSON.stringify(Object.keys(body)) !== JSON.stringify(["feedback"])) {
      return json({ error: { code: "INVALID_USER_FEEDBACK_REQUEST", message: "候选版本反馈格式无效" } }, { status: 400 });
    }
    const feedback = requireString(body, "feedback", 4000);
    const requestKey = idempotencyKey(request);
    if (!isLoopbackTestRequest(request)) {
      const session = specDialogueBrokerRuntimeFromEnvironment();
      const broker = userAcceptanceBrokerFromEnvironment();
      if (!session || !broker) return productionBrokerRequired();
      const principal = await verifyTrustedSpecSession(request, session.sessionHmacKey);
      const receipt = await broker.submit({
        operationKey: await userFeedbackOperationKey({
          tenantId: principal.tenantId,
          projectId,
          userId: principal.userId,
          idempotencyKey: requestKey,
        }),
        tenantId: principal.tenantId,
        projectId,
        actorId: principal.userId,
        feedback,
      });
      return json({ data: receipt, meta: { idempotentReplay: receipt.delivery.replayed } }, { status: 201 });
    }
    const result = withIdempotency(`feedback:${projectId}:${requestKey}`, () => {
      const store = getDemoStore();
      store.specRevision += 1;
      store.specState = "DRAFT";
      const iteration = {
        id: `ITER-${String(store.feedback.length + 8).padStart(3, "0")}`,
        text: feedback,
        revision: store.specRevision,
        at: new Date().toISOString(),
      };
      store.feedback.push(iteration);
      store.invalidatedEvidence.push("EV-007-LNX");
      appendDemoAudit("ITERATION_CREATED", iteration.id, "ProjectOwner", {
        projectId,
        evidenceInvalidated: true,
        draftPullRequest: 18,
      });
      return {
        iteration,
        specRevisionId: `SPEC-${String(store.specRevision).padStart(3, "0")}`,
        invalidatedEvidence: ["EV-007-LNX"],
        candidatePullRequest: 18,
        state: "AWAITING_SPEC_APPROVAL",
      };
    });
    const delivery = await invalidateLocalEvidence(
      projectId,
      result.value.specRevisionId,
      `feedback-delivery:${projectId}:${requestKey}`,
    );
    return json(
      { data: { ...result.value, delivery: delivery.snapshot }, meta: { idempotentReplay: result.replayed || delivery.replayed } },
      { status: result.replayed || delivery.replayed ? 200 : 201 },
    );
  } catch (error) {
    return problemResponse(error);
  }
}

function productionBrokerRequired(): Response {
  return json({
    error: {
      code: "USER_ACCEPTANCE_BROKER_REQUIRED",
      message: "生产反馈需要独立的用户验收 Broker；Web 进程不会直接生成规格或失效证据。",
    },
  }, { status: 503 });
}
