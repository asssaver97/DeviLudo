"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LocalDeliveryAction,
  LocalDeliverySnapshot,
  LocalDeliveryStage,
} from "@/lib/local-delivery/model";
import type { LocalAgentPreflightResult } from "@/services/local-agent-runtime/src/contracts";
import type { DeliverySnapshot, DeliveryState } from "@/lib/orchestration/game-delivery";
import { CheckIcon, ClockIcon, SparkIcon } from "./Icons";
import { DeliveryRepairNotice } from "./DeliveryRepairNotice";

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
  CANCELLED: "已取消",
  RELEASED: "本地闭环完成",
};

const platformLabels = { linux: "Linux", windows: "Windows", macos: "macOS" } as const;
const statusLabels = { QUEUED: "排队", RUNNING: "运行中", PASSED: "通过", INVALIDATED: "已失效" } as const;

const productionStageLabels: Record<DeliveryState, string> = {
  IDEATION: "构想对话中", WAITING_SPEC_APPROVAL: "等待规格批准",
  RESOLVING_AGENT_CONFIGURATION: "解析 Agent 配置", DEVELOPMENT_QUEUED: "开发已入队",
  DEVELOPING: "Agent 开发中", WAITING_PROVIDER: "等待原 Provider",
  CROSS_PLATFORM_E2E: "目标矩阵 E2E", WAITING_USER_ACCEPTANCE: "等待用户验收",
  MERGING: "合并固定候选 PR", MAIN_SHA_E2E: "main SHA 发布门禁",
  WAITING_MFA: "等待 MFA", STEAM_PRIVATE_BETA: "Steam 私有 Beta",
  STEAM_INSTALL_E2E: "Steam 干净回装 E2E", EXTERNAL_APPROVAL_REQUIRED: "等待外部批准",
  READY_TO_PUBLISH: "等待发布 Steam 默认分支", RELEASED: "已发布",
  CANCELLED: "已取消",
};

const externalGateCopy = {
  VALVE_REVIEW: {
    title: "等待 Valve 审核通过",
    description: "Steam 验证连接器会读取审核结果；通过后以 mTLS 证据自动推进，网页不能手工跳过。",
  },
  FIRST_RELEASE: {
    title: "等待首次发行操作完成",
    description: "在 Steamworks 完成首次发行要求后，验证连接器会确认同一 App 与已回装 BuildID。",
  },
  DEFAULT_BRANCH_CONFIRMATION: {
    title: "等待默认分支手机／短信确认",
    description: "完成 Steam 的最终确认后，验证连接器会提交摘要证据；平台随后才允许发布默认分支。",
  },
} as const;

export type DeliveryPanelStatus =
  | {
      readonly mode: "LOCAL_D1";
      readonly stage: LocalDeliveryStage;
      readonly specRevisionId: string;
      readonly humanRepairTakeover: boolean;
    }
  | {
      readonly mode: "PRODUCTION";
      readonly stage: DeliveryState;
      readonly specRevisionId: string | null;
      readonly humanRepairTakeover: boolean;
    };

type ProductionProjection = {
  readonly snapshot: DeliverySnapshot;
  readonly projectedAt: string;
  readonly snapshotDigest: string;
};

type LocalPanelAction = LocalDeliveryAction | "auto";

function primaryAction(stage: LocalDeliveryStage, externalApprovalCount = 0): { action: LocalPanelAction; label: string } | null {
  if (stage === "AWAITING_SPEC_APPROVAL" || stage === "RELEASED" || stage === "CANCELLED") return null;
  if (stage === "WAITING_PROVIDER") return { action: "provider-resume", label: "恢复原 Provider" };
  if (stage === "AWAITING_ACCEPTANCE") return null;
  if (stage === "MFA_REQUIRED") return { action: "confirm-mfa", label: "本地确认 MFA" };
  if (stage === "EXTERNAL_APPROVAL_REQUIRED") return {
    action: "external-approve",
    label: ["模拟 Valve 审核通过", "模拟首次发行完成", "模拟默认分支确认"][externalApprovalCount] ?? "模拟外部批准",
  };
  return { action: "auto", label: "自动运行到下一人工门禁" };
}

