import type { SpecDialogueMessage, SpecModelResult } from "./contracts";
import { parseSpecModelResult } from "./contracts";

export interface SpecDialogueModel {
  generate(input: {
    readonly operationKey: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly conversationId: string;
    readonly history: readonly SpecDialogueMessage[];
    readonly current: SpecModelResult | null;
    readonly userMessage: string;
  }): Promise<SpecModelResult>;
}

/** Deterministic loopback-only model. Production composition never instantiates it. */
export class DeterministicLocalSpecModel implements SpecDialogueModel {
  async generate(input: Parameters<SpecDialogueModel["generate"]>[0]): Promise<SpecModelResult> {
    const turn = input.history.filter((message) => message.role === "user").length + 1;
    const source = `${input.current?.spec.elevatorPitch ?? ""} ${input.userMessage}`.trim();
    const platforms = inferPlatforms(source, input.current?.spec.targetPlatforms);
    const title = input.current?.spec.title ?? inferTitle(input.userMessage);
    const assistantMessage = followup(turn, input.userMessage);
    return parseSpecModelResult({
      assistantMessage,
      completeness: Math.min(96, 48 + turn * 12),
      openQuestions: turn >= 4 ? [] : [assistantMessage],
      spec: {
        title,
        elevatorPitch: source.slice(0, 1_000),
        genre: input.current?.spec.genre ?? "2D 桌面单机冒险",
        godotVersion: "4.5.0",
        targetPlatforms: platforms,
        features: unique([
          ...(input.current?.spec.features ?? []),
          "清晰的核心循环",
          turn >= 2 ? "暂停、设置与存档" : "可验证的胜负条件",
          turn >= 3 ? "键鼠与手柄输入" : "可重复的关卡目标",
        ]),
        acceptanceCriteria: [
          { id: "core-loop", description: "玩家可从新游戏完成一次核心循环并进入结算", required: true },
          { id: "save-load", description: "暂停、保存与读取不会破坏进度", required: true },
          { id: "desktop-export", description: `所选 ${platforms.join(" / ")} 生产导出可启动、游玩并正常退出`, required: true },
        ],
      },
      testPlan: {
        version: "godot-testkit-1.0.0",
        scenarios: ["启动与退出", "核心循环", "胜负条件", "暂停设置", "存档回读", "性能基线", "崩溃捕获", "视觉快照"],
        minimumFps: 60,
        maxCrashCount: 0,
      },
    });
  }
}

function inferTitle(message: string): string {
  const compact = message.split(/[。！？\n]/, 1)[0]!.trim();
  return compact.length <= 18 ? compact : `${compact.slice(0, 16)}…`;
}

function inferPlatforms(message: string, current: readonly ("windows" | "linux" | "macos")[] | undefined) {
  const lower = message.toLowerCase();
  const selected = [
    ...(lower.includes("linux") ? ["linux" as const] : []),
    ...(lower.includes("mac") ? ["macos" as const] : []),
    ...(lower.includes("win") || lower.includes("windows") ? ["windows" as const] : []),
  ];
  return selected.length ? selected : [...(current ?? ["linux", "macos", "windows"])] as ("windows" | "linux" | "macos")[];
}

function followup(turn: number, message: string): string {
  if (turn === 1) return `我已把“${message.slice(0, 42)}”写入核心构想。首个可玩版本的一局目标、胜利条件和失败条件分别是什么？`;
  if (turn === 2) return "核心循环已收紧。请确认暂停菜单是否允许随时保存退出，以及读取后从哪里继续。";
  if (turn === 3) return "存档边界已加入验收标准。首版需要键鼠、手柄还是两者都支持？目标系统也请一起确认。";
  return "规格已达到可冻结程度。我已生成验收标准与固定 TestKit 计划；你仍可继续补充，或明确批准当前修订。";
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
