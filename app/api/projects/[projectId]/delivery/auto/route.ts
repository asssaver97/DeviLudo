import { bodyObject, idempotencyKey, json, problemResponse } from "@/lib/control-plane/http";
import { runLocalDeliveryUntilHumanGate } from "@/lib/local-delivery/automatic";
import { readLocalAutomationCommand, saveLocalAutomationCommand } from "@/lib/local-delivery/store";
import { authorizeLocalProjectAccess } from "@/lib/projects/project-read-access";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

const GATE_STATUS = new Set([
  "SPEC_APPROVAL_REQUIRED",
  "WAITING_PROVIDER",
  "LOCAL_EXPORT_TEMPLATES_REQUIRED",
  "LOCAL_VALIDATION_FAILED",
  "LOCAL_MAIN_VALIDATION_FAILED",
  "LOCAL_STEAM_REINSTALL_FAILED",
  "PHYSICAL_RUNNERS_REQUIRED",
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    if (!isLoopbackTestRequest(request)) {
      return json({
        error: {
          code: "LOCAL_AUTOMATION_UNAVAILABLE",
          message: "生产交付由 Temporal 自动编排；该 localhost Fixture 入口不可用。",
        },
      }, { status: 404 });
    }
    const { projectId } = await context.params;
    await authorizeLocalProjectAccess(projectId);
    const body = await bodyObject(request);
    if (Object.keys(body).length !== 0) {
      return json({
        error: { code: "INVALID_LOCAL_AUTOMATION_REQUEST", message: "自动编排不接受客户端阶段或证据参数。" },
      }, { status: 400 });
    }
    const commandKey = `delivery-auto:${projectId}:${idempotencyKey(request)}`;
    const replay = await readLocalAutomationCommand(projectId, commandKey);
    const saved = replay
      ? { response: replay, replayed: true }
      : await saveLocalAutomationCommand(
        projectId,
        commandKey,
        await runLocalDeliveryUntilHumanGate(projectId, commandKey),
      );
    const result = saved.response;
    return json({
      data: result.snapshot,
      meta: {
        mode: "LOCAL_FIXTURE_AUTOMATION",
        stopReason: result.stopReason,
        automaticTransitions: result.automaticTransitions,
        validationExecuted: result.validationExecuted,
        mainValidationExecuted: result.mainValidationExecuted,
        steamReinstallExecuted: result.steamReinstallExecuted,
        requiredPhysicalPlatforms: result.requiredPhysicalPlatforms,
        idempotentReplay: saved.replayed,
      },
      ...(GATE_STATUS.has(result.stopReason) ? {
        error: {
          code: result.stopReason,
          message: stopMessage(result.stopReason, result.requiredPhysicalPlatforms),
          details: result.requiredPhysicalPlatforms.length > 0
            ? { requiredPhysicalPlatforms: result.requiredPhysicalPlatforms }
            : null,
        },
      } : {}),
    }, { status: GATE_STATUS.has(result.stopReason) ? 409 : 200 });
  } catch (error) {
    return problemResponse(error);
  }
}

function stopMessage(stopReason: string, requiredPhysicalPlatforms: readonly string[]) {
  if (stopReason === "SPEC_APPROVAL_REQUIRED") return "请先批准当前规格修订。";
  if (stopReason === "WAITING_PROVIDER") return "原 Provider 尚未恢复，自动开发保持暂停。";
  if (stopReason === "LOCAL_EXPORT_TEMPLATES_REQUIRED") return "Godot 导出模板尚未安装，自动 E2E 保持阻塞。";
  if (stopReason === "PHYSICAL_RUNNERS_REQUIRED") {
    const labels = requiredPhysicalPlatforms.map((platform) => platform === "linux" ? "Linux" : "Windows");
    return `本机证据只证明 macOS；仍需 ${labels.join("、")} 实体 Runner 的 mTLS E2E 证据。`;
  }
  if (stopReason === "LOCAL_MAIN_VALIDATION_FAILED") return "合并后的 main SHA 发布级门禁失败，已撤销发布权限并创建修复接管点。";
  if (stopReason === "LOCAL_STEAM_REINSTALL_FAILED") return "本地 Beta 摘要复核或干净回装启动失败，已撤销发布权限并创建修复接管点。";
  return "本机 Godot 验证失败，修复后才能继续自动 E2E。";
}
