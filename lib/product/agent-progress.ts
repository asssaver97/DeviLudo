import type { AgentProgressEvent, AgentProgressEventKind } from "./contracts";

export type AgentProgressDisplayRow = Readonly<{
  sequence: number;
  kind: AgentProgressEventKind;
  content: string;
}>;

/**
 * Executor text deltas are transport fragments, not paragraphs. Keep phase and
 * status events distinct, but render adjacent Agent deltas as one continuous
 * stream so an arbitrary transport boundary never becomes visible to players.
 */
export function agentProgressDisplayRows(
  events: readonly AgentProgressEvent[],
): readonly AgentProgressDisplayRow[] {
  const rows: AgentProgressDisplayRow[] = [];
  for (const event of events) {
    const previous = rows.at(-1);
    if (event.kind === "AGENT_OUTPUT" && previous?.kind === "AGENT_OUTPUT") {
      rows[rows.length - 1] = Object.freeze({
        ...previous,
        content: previous.content + event.content,
      });
      continue;
    }
    rows.push(Object.freeze({
      sequence: event.sequence,
      kind: event.kind,
      content: event.content,
    }));
  }
  return Object.freeze(rows);
}

/** Translate executor-owned status copy without rewriting Agent-authored output. */
export function localizedAgentProgressContent(
  row: AgentProgressDisplayRow,
  locale: "zh" | "en",
): string {
  if (locale === "zh" || !/\p{Script=Han}/u.test(row.content) || row.kind === "AGENT_OUTPUT") {
    return row.content;
  }
  if (row.kind === "FAILED") return "Agent execution failed. See the delivery failure details.";
  if (row.kind === "COMPLETED") return "Development Agent completed; registering the source revision";

  const count = row.content.match(/(\d+)\s*个/)?.[1];
  const phaseTranslations: readonly (readonly [RegExp, string])[] = [
    [/已清理上次未完成登记的源码 revision/, "Cleared the previous unregistered source revision; retrying safely"],
    [/Agent 任务已领取/, "Agent job claimed; preparing the isolated environment"],
    [/正在创建任务级隔离环境/, "Creating a job-level isolated environment"],
    [/已读取绑定目录中的/, `Read ${count ?? "the"} latest source files from the bound directory`],
    [/已丢弃输入不匹配的旧任务检查点/, "Discarded a stale checkpoint; restarting from the current source"],
    [/隔离环境已启动/, "Isolated environment started; injecting approved inputs"],
    [/已提供工作流起点的只读源码基线/, "Provided the read-only workflow source baseline"],
    [/已恢复本任务完成的.*源码文件/, `Restored ${count ?? "completed"} source files; skipping duplicate generation`],
    [/已恢复上次尝试保存的.*源码文件/, `Restored ${count ?? "saved"} source files from the previous attempt`],
    [/已保存.*完成态源码文件，正在安全登记结果/, `Saved ${count ?? "completed"} source files; registering the result safely`],
    [/Agent 修改已安全写回/, "Agent changes were written safely to the bound local project"],
    [/本次已保存.*源码文件/, `Saved ${count ?? "partial"} source files; the retry will resume from this checkpoint`],
    [/正在读取已批准的项目需求与现有源码/, "Reading the approved requirements and current source"],
    [/现有项目源码已展开/, "Current project source expanded; analyzing the project structure"],
    [/上次尝试的源码检查点已恢复/, "Restored the previous source checkpoint; continuing from existing work"],
    [/Agent 正在修复.*E2E/, "Agent is repairing issues found by E2E"],
    [/Agent 正在修复制品构建/, "Agent is repairing source issues found by the artifact build"],
    [/已恢复本任务完成的 Agent 检查点/, "Restored the completed Agent checkpoint; skipping a duplicate model call"],
    [/Agent 正在编写并验证游戏项目/, "Agent is implementing and checking the game project"],
    [/Agent 已完成代码修改/, "Agent finished the code changes; publishing the source revision"],
    [/Agent 输出未通过完成门禁/, "Agent output did not pass the completion gate; correcting it in the same session"],
    [/Agent CLI 暂时中断/, "Agent CLI was interrupted; resuming the same session"],
    [/正在展开并校验 Agent 生成的 Godot 项目/, "Expanding and validating the Agent-generated Godot project"],
    [/正在导入 Godot 资源/, "Importing Godot resources and validating the main scene"],
    [/正在导出.*制品/, "Exporting the game artifact"],
    [/Godot 制品导出完成/, "Godot export completed; generating the artifact manifest"],
    [/已同步.*图片素材到构建源码/, `Synced ${count ?? "generated"} image assets into the build source`],
    [/Builder 已开始/, "Builder started validating and building the project"],
    [/Steam Publisher 已开始/, "Steam Publisher started the registered upload operation"],
    [/Agent 已开始维护项目说明/, "Agent started maintaining the project document"],
    [/Agent 已开始生成项目/, "Agent started generating the project"],
    [/构建结果已完成/, "Build completed; uploading and verifying artifacts"],
    [/发布回执已生成/, "Publish receipt generated; uploading and verifying it"],
    [/项目说明已更新/, "Project document updated; uploading and verifying it"],
    [/生成结果已完成/, "Generation completed; uploading and verifying artifacts"],
  ];
  return phaseTranslations.find(([pattern]) => pattern.test(row.content))?.[1]
    ?? "Agent is working…";
}
