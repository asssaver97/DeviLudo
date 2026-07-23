import { idempotencyKey, json, problemResponse } from "@/lib/control-plane/http";
import { readLocalDelivery } from "@/lib/local-delivery/store";
import { runAndSaveLocalValidation } from "@/lib/local-delivery/runtime-validation";
import { authorizeLocalProjectAccess } from "@/lib/projects/project-read-access";
import { assertLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "本机验证 API 只在显式启用的 loopback 测试站可用");
    const { projectId } = await context.params;
    await authorizeLocalProjectAccess(projectId);
    const delivery = await readLocalDelivery(projectId);
    return json({ data: delivery.localValidation, meta: { runId: delivery.runId, stage: delivery.stage } });
  } catch (error) {
    return problemResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "本机验证 API 只在显式启用的 loopback 测试站可用");
    const { projectId } = await context.params;
    await authorizeLocalProjectAccess(projectId);
    const delivery = await readLocalDelivery(projectId);
    const saved = await runAndSaveLocalValidation(
      projectId,
      delivery,
      `local-validation:${projectId}:${idempotencyKey(request)}`,
    );
    return json(
      { data: saved.snapshot.localValidation, delivery: saved.snapshot, meta: { idempotentReplay: saved.replayed } },
      { status: saved.replayed ? 200 : 201 },
    );
  } catch (error) {
    return problemResponse(error);
  }
}
