import { idempotencyKey, json, problemResponse } from "@/lib/control-plane/http";
import { readLocalDelivery } from "@/lib/local-delivery/store";
import { runAndSaveLocalAgentExecution } from "@/lib/local-delivery/runtime-agent-execution";
import { authorizeLocalProjectAccess } from "@/lib/projects/project-read-access";
import { assertLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "本机 Agent 运行 API 只在显式启用的 loopback 测试站可用");
    const { projectId } = await context.params;
    await authorizeLocalProjectAccess(projectId);
    if ((await request.text()).length !== 0) {
      return json({ error: { code: "INVALID_LOCAL_AGENT_REQUEST", message: "Agent 启动不接受浏览器提示词或其他正文" } }, { status: 400 });
    }
    const delivery = await readLocalDelivery(projectId);
    const commandKey = idempotencyKey(request);
    const outcome = await runAndSaveLocalAgentExecution(projectId, delivery, commandKey);
    if (outcome.kind === "BLOCKED") {
      return json({ error: { code: outcome.code, message: outcome.message } }, { status: outcome.status });
    }
    return json(
      { data: outcome.receipt, delivery: outcome.snapshot, meta: { idempotentReplay: outcome.replayed } },
      { status: outcome.replayed ? 200 : 201 },
    );
  } catch (error) {
    return problemResponse(error);
  }
}
