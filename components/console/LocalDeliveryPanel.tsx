"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  LocalDeliveryAction,
  LocalDeliverySnapshot,
  LocalDeliveryStage,
} from "@/lib/local-delivery/model";
import { CheckIcon, ClockIcon, SparkIcon } from "./Icons";

const stageLabels: Record<LocalDeliveryStage, string> = {
  AWAITING_SPEC_APPROVAL: "等待规格批准",
  AGENT_QUEUED: "Agent 已入队",
  AGENT_RUNNING: "Agent 开发中",
  WAITING_PROVIDER: "等待 Provider",
  CANDIDATE_READY: "候选版本就绪",
  E2E_RUNNING: "目标矩阵 E2E",
  AWAITING_ACCEPTANCE: "等待用户验收",
  MERGING: "合并候选 PR",
  MAIN_GATE_RUNNING: "main SHA 发布门禁",
  MFA_REQUIRED: "等待 MFA",
  STEAM_BETA_UPLOADING: "Steam 私有 Beta",
  STEAM_REINSTALL_E2E: "Steam 回装测试",
  EXTERNAL_APPROVAL_REQUIRED: "等待外部批准",
  RELEASED: "本地闭环完成",
};

const platformLabels = { linux: "Linux", windows: "Windows", macos: "macOS" } as const;
const statusLabels = { QUEUED: "排队", RUNNING: "运行中", PASSED: "通过", INVALIDATED: "已失效" } as const;

function primaryAction(stage: LocalDeliveryStage): { action: LocalDeliveryAction; label: string } | null {
  if (stage === "AWAITING_SPEC_APPROVAL" || stage === "RELEASED") return null;
  if (stage === "WAITING_PROVIDER") return { action: "provider-resume", label: "恢复原 Provider" };
  if (stage === "AWAITING_ACCEPTANCE") return { action: "accept", label: "接受候选版本" };
  if (stage === "MFA_REQUIRED") return { action: "confirm-mfa", label: "本地确认 MFA" };
  if (stage === "EXTERNAL_APPROVAL_REQUIRED") return { action: "external-approve", label: "模拟外部批准" };
  return { action: "advance", label: "推进下一步" };
}

export function LocalDeliveryPanel({
  projectId,
  refreshToken,
  onSnapshot,
}: {
  projectId: string;
  refreshToken: number;
  onSnapshot?: (snapshot: LocalDeliverySnapshot) => void;
}) {
  const [snapshot, setSnapshot] = useState<LocalDeliverySnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const publish = useCallback((value: LocalDeliverySnapshot) => {
    setSnapshot(value);
    onSnapshot?.(value);
  }, [onSnapshot]);

  useEffect(() => {
    let active = true;
    fetch(`/api/projects/${projectId}/delivery`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { data?: LocalDeliverySnapshot; error?: { message?: string } };
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "读取本地交付状态失败");
        if (active) {
          setError("");
          publish(payload.data);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "读取本地交付状态失败");
      });
    return () => { active = false; };
  }, [projectId, publish, refreshToken]);

  const action = snapshot ? primaryAction(snapshot.stage) : null;
  const completedTargets = useMemo(
    () => snapshot ? Object.values(snapshot.targetResults).filter((value) => value === "PASSED").length : 0,
    [snapshot],
  );

  async function runAction(nextAction: LocalDeliveryAction) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/delivery`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `local-${nextAction}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ action: nextAction }),
      });
      const payload = await response.json() as { data?: LocalDeliverySnapshot; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "本地交付动作失败");
      publish(payload.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本地交付动作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="local-delivery" aria-live="polite">
      <div className="local-delivery-heading">
        <div>
          <span className="eyebrow">Localhost · D1 持久状态</span>
          <h2>本地交付控制台</h2>
          <p>确定性 Fixture 只验证编排和门禁；不会调用真实 Agent、GitHub 或 Steam。</p>
        </div>
        {snapshot ? <span className={`local-stage local-stage-${snapshot.stage.toLowerCase()}`}><i /> {stageLabels[snapshot.stage]}</span> : null}
      </div>

      {error ? <div className="local-delivery-error" role="alert">{error}</div> : null}
      {!snapshot ? <div className="local-delivery-loading"><ClockIcon /> 正在读取本地状态…</div> : (
        <>
          <div className="local-delivery-grid">
            <div className="local-delivery-lock">
              <span><SparkIcon /></span>
              <div><small>不可变运行锁</small><b>Claude Code {snapshot.lockedProfile.exactAgentVersion}</b><p>{snapshot.lockedProfile.model}</p></div>
              <code>{snapshot.runId ?? "等待规格批准"}</code>
            </div>
            <div className="local-delivery-metric"><small>规格</small><b>{snapshot.specRevisionId}</b><span>rev {snapshot.revision}</span></div>
            <div className="local-delivery-metric"><small>目标矩阵</small><b>{completedTargets} / 3</b><span>{snapshot.evidenceValid ? "证据有效" : "尚未形成有效证据"}</span></div>
            <div className="local-delivery-metric"><small>提交</small><b>{snapshot.mainSha ?? snapshot.candidateSha ?? "—"}</b><span>{snapshot.mainSha ? "main SHA" : snapshot.candidateSha ? "候选 SHA" : "尚未产出"}</span></div>
          </div>

          <div className="local-platform-row">
            {(Object.keys(platformLabels) as Array<keyof typeof platformLabels>).map((platform) => (
              <div className={`local-platform local-platform-${snapshot.targetResults[platform].toLowerCase()}`} key={platform}>
                <span>{platform === "linux" ? "L" : platform === "windows" ? "W" : "m"}</span>
                <div><b>{platformLabels[platform]}</b><small>{statusLabels[snapshot.targetResults[platform]]}</small></div>
                {snapshot.targetResults[platform] === "PASSED" ? <CheckIcon /> : <ClockIcon />}
              </div>
            ))}
          </div>

          <div className="local-delivery-actions">
            <div>
              {action ? <button className="button button-acid" disabled={busy} onClick={() => runAction(action.action)} type="button">{action.label}</button> : null}
              {snapshot.stage === "AGENT_QUEUED" || snapshot.stage === "AGENT_RUNNING" ? (
                <button className="button button-secondary" disabled={busy} onClick={() => runAction("provider-fail")} type="button">模拟 Provider 故障</button>
              ) : null}
            </div>
            <button className="local-reset" disabled={busy} onClick={() => runAction("reset")} type="button">重置本地流程</button>
          </div>

          <div className="local-event-log">
            <div><span>持久事件</span><small>刷新页面后仍保留</small></div>
            <ol>
              {snapshot.events.slice(0, 6).map((entry) => (
                <li key={entry.id}><i /><span><b>{entry.type}</b>{entry.message}</span><time>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></li>
              ))}
            </ol>
          </div>
        </>
      )}
    </section>
  );
}
