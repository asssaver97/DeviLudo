import type { DeliverySnapshot } from "@/lib/orchestration/game-delivery";

const activeRepairStates = new Set<DeliverySnapshot["state"]>([
  "RESOLVING_AGENT_CONFIGURATION",
  "DEVELOPMENT_QUEUED",
  "DEVELOPING",
  "WAITING_PROVIDER",
  "CROSS_PLATFORM_E2E",
]);

function short(value: string): string {
  return value.length > 18 ? `${value.slice(0, 18)}…` : value;
}

export function DeliveryRepairNotice({
  snapshot,
  compact = false,
}: {
  readonly snapshot: DeliverySnapshot;
  readonly compact?: boolean;
}) {
  const repair = snapshot.repairContext;
  if (!repair) return null;

  const humanTakeover = snapshot.state === "WAITING_SPEC_APPROVAL";
  const active = activeRepairStates.has(snapshot.state);
  const failedBinding = repair.reason === "E2E_FAILURE" ? repair.evidenceBundleId : repair.diagnosticId;
  const successor = snapshot.runId ?? snapshot.lockedRunConfigurationId;

  return (
    <section
      className={`delivery-repair-notice${compact ? " compact" : ""}`}
      data-repair-attempt={repair.attempt}
      data-repair-reason={repair.reason}
    >
      <div className="delivery-repair-heading">
        <div>
          <span className="eyebrow">不可变自动修复链</span>
          <h3>修复 #{repair.attempt} · {repair.reason === "E2E_FAILURE" ? "候选矩阵 E2E 失败" : "Agent 终止失败"}</h3>
        </div>
        <span className={humanTakeover ? "repair-state waiting" : active ? "repair-state active" : "repair-state complete"}>
          {humanTakeover ? "等待人工修订" : active ? "后继运行中" : "已形成候选"}
        </span>
      </div>

      <p>{humanTakeover
        ? "三次自动修复额度已耗尽。平台已停止继续消耗预算；请提交修改说明并批准新的不可变规格修订后再恢复开发。"
        : "平台没有复用失败操作；后继 Agent 运行继承同一批准规格，并固定绑定下面的失败来源与基线。"}</p>

      <dl className="delivery-repair-bindings">
        <div>
          <dt>失败来源</dt>
          <dd>{repair.reason === "E2E_FAILURE" ? "失败证据包" : "诊断记录"}<code title={failedBinding ?? undefined}>{failedBinding ? short(failedBinding) : "—"}</code></dd>
        </div>
        <div>
          <dt>原运行配置</dt>
          <dd><code title={repair.fromRunConfigurationId}>{short(repair.fromRunConfigurationId)}</code></dd>
        </div>
        <div>
          <dt>后继运行</dt>
          <dd><code title={successor ?? undefined}>{successor ? short(successor) : humanTakeover ? "等待新规格" : "正在解析新配置"}</code></dd>
        </div>
        <div>
          <dt>修复基线</dt>
          <dd>
            {repair.candidateCommitSha
              ? <><code title={repair.candidateCommitSha}>{repair.candidateCommitSha.slice(0, 12)}</code>{repair.draftPullRequest ? <span>PR #{repair.draftPullRequest}</span> : null}</>
              : <span>原批准规格</span>}
          </dd>
        </div>
      </dl>

      {repair.repairPromptId ? (
        <footer><span>冻结修复指令</span><code title={repair.repairPromptId}>{short(repair.repairPromptId)}</code></footer>
      ) : null}
    </section>
  );
}