export function LocalDeliveryPanel({
  localFixture,
  projectId,
  refreshToken,
  onStatus,
}: {
  localFixture: boolean;
  projectId: string;
  refreshToken: number;
  onStatus?: (status: DeliveryPanelStatus) => void;
}) {
  const [snapshot, setSnapshot] = useState<LocalDeliverySnapshot | null>(null);
  const [production, setProduction] = useState<ProductionProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agentPreflight, setAgentPreflight] = useState<LocalAgentPreflightResult | null>(null);

  const publish = useCallback((value: LocalDeliverySnapshot) => {
    setSnapshot(value);
    setProduction(null);
    setAgentPreflight((current) => current?.runId === value.runId ? current : null);
    onStatus?.({
      mode: "LOCAL_D1",
      stage: value.stage,
      specRevisionId: value.specRevisionId,
      humanRepairTakeover: value.stage === "AWAITING_SPEC_APPROVAL" && value.repairHandoff !== null,
    });
  }, [onStatus]);

  useEffect(() => {
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    async function loadProjection() {
      try {
        const response = await fetch(`/api/projects/${projectId}/delivery`, { cache: "no-store" });
        const payload = await response.json() as {
          data?: LocalDeliverySnapshot | DeliverySnapshot;
          meta?: { mode?: "LOCAL_D1" | "PRODUCTION"; projectedAt?: string; snapshotDigest?: string };
          error?: { message?: string };
        };
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "读取本地交付状态失败");
        if (active) {
          setError("");
          if (payload.meta?.mode === "PRODUCTION") {
            const value = payload.data as DeliverySnapshot;
            if (!payload.meta.projectedAt || !payload.meta.snapshotDigest) throw new Error("生产交付投影元数据无效");
            setSnapshot(null);
            setAgentPreflight(null);
            setProduction({ snapshot: value, projectedAt: payload.meta.projectedAt, snapshotDigest: payload.meta.snapshotDigest });
            onStatus?.({
              mode: "PRODUCTION",
              stage: value.state,
              specRevisionId: value.specRevisionId,
              humanRepairTakeover: value.state === "WAITING_SPEC_APPROVAL" && value.repairContext !== null,
            });
          } else {
            publish(payload.data as LocalDeliverySnapshot);
          }
        }
      } catch (reason: unknown) {
        if (active) setError(reason instanceof Error ? reason.message : "读取本地交付状态失败");
      } finally {
        if (active && !localFixture) refreshTimer = setTimeout(loadProjection, 5_000);
      }
    }
    void loadProjection();
    return () => {
      active = false;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [localFixture, projectId, publish, refreshToken, onStatus]);

  const action = snapshot ? primaryAction(snapshot.stage, snapshot.externalApprovals.length) : null;
  const completedTargets = useMemo(
    () => snapshot ? Object.values(snapshot.targetResults).filter((value) => value === "PASSED").length : 0,
    [snapshot],
  );
  const missingPhysicalTargets = useMemo(
    () => snapshot?.stage === "CANDIDATE_READY"
      && snapshot.localValidation?.valid
      && snapshot.localValidation.releaseGate === "LOCAL_VALIDATION_PASSED"
      ? snapshot.targetMatrix.filter((platform) => platform !== snapshot.localValidation?.platform)
      : [],
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
      if (nextAction === "confirm-mfa" || nextAction === "provider-resume") {
        const automatic = await requestAutomatic(`local-auto-after-${nextAction}-${crypto.randomUUID()}`);
        if (automatic.data) publish(automatic.data);
        if (!automatic.ok) throw new Error(automatic.message ?? "自动交付链路已暂停");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本地交付动作失败");
    } finally {
      setBusy(false);
    }
  }

  async function runAutomatic() {
    setBusy(true);
    setError("");
    try {
      const automatic = await requestAutomatic(`local-auto-${snapshot?.runId ?? "pending"}-${crypto.randomUUID()}`);
      if (automatic.data) publish(automatic.data);
      if (!automatic.ok) throw new Error(automatic.message ?? "自动交付链路已暂停");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "自动交付链路已暂停");
    } finally {
      setBusy(false);
    }
  }

  async function requestAutomatic(commandId: string) {
    const response = await fetch(`/api/projects/${projectId}/delivery/auto`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": commandId },
      body: "{}",
    });
    const payload = await response.json() as { data?: LocalDeliverySnapshot; error?: { message?: string } };
    return { ok: response.ok, data: payload.data, message: payload.error?.message };
  }

  async function runLocalValidation() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/local-validation`, {
        method: "POST",
        headers: { "idempotency-key": `godot-${snapshot?.runId ?? "pending"}` },
      });
      const payload = await response.json() as { delivery?: LocalDeliverySnapshot; error?: { message?: string } };
      if (!response.ok || !payload.delivery) throw new Error(payload.error?.message ?? "本机 Git/Godot 验证失败");
      publish(payload.delivery);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本机 Git/Godot 验证失败");
    } finally {
      setBusy(false);
    }
  }

  async function runAgentPreflight() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/agent-preflight`, { method: "POST" });
      const payload = await response.json() as { data?: LocalAgentPreflightResult; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "本机 Agent 预检失败");
      setAgentPreflight(payload.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本机 Agent 预检失败");
    } finally {
      setBusy(false);
    }
  }

  async function runAgentExecution() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/agent-run`, {
        method: "POST",
        headers: { "idempotency-key": `agent-${snapshot?.runId ?? "pending"}` },
      });
      const payload = await response.json() as {
        delivery?: LocalDeliverySnapshot;
        data?: { preflight?: LocalAgentPreflightResult };
        error?: { message?: string };
      };
      if (payload.data?.preflight) setAgentPreflight(payload.data.preflight);
      if (!response.ok || !payload.delivery) throw new Error(payload.error?.message ?? "本机 Agent 运行失败");
      publish(payload.delivery);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本机 Agent 运行失败");
    } finally {
      setBusy(false);
    }
  }

  if (production) return <ProductionDeliveryProjection projectId={projectId} projection={production} />;

  return (
    <section className="local-delivery" aria-live="polite">
      <div className="local-delivery-heading">
        <div>
          <span className="eyebrow">{localFixture ? "Localhost · D1 持久状态" : "Production · Temporal 权威投影"}</span>
          <h2>{localFixture ? "本地交付控制台" : "交付工作流"}</h2>
          <p>{localFixture ? "规格批准后自动运行 Fixture 开发与真实 Godot 验证，并停在人工门禁；真实 Agent 必须先通过独立预检，本地默认不会调用模型、GitHub 或 Steam。" : "规格获批后会创建确定性工作流；Web 只读取租户隔离投影，不能直接推进状态。"}</p>
        </div>
        {snapshot ? <span className={`local-stage local-stage-${snapshot.stage.toLowerCase()}`}><i /> {stageLabels[snapshot.stage]}</span> : null}
      </div>

      {error ? <div className="local-delivery-error" role="alert">{error}</div> : null}
      {!snapshot ? <div className="local-delivery-loading"><ClockIcon /> 正在读取本地状态…</div> : (
        <>
          <div className="local-delivery-grid">
            <div className="local-delivery-lock">
              <span><SparkIcon /></span>
              <div>
                <small>不可变运行锁 · {snapshot.lockedProfile.configurationSource}</small>
                <b>{snapshot.lockedProfile.agent === "claude-code" ? "Claude Code" : "Codex CLI"} {snapshot.lockedProfile.exactAgentVersion}</b>
                <p>{snapshot.lockedProfile.model}</p>
              </div>
              <code>{snapshot.runId ?? "等待规格批准"}</code>
            </div>
            <div className="local-delivery-metric"><small>规格</small><b>{snapshot.specRevisionId}</b><span>rev {snapshot.revision}</span></div>
            <div className="local-delivery-metric"><small>目标矩阵</small><b>{completedTargets} / {snapshot.targetMatrix.length}</b><span>{snapshot.evidenceValid ? "证据有效" : "尚未形成有效证据"}</span></div>
            <div className="local-delivery-metric"><small>提交</small><b>{snapshot.mainSha ?? snapshot.candidateSha ?? "—"}</b><span>{snapshot.mainSha ? "main SHA" : snapshot.candidateSha ? "候选 SHA" : "尚未产出"}</span></div>
          </div>

          <div className="local-platform-row">
            {snapshot.targetMatrix.map((platform) => {
              const status = snapshot.targetResults[platform] ?? "INVALIDATED";
              return (
              <div className={`local-platform local-platform-${status.toLowerCase()}`} key={platform}>
                <span>{platform === "linux" ? "L" : platform === "windows" ? "W" : "m"}</span>
                <div><b>{platformLabels[platform]}</b><small>{statusLabels[status]}</small></div>
                {status === "PASSED" ? <CheckIcon /> : <ClockIcon />}
              </div>
              );
            })}
          </div>

          {missingPhysicalTargets.length > 0 ? (
            <div className="local-real-validation pending">
              <div className="local-real-validation-copy">
                <span className="eyebrow">实体 Runner 硬门禁</span>
                <h3>等待 {missingPhysicalTargets.map((platform) => platformLabels[platform]).join("、")} mTLS Runner</h3>
                <p>当前证据只来自 macOS 本机 Fixture；候选版本保持未验收，其他系统不会被标记为通过。</p>
              </div>
              <div className="local-real-validation-result">
                <span className="waiting">PHYSICAL_RUNNERS_REQUIRED</span>
                <div><a href="/runners">查看运行节点</a></div>
              </div>
            </div>
          ) : null}

          {snapshot.repairHandoff ? (
            <section
              className="delivery-repair-notice"
              data-repair-attempt={snapshot.repairHandoff.attempt}
              data-repair-reason={snapshot.repairHandoff.reason}
            >
              <div className="delivery-repair-heading">
                <div>
                  <span className="eyebrow">Localhost · 发布后失败演练</span>
                  <h3>{snapshot.repairHandoff.reason === "MAIN_GATE_FAILURE" ? "main SHA 发布门禁失败" : "Steam 回装 E2E 失败"}</h3>
                </div>
                <span className="repair-state waiting">等待人工修订</span>
              </div>
              <p>失败证据已冻结，旧发布授权已全部撤销。提交修改说明并批准新的不可变规格后，才能从当前 main 基线恢复开发。</p>
              <dl className="delivery-repair-bindings">
                <div><dt>失败证据</dt><dd><code>{snapshot.repairHandoff.evidenceId}</code></dd></div>
                <div><dt>原运行</dt><dd><code>{snapshot.repairHandoff.previousRunId}</code></dd></div>
                <div><dt>main 基线</dt><dd><code>{snapshot.repairHandoff.baselineMainSha}</code></dd></div>
                <div><dt>已撤销</dt><dd><span>{snapshot.repairHandoff.revokedAuthorities.join(" · ")}</span></dd></div>
              </dl>
              <footer><span>冻结修复指令</span><code>{snapshot.repairHandoff.repairPromptId}</code></footer>
            </section>
          ) : null}

          <div className={`local-real-validation ${agentPreflight?.status === "READY" ? "ready" : "pending"}`}>
            <div className="local-real-validation-copy">
              <span className="eyebrow">真实 Agent 启动预检</span>
              <h3>{agentPreflight ? agentPreflight.code : `${snapshot.lockedProfile.agent} · ${snapshot.lockedProfile.exactAgentVersion}`}</h3>
              <p>{agentPreflight
                ? `${agentPreflight.message} 本机版本：${agentPreflight.observedVersion ?? "不可用"}`
                : "只检查精确 CLI、WorkerImage、Gateway/Provider 和显式执行开关；预检本身不启动 Agent。"}</p>
            </div>
            {agentPreflight ? (
              <div className="local-real-validation-result">
                <span className={agentPreflight.status === "READY" ? "passed" : "waiting"}>{agentPreflight.status === "READY" ? "可以领取任务" : "执行已阻止"}</span>
                <div>
                  <button className="button button-secondary" disabled={busy} onClick={runAgentPreflight} type="button">重新预检</button>
                  {agentPreflight.status === "READY" ? <button className="button button-primary" disabled={busy} onClick={runAgentExecution} type="button">启动真实 Agent</button> : null}
                </div>
              </div>
            ) : snapshot.runId ? (
              <button className="button button-secondary" disabled={busy} onClick={runAgentPreflight} type="button">{busy ? "正在预检…" : "检查真实 Agent"}</button>
            ) : <span className="local-real-validation-wait">批准规格后可预检</span>}
          </div>

          {snapshot.agentExecution ? (
            <div className={`local-real-validation ${snapshot.agentExecution.valid ? "ready" : "pending"}`}>
              <div className="local-real-validation-copy">
                <span className="eyebrow">Agent + SCM 运行回执</span>
                <h3>{snapshot.agentExecution.candidate.commitSha.slice(0, 12)}</h3>
                <p>{snapshot.agentExecution.summary}</p>
              </div>
              <div className="local-real-validation-result">
                <span className={snapshot.agentExecution.valid ? "passed" : "waiting"}>{snapshot.agentExecution.valid ? "候选已冻结" : "回执已失效"}</span>
                <div>{snapshot.agentExecution.candidate.changedFiles.length} 个文件 · ${snapshot.agentExecution.usage.costUsd.toFixed(4)}</div>
              </div>
            </div>
          ) : null}

          <div className={`local-real-validation ${snapshot.localValidation?.valid ? "ready" : "pending"}`}>
            <div className="local-real-validation-copy">
              <span className="eyebrow">真实本机执行</span>
              <h3>{snapshot.localValidation?.valid ? snapshot.localValidation.evidenceId : "Git fixture + Godot macOS headless"}</h3>
              <p>{snapshot.localValidation?.valid
                ? `${snapshot.localValidation.godotVersion} · macOS 本机 · ${snapshot.localValidation.checks.filter((check) => check.status === "PASSED").length} 项通过`
                : "创建隔离 Git 候选提交，运行项目导入、启动、核心循环、存档回读和性能检查。"}</p>
            </div>
            {snapshot.localValidation?.valid ? (
              <div className="local-real-validation-result">
                <span className={snapshot.localValidation.status === "FAILED" ? "failed" : snapshot.localValidation.releaseGate === "LOCAL_VALIDATION_PASSED" ? "passed" : "waiting"}>
                  {snapshot.localValidation.status === "FAILED" ? "macOS 本机验证失败" : snapshot.localValidation.releaseGate === "LOCAL_VALIDATION_PASSED" ? "macOS 本机门禁通过" : "等待依赖 · 导出模板"}
                </span>
                <div>
                  <a href={`/api/projects/${projectId}/local-validation/evidence/manifest.json`} rel="noreferrer" target="_blank">Manifest</a>
                  <a href={`/api/projects/${projectId}/local-validation/evidence/junit.xml`} rel="noreferrer" target="_blank">JUnit</a>
                  <a href={`/api/projects/${projectId}/local-validation/evidence/godot.log`} rel="noreferrer" target="_blank">日志</a>
                  {snapshot.localValidation.buildArtifact ? (
                    <a href={`/api/projects/${projectId}/local-validation/artifact/${snapshot.localValidation.buildArtifact.fileName}`}>下载 macOS 构建</a>
                  ) : null}
                  {snapshot.localValidation.releaseGate === "WAITING_EXPORT_TEMPLATES" ? (
                    <button className="button button-secondary" disabled={busy} onClick={runLocalValidation} type="button">
                      {busy ? "正在重试…" : "安装模板后重试"}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : snapshot.runId && snapshot.stage !== "RELEASED" ? (
              <button className="button button-primary" disabled={busy || snapshot.stage === "WAITING_PROVIDER"} onClick={runLocalValidation} type="button">
                {busy ? "正在执行…" : "运行真实本机验证"}
              </button>
            ) : <span className="local-real-validation-wait">批准规格后可运行</span>}
          </div>

          {snapshot.stage === "EXTERNAL_APPROVAL_REQUIRED" && snapshot.externalGate ? (
            <div className="local-real-validation pending">
              <div className="local-real-validation-copy">
                <span className="eyebrow">Localhost · 顺序外部门禁</span>
                <h3>{externalGateCopy[snapshot.externalGate].title}</h3>
                <p>本地按钮只模拟这一道门禁；生产环境必须由白名单 mTLS Steam 验证连接器提交摘要证据。</p>
              </div>
              <div className="local-real-validation-result">
                <span>{snapshot.externalApprovals.length} / 3 已确认</span>
                <div>BuildID {snapshot.steamBuildId ?? "本地模拟"}</div>
              </div>
            </div>
          ) : null}

          <div className="local-delivery-actions">
            <div>
              {action ? <button className="button button-acid" disabled={busy} onClick={() => action.action === "auto" ? runAutomatic() : runAction(action.action)} type="button">{action.label}</button> : null}
              {snapshot.stage === "AGENT_QUEUED" || snapshot.stage === "AGENT_RUNNING" ? (
                <button className="button button-secondary" disabled={busy} onClick={() => runAction("provider-fail")} type="button">模拟 Provider 故障</button>
              ) : null}
              {snapshot.stage === "MAIN_GATE_RUNNING" ? (
                <button className="button button-secondary" disabled={busy} onClick={() => runAction("main-gate-fail")} type="button">模拟 main 门禁失败</button>
              ) : null}
              {snapshot.stage === "STEAM_REINSTALL_E2E" ? (
                <button className="button button-secondary" disabled={busy} onClick={() => runAction("steam-reinstall-fail")} type="button">模拟 Steam 回装失败</button>
              ) : null}
              {snapshot.stage !== "RELEASED" && snapshot.stage !== "CANCELLED" ? (
                <button className="button button-secondary" disabled={busy} onClick={() => runAction("cancel")} type="button">取消本地交付</button>
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

function ProductionDeliveryProjection({
  projectId,
  projection,
}: {
  readonly projectId: string;
  readonly projection: ProductionProjection;
}) {
  const snapshot = projection.snapshot;
  const targetGatePassed = Boolean(snapshot.candidateEvidenceBundleId);
  const publishCommandRef = useRef<string | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishNotice, setPublishNotice] = useState("");
  const cancelCommandRef = useRef<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelNotice, setCancelNotice] = useState("");
  const cancellable = !["READY_TO_PUBLISH", "RELEASED", "CANCELLED"].includes(snapshot.state);

  async function beginAcceptAndPublish() {
    if (snapshot.state !== "WAITING_MFA" || !snapshot.steamReleaseId || publishBusy) return;
    setPublishBusy(true);
    setPublishNotice("");
    publishCommandRef.current ??= `publish-${crypto.randomUUID()}`;
    try {
      const response = await fetch(
        `/api/releases/${encodeURIComponent(snapshot.steamReleaseId)}/accept-and-publish`,
        { method: "POST", headers: { "idempotency-key": publishCommandRef.current } },
      );
      const payload = await response.json() as {
        data?: { state?: "MFA_REQUIRED" | "DISPATCHED"; authorizationUrl?: string | null };
        error?: { message?: string };
      };
      if (!response.ok || !payload.data?.state) {
        throw new Error(payload.error?.message ?? "Steam 发布授权服务未接受请求");
      }
      if (payload.data.state === "MFA_REQUIRED") {
        if (!payload.data.authorizationUrl) throw new Error("Steam 发布授权地址缺失");
        const authorizationUrl = new URL(payload.data.authorizationUrl);
        if (authorizationUrl.protocol !== "https:" || authorizationUrl.username || authorizationUrl.password
          || authorizationUrl.search || authorizationUrl.hash) {
          throw new Error("Steam 发布授权地址未通过安全校验");
        }
        window.location.assign(authorizationUrl.toString());
        return;
      }
      publishCommandRef.current = null;
      setPublishNotice("MFA 授权已完成，私有 Beta 上传会由工作流自动继续。");
    } catch (reason) {
      setPublishNotice(reason instanceof Error ? reason.message : "Steam 发布授权失败");
    } finally {
      setPublishBusy(false);
    }
  }

  async function cancelDelivery() {
    const reason = cancelReason.trim();
    if (!cancellable || cancelBusy || !reason) return;
    if (!window.confirm("确认取消这次交付？运行中的 Agent、E2E 与 Steam Beta 权限将被撤销。")) return;
    setCancelBusy(true);
    setCancelNotice("");
    cancelCommandRef.current ??= `cancel-${crypto.randomUUID()}`;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/delivery`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": cancelCommandRef.current,
        },
        body: JSON.stringify({ action: "cancel", reason }),
      });
      const payload = await response.json() as {
        data?: { state?: "CANCEL_REQUESTED" };
        error?: { message?: string };
      };
      if (!response.ok || payload.data?.state !== "CANCEL_REQUESTED") {
        throw new Error(payload.error?.message ?? "交付取消请求未被接受");
      }
      cancelCommandRef.current = null;
      setCancelReason("");
      setCancelNotice("取消请求已送达 Temporal；页面将在原子撤销 Agent、Runner 与 Steam 权限后显示终态。");
    } catch (reasonValue) {
      setCancelNotice(reasonValue instanceof Error ? reasonValue.message : "交付取消失败");
    } finally {
      setCancelBusy(false);
    }
  }

  return (
    <section className="local-delivery" aria-live="polite">
      <div className="local-delivery-heading">
        <div>
          <span className="eyebrow">Production · Temporal 权威投影</span>
          <h2>生产交付状态</h2>
          <p>该页面为租户隔离的只读状态；工作流只能通过规格、反馈、验收、MFA 与外部批准接口推进。</p>
        </div>
        <span className={`local-stage local-stage-${snapshot.state.toLowerCase()}`}><i /> {productionStageLabels[snapshot.state]}</span>
      </div>

      <div className="local-delivery-grid">
        <div className="local-delivery-lock">
          <span><SparkIcon /></span>
          <div><small>Temporal 工作流</small><b>{snapshot.workflowId}</b><p>状态序号 {snapshot.history.length} · 迭代 {snapshot.iteration}</p></div>
          <code>{snapshot.runId ?? "等待锁定开发运行"}</code>
        </div>
        <div className="local-delivery-metric"><small>规格</small><b>{snapshot.specRevisionId ?? "—"}</b><span>{snapshot.testPlanRevisionId ? "测试计划已冻结" : "尚未冻结测试计划"}</span></div>
        <div className="local-delivery-metric"><small>Agent 评审</small><b>{snapshot.codeReviewReceiptId ?? "—"}</b><span>{snapshot.codeReviewDigest ? `${snapshot.codeReviewDigest.slice(0, 16)}… · E2E 前已锁定` : "等待不可变评审回执"}</span></div>
        <div className="local-delivery-metric"><small>证据</small><b>{snapshot.evidenceBundleId ?? "—"}</b><span>{targetGatePassed ? "候选矩阵证据已记录" : "尚无有效候选证据"}</span></div>
        <div className="local-delivery-metric"><small>提交</small><b>{snapshot.mainCommitSha ?? snapshot.candidateCommitSha ?? "—"}</b><span>{snapshot.mainCommitSha ? "实际 main SHA" : snapshot.candidateCommitSha ? "候选 SHA" : "尚未产出"}</span></div>
      </div>

      <DeliveryRepairNotice snapshot={snapshot} />

      <div className="local-platform-row">
        {snapshot.targetMatrix.map((platform) => (
          <div className={`local-platform local-platform-${targetGatePassed ? "passed" : "queued"}`} key={platform}>
            <span>{platform === "linux" ? "L" : platform === "windows" ? "W" : "m"}</span>
            <div><b>{platformLabels[platform]}</b><small>{targetGatePassed ? "候选门禁已通过" : "锁定目标"}</small></div>
            {targetGatePassed ? <CheckIcon /> : <ClockIcon />}
          </div>
        ))}
      </div>

      <div className="local-real-validation ready">
        <div className="local-real-validation-copy">
          <span className="eyebrow">投影完整性</span>
          <h3>{projection.snapshotDigest.slice(0, 16)}…</h3>
          <p>快照已由服务端重放全部 {snapshot.history.length} 个信号并校验 SHA-256；Web 进程没有数据库写权限。</p>
        </div>
        <div className="local-real-validation-result">
          <span className="passed">只读权威状态</span>
          <div>{new Date(projection.projectedAt).toLocaleString("zh-CN")}</div>
        </div>
      </div>

      {snapshot.state === "WAITING_MFA" ? (
        <div className={`local-real-validation ${snapshot.steamReleaseId ? "ready" : "pending"}`}>
          <div className="local-real-validation-copy">
            <span className="eyebrow">接受并发布</span>
            <h3>{snapshot.steamReleaseId ?? "正在签发 Release"}</h3>
            <p>确认后会跳转到隔离的 MFA 页面；通过后自动上传 Steam 私有 Beta、执行干净客户端回装 E2E，并等待 Valve 外部门禁。</p>
            {publishNotice ? <p role="status">{publishNotice}</p> : null}
          </div>
          {snapshot.steamReleaseId ? (
            <button className="button button-acid" disabled={publishBusy} onClick={beginAcceptAndPublish} type="button">
              {publishBusy ? "正在创建 MFA 授权…" : "确认发布并完成 MFA"}
            </button>
          ) : <span className="local-real-validation-wait">工作流正在绑定 main SHA 与发布证据</span>}
        </div>
      ) : null}

      {snapshot.state === "EXTERNAL_APPROVAL_REQUIRED" && snapshot.externalGate ? (
        <div className="local-real-validation pending">
          <div className="local-real-validation-copy">
            <span className="eyebrow">Steam 外部门禁 · {snapshot.externalGate}</span>
            <h3>{externalGateCopy[snapshot.externalGate].title}</h3>
            <p>{externalGateCopy[snapshot.externalGate].description}</p>
          </div>
          <div className="local-real-validation-result">
            <span>自动验证中</span>
            <div>BuildID {snapshot.steamBuildId ?? "正在绑定"}</div>
          </div>
        </div>
      ) : null}

      {cancellable ? (
        <div className="local-real-validation pending delivery-cancel-controls">
          <div className="local-real-validation-copy">
            <span className="eyebrow">停止交付</span>
            <h3>撤销运行权限</h3>
            <p>取消会终止当前工作流，并原子撤销 Agent、推理、Runner、证据与尚未公开的 Steam 权限；进入默认分支发布边界后不可取消。</p>
            <label>
              <span>取消原因</span>
              <textarea
                disabled={cancelBusy}
                maxLength={2_000}
                onChange={(event) => setCancelReason(event.target.value)}
                placeholder="说明为什么停止这次交付（必填）"
                rows={2}
                value={cancelReason}
              />
            </label>
            {cancelNotice ? <p role="status">{cancelNotice}</p> : null}
          </div>
          <button className="button button-secondary" disabled={cancelBusy || !cancelReason.trim()} onClick={cancelDelivery} type="button">
            {cancelBusy ? "正在安全撤销…" : "取消交付"}
          </button>
        </div>
      ) : null}

      <div className="local-event-log">
        <div><span>Temporal 状态历史</span><small>不可由项目代码修改</small></div>
        <ol>
          {[...snapshot.history].reverse().slice(0, 6).map((entry) => (
            <li key={entry.sequence}><i /><span><b>{entry.signal.type}</b>{productionStageLabels[entry.resultingState]}</span><time>#{entry.sequence}</time></li>
          ))}
        </ol>
      </div>
    </section>
  );
}
