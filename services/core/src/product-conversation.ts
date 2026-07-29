export type ConversationProjectContext = Readonly<{
  name: string;
  workflowState: string;
}>;

export type ProductConversationReply = Readonly<{
  content: string;
  appliedToDraft: boolean;
}>;

const STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  DRAFT: "规格确认中",
  AGENT_RUNNING: "Agent 生成中",
  ARTIFACT_BUILDING: "制品构建中",
  E2E_TESTING: "跨平台测试中",
  SIGNING: "平台签名中",
  STEAM_PUBLISHING: "Steam 发布中",
  CLEAN_INSTALL_VERIFYING: "干净回装验证中",
  SUCCEEDED: "交付完成",
  FAILED: "流程失败",
  CANCELLED: "已取消",
});

export function createProductConversationReply(input: Readonly<{
  userContent: string;
  turnNumber: number;
  project: ConversationProjectContext | null;
}>): ProductConversationReply {
  const summary = compactSummary(input.userContent);
  if (!input.project) {
    const followUp = input.turnNumber <= 1
      ? "为了把它变成可执行的游戏规格，请再补充三点：玩家每分钟最常做的动作、单局希望持续多久，以及你最想让玩家感受到什么。"
      : "下一步请描述失败与成功的判定、成长或资源系统，以及首发平台；我会继续把这些答案收拢成可以交给 Agent 的规格。";
    return Object.freeze({
      content: `我理解的方向是「${summary}」。${followUp}`,
      appliedToDraft: false,
    });
  }

  if (input.project.workflowState === "DRAFT") {
    return Object.freeze({
      content: `已把「${summary}」加入《${input.project.name}》的规格草案。为了避免实现偏差，请再说明这项修改会影响哪些核心玩法，以及你会用什么结果判断它已经改对。`,
      appliedToDraft: true,
    });
  }

  const state = STATE_LABELS[input.project.workflowState] ?? input.project.workflowState;
  return Object.freeze({
    content: `《${input.project.name}》当前处于“${state}”，本轮规格已经锁定。我已把「${summary}」记录为后续修改意见，不会改动正在运行的交付。请再补充优先级和验收标准，方便进入下一轮开发。`,
    appliedToDraft: false,
  });
}

function compactSummary(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized;
}
