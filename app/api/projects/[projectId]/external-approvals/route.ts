import { bodyObject, idempotencyKey, json, problemResponse } from "@/lib/control-plane/http";
import { runAndSaveLocalExternalApproval } from "@/lib/local-delivery/runtime-external-approval";
import { readLocalDelivery, readLocalDeliveryCommand } from "@/lib/local-delivery/store";
import { authorizeLocalProjectAccess } from "@/lib/projects/project-read-access";
import { assertLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "本地外部批准入口只在显式启用的 loopback 测试站可用");
    const { projectId } = await context.params;
    await authorizeLocalProjectAccess(projectId);
    const body = await bodyObject(request);
    if (Object.keys(body).length !== 0) {
      return json({ error: { code: "INVALID_LOCAL_EXTERNAL_APPROVAL_REQUEST", message: "批准请求不接受客户端门禁或证据参数。" } }, { status: 400 });
    }
    const commandKey = `external-approval:${projectId}:${idempotencyKey(request)}`;
    const replay = await readLocalDeliveryCommand(projectId, commandKey);
    if (replay) {
      return json({ data: replay, meta: { mode: "LOCAL_AUTHORITY_EVIDENCE", idempotentReplay: true } });
    }
    const result = await runAndSaveLocalExternalApproval(projectId, await readLocalDelivery(projectId), commandKey);
    return json(
      { data: result.snapshot, meta: { mode: "LOCAL_AUTHORITY_EVIDENCE", idempotentReplay: result.replayed } },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    return problemResponse(error);
  }
}
