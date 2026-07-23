"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpecDialogueMessage, SpecDialogueSnapshot, SpecModelResult } from "@/services/spec-dialogue/src/contracts";
import { AppShell } from "./AppShell";
import { ArrowIcon, CheckIcon, FileIcon, SparkIcon, SteamIcon } from "./Icons";
import { LocalDeliveryPanel, type DeliveryPanelStatus } from "./LocalDeliveryPanel";

type Message = {
  id: string;
  role: "assistant" | "user";
  text: string;
  meta?: string;
};

export function ProjectStudio({
  mode = "existing",
  projectId,
}: {
  mode?: "new" | "existing";
  projectId: string;
}) {
  const localFixture = process.env.DEVILUDO_LOCAL_TEST_MODE === "1";
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [revision, setRevision] = useState(0);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [projectName, setProjectName] = useState(mode === "new" ? "新构想" : "游戏项目");
  const [repositoryLabel, setRepositoryLabel] = useState("");
  const [notice, setNotice] = useState("");
  const [feedback, setFeedback] = useState("");
  const [feedbackCount, setFeedbackCount] = useState(localFixture && projectId === "ember-archipelago" ? 2 : 0);
  const [generated, setGenerated] = useState<SpecModelResult | null>(null);
  const [dialogueAuthority, setDialogueAuthority] = useState<{
    conversationId: string;
    specRevisionId: string;
    testPlanRevisionId: string;
  } | null>(null);
  const [deliveryRefresh, setDeliveryRefresh] = useState(0);
  const [candidateAcceptanceReady, setCandidateAcceptanceReady] = useState(false);
  const [humanRepairTakeover, setHumanRepairTakeover] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogueCommandRef = useRef<{ message: string; id: string } | null>(null);
  const approvalCommandRef = useRef<string | null>(null);
  const feedbackCommandRef = useRef<{ feedback: string; id: string } | null>(null);
  const acceptanceCommandRef = useRef<string | null>(null);

  const specId = `SPEC-${String(revision).padStart(3, "0")}`;
  const completion = useMemo(() => generated?.completeness ?? 0, [generated]);

  async function runLocalAutomation(commandId: string) {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/delivery/auto`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": commandId },
      body: "{}",
    });
    const payload = await response.json() as {
      data?: { stage?: string };
      meta?: { stopReason?: string };
      error?: { message?: string };
    };
    setDeliveryRefresh((value) => value + 1);
    return {
      ok: response.ok,
      stage: payload.data?.stage,
      stopReason: payload.meta?.stopReason,
      message: payload.error?.message,
    };
  }

  useEffect(() => {
    if (mode === "new") return;
    const controller = new AbortController();
    void fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { data?: { name?: string; owner?: string; repositoryName?: string }; error?: { message?: string } };
        if (!response.ok || !payload.data?.name || !payload.data.owner || !payload.data.repositoryName) {
          throw new Error(payload.error?.message ?? "项目资料不可用");
        }
        setProjectName(payload.data.name);
        setRepositoryLabel(`${payload.data.owner}/${payload.data.repositoryName}`);
      })
      .catch((reason) => { if (!controller.signal.aborted) setNotice(reason instanceof Error ? reason.message : "项目资料不可用"); });
    return () => controller.abort();
  }, [localFixture, mode, projectId]);

  useEffect(() => {
    if (!localFixture || mode === "new") return;
    const controller = new AbortController();
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/feedback`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { data?: readonly unknown[] };
        if (response.ok && Array.isArray(payload.data)) {
          setFeedbackCount((current) => Math.max(current, payload.data!.length));
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [localFixture, mode, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/conversation`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { data?: SpecDialogueSnapshot | null; error?: { message?: string } };
        if (!response.ok || !("data" in payload)) throw new Error(payload.error?.message ?? "规格快照不可用");
        if (!payload.data) {
          setMessages([]); setGenerated(null); setDialogueAuthority(null); setRevision(0); setApproved(false);
          return;
        }
        const snapshot = payload.data;
        setMessages(mergeMessages([], snapshot.messages));
        setGenerated(snapshot.result);
        setRevision(snapshot.revision);
        setApproved(snapshot.state === "APPROVED");
        setDialogueAuthority(snapshot.specRevisionId && snapshot.testPlanRevisionId ? {
          conversationId: snapshot.conversationId,
          specRevisionId: snapshot.specRevisionId,
          testPlanRevisionId: snapshot.testPlanRevisionId,
        } : null);
      })
      .catch((reason) => { if (!controller.signal.aborted) setNotice(reason instanceof Error ? `读取规格失败：${reason.message}` : "规格快照不可用"); })
      .finally(() => { if (!controller.signal.aborted) setWorkspaceReady(true); });
    return () => controller.abort();
  }, [projectId]);

  async function sendMessage(text = draft) {
    const clean = text.trim();
    if (!clean || busy) return;
    const localId = `pending-${crypto.randomUUID()}`;
    const command = dialogueCommandRef.current?.message === clean
      ? dialogueCommandRef.current
      : { message: clean, id: crypto.randomUUID() };
    dialogueCommandRef.current = command;
    setMessages((current) => [...current, { id: localId, role: "user", text: clean, meta: "刚刚" }]);
    setDraft("");
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/conversation`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `spec-chat-${command.id}` },
        body: JSON.stringify({
          expectedRevision: revision,
          message: clean,
          ...(dialogueAuthority ? { conversationId: dialogueAuthority.conversationId } : {}),
        }),
      });
      const payload = await response.json() as {
        data?: {
          conversationId: string;
          revision: number;
          specRevisionId: string;
          testPlanRevisionId: string;
          messages: readonly SpecDialogueMessage[];
          result: SpecModelResult;
        };
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "构想服务未返回有效修订");
      setMessages((current) => mergeMessages(current.filter((message) => message.id !== localId), payload.data!.messages));
      setGenerated(payload.data.result);
      dialogueCommandRef.current = null;
      setDialogueAuthority({
        conversationId: payload.data.conversationId,
        specRevisionId: payload.data.specRevisionId,
        testPlanRevisionId: payload.data.testPlanRevisionId,
      });
      setRevision(payload.data.revision);
      setApproved(false);
      window.setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }), 50);
    } catch (reason) {
      setMessages((current) => current.filter((message) => message.id !== localId));
      setDraft((current) => current || clean);
      setNotice(reason instanceof Error ? `构想服务失败：${reason.message}` : "构想服务失败");
    } finally { setBusy(false); }
  }

  async function approveSpec() {
    setBusy(true);
    approvalCommandRef.current ??= crypto.randomUUID();
    const approvalCommandId = approvalCommandRef.current;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/spec-revisions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `approve-${specId}-${approvalCommandRef.current}` },
        body: JSON.stringify({
          revision: specId,
          action: "approve",
          ...(dialogueAuthority ? {
            conversationId: dialogueAuthority.conversationId,
            expectedRevision: revision,
            specRevisionId: dialogueAuthority.specRevisionId,
            testPlanRevisionId: dialogueAuthority.testPlanRevisionId,
          } : {}),
        }),
      });
      const payload = await response.json() as { data?: { authority?: { revision?: number } }; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "规格批准失败");
      const authorityRevision = Number.isSafeInteger(payload.data?.authority?.revision)
        ? payload.data!.authority!.revision!
        : revision;
      approvalCommandRef.current = null;
      setApproved(true);
      setRevision(authorityRevision);
      setDeliveryRefresh((value) => value + 1);
      if (localFixture && mode === "existing") {
        setNotice(`SPEC-${String(authorityRevision).padStart(3, "0")} 已冻结；正在自动开发并运行真实 Godot 验证…`);
        try {
          const automatic = await runLocalAutomation(`auto-after-approval-${approvalCommandId}`);
          setNotice(automatic.ok
            ? `SPEC-${String(authorityRevision).padStart(3, "0")} 已冻结；本地开发与真实 Godot 验证已自动运行到${automatic.stage === "AWAITING_ACCEPTANCE" ? "用户验收" : "下一人工门禁"}。`
            : `SPEC-${String(authorityRevision).padStart(3, "0")} 已冻结；自动链路已安全暂停：${automatic.message ?? automatic.stopReason ?? "请查看交付控制台"}`);
        } catch (reason) {
          setNotice(`SPEC-${String(authorityRevision).padStart(3, "0")} 已冻结；自动链路暂不可用：${reason instanceof Error ? reason.message : "请查看交付控制台"}`);
        }
      } else {
        setNotice(`SPEC-${String(authorityRevision).padStart(3, "0")} 已冻结，开发 Agent 配置已锁定并入队。`);
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? `批准失败：${reason.message}` : "规格批准失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitFeedback() {
    const clean = feedback.trim();
    if (!clean) return;
    const command = feedbackCommandRef.current?.feedback === clean
      ? feedbackCommandRef.current
      : { feedback: clean, id: crypto.randomUUID() };
    feedbackCommandRef.current = command;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `feedback-${command.id}` },
        body: JSON.stringify({ feedback: clean }),
      });
      const payload = await response.json() as {
        data?: {
          invalidationAuthority?:
            | { kind: "CANDIDATE"; candidatePr: number | null; candidateSha: string; evidenceId: string | null }
            | { kind: "POST_MERGE_REPAIR"; failureReason: "MAIN_GATE_FAILURE" | "STEAM_INSTALL_FAILURE"; failureEvidenceId: string };
          snapshot?: {
            conversationId: string;
            revision: number;
            specRevisionId: string;
            testPlanRevisionId: string;
            messages: readonly SpecDialogueMessage[];
            result: SpecModelResult;
          };
        };
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(payload.error?.message ?? "创建反馈迭代失败");
      feedbackCommandRef.current = null;
      setFeedback("");
      setFeedbackCount((count) => count + 1);
      if (payload.data?.snapshot) {
        const snapshot = payload.data.snapshot;
        setRevision(snapshot.revision);
        setGenerated(snapshot.result);
        setMessages((current) => mergeMessages(current, snapshot.messages));
        setDialogueAuthority({
          conversationId: snapshot.conversationId,
          specRevisionId: snapshot.specRevisionId,
          testPlanRevisionId: snapshot.testPlanRevisionId,
        });
      } else {
        setRevision((current) => current + 1);
      }
      setApproved(false);
      setHumanRepairTakeover(false);
      setDeliveryRefresh((value) => value + 1);
      const authority = payload.data?.invalidationAuthority;
      setNotice(authority?.kind === "CANDIDATE"
        ? `反馈已创建为新的不可变迭代；${authority.candidatePr === null ? "本地 SCM 候选" : `候选 PR #${authority.candidatePr}`}、提交 ${authority.candidateSha.slice(0, 12)}${authority.evidenceId ? ` 与证据 ${authority.evidenceId}` : " 的矩阵结果"}已失效。`
        : authority?.kind === "POST_MERGE_REPAIR"
          ? `${authority.failureReason === "MAIN_GATE_FAILURE" ? "main 门禁" : "Steam 回装"}失败证据 ${authority.failureEvidenceId} 已绑定到人工修订草稿；批准后恢复自动开发。`
          : humanRepairTakeover
            ? "人工修订草稿已创建；请检查并批准新规格后恢复自动开发。"
            : "反馈已创建为新的不可变迭代；旧候选版本的测试证据已失效。");
    } catch (reason) {
      setNotice(reason instanceof Error ? `反馈失败：${reason.message}` : "创建反馈迭代失败");
    } finally {
      setBusy(false);
    }
  }

  async function acceptCandidate() {
    setBusy(true);
    try {
      acceptanceCommandRef.current ??= `accept-${crypto.randomUUID()}`;
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/acceptance`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": acceptanceCommandRef.current },
        body: "{}",
      });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "候选版本验收失败");
      const acceptanceKey = acceptanceCommandRef.current;
      acceptanceCommandRef.current = null;
      setDeliveryRefresh((value) => value + 1);
      if (localFixture) {
        setNotice("候选版本已验收；正在自动合并并运行 main SHA 发布门禁…");
        try {
          const automatic = await runLocalAutomation(`auto-after-acceptance-${acceptanceKey ?? crypto.randomUUID()}`);
          setNotice(automatic.ok
            ? "候选版本已验收；合并与 main SHA 发布门禁已自动完成，现在等待 MFA。"
            : `候选版本已验收；后续自动门禁已安全暂停：${automatic.message ?? automatic.stopReason ?? "请查看交付控制台"}`);
        } catch (reason) {
          setNotice(`候选版本已验收；后续自动门禁暂不可用：${reason instanceof Error ? reason.message : "请查看交付控制台"}`);
        }
      } else {
        setNotice("候选版本已验收；系统正在合并固定的 Draft PR，随后会基于实际 main SHA 重跑发布门禁。");
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? `验收失败：${reason.message}` : "候选版本验收失败");
    } finally {
      setBusy(false);
    }
  }

  const syncDelivery = useCallback((status: DeliveryPanelStatus) => {
    const ready = status.mode === "LOCAL_D1"
      ? status.stage === "AWAITING_ACCEPTANCE"
      : status.stage === "WAITING_USER_ACCEPTANCE";
    if (!ready) acceptanceCommandRef.current = null;
    setCandidateAcceptanceReady(ready);
    setHumanRepairTakeover(status.humanRepairTakeover);
    const awaitingApproval = status.mode === "LOCAL_D1"
      ? status.stage === "AWAITING_SPEC_APPROVAL"
      : status.stage === "IDEATION" || status.stage === "WAITING_SPEC_APPROVAL";
    setApproved(!awaitingApproval);
  }, []);

  return (
    <AppShell>
      {notice ? <div className="toast" role="status"><CheckIcon /> <span>{notice}</span><button onClick={() => setNotice("")} type="button">×</button></div> : null}

      <section className="project-page-header">
        <div>
          <div className="breadcrumb"><Link href="/projects">游戏项目</Link><span>/</span><b>{mode === "new" ? "新构想" : projectName}</b></div>
          <h1>{mode === "new" ? "把想法聊成可开发的游戏" : projectName}</h1>
          <p>{mode === "new" ? "构想助手会追问关键细节，并把每个决定实时写入规格。" : localFixture ? "本地隔离项目 · Fixture 交付链" : repositoryLabel ? `${repositoryLabel} · GitHub App 已绑定` : "正在读取权威项目资料…"}</p>
        </div>
        <div className="project-header-actions">
          <span className={`spec-state ${approved ? "approved" : "draft"}`}><i /> {approved ? `${specId} 已批准` : `${specId} 草稿`}</span>
          {mode === "existing" ? <Link className="button button-secondary" href={`/projects/${encodeURIComponent(projectId)}/steam-settings`}><SteamIcon /> Steam 设置</Link> : null}
        </div>
      </section>

      <div className="studio-grid">
        <section className="conversation-panel">
          <div className="conversation-header">
            <div><span className="assistant-mark"><SparkIcon /></span><span><b>构想助手</b><small>低延迟对话模型 · 不使用开发 Agent</small></span></div>
            <span className="saving-indicator"><i /> 自动保存</span>
          </div>

          <div className="conversation-stream" ref={scrollRef}>
            <div className="conversation-date"><span>今天</span></div>
            {workspaceReady && messages.length === 0 ? <div className="message assistant"><span className="message-avatar">DL</span><div><p>先描述你想做的游戏：玩家是谁、核心目标是什么、一次游玩大约多久？我会逐轮把答案整理成可批准规格。</p><small>构想助手 · 新对话</small></div></div> : null}
            {messages.map((message) => (
              <div className={`message ${message.role}`} key={message.id}>
                {message.role === "assistant" ? <span className="message-avatar">DL</span> : null}
                <div><p>{message.text}</p><small>{message.meta}</small></div>
              </div>
            ))}
            {busy && !approved ? <div className="message assistant"><span className="message-avatar">DL</span><div className="typing"><i /><i /><i /></div></div> : null}
          </div>

          <div className="quick-replies">
            <button disabled={!workspaceReady || busy} onClick={() => sendMessage("战斗偏技能组合，玩家只需要控制船的方向和三种船载技能。") } type="button">技能组合优先</button>
            <button disabled={!workspaceReady || busy} onClick={() => sendMessage("允许随时保存退出，回来后从当前岛屿入口继续。") } type="button">随时保存退出</button>
            <button disabled={!workspaceReady || busy} onClick={() => sendMessage("首版只做简体中文，英文放到后续版本。") } type="button">首版仅中文</button>
          </div>

          <div className="composer">
            <textarea
              aria-label="回复构想助手"
              disabled={!workspaceReady}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={workspaceReady ? "描述你想要的体验、规则或修改……" : "正在读取规格快照……"}
              rows={3}
              value={draft}
            />
            <div><span>Enter 发送 · Shift + Enter 换行</span><button aria-label="发送" disabled={!workspaceReady || !draft.trim() || busy} onClick={() => sendMessage()} type="button"><ArrowIcon /></button></div>
          </div>
        </section>

        <aside className="spec-panel">
          <div className="spec-panel-header">
            <div><span className="eyebrow">实时游戏规格</span><h2>{specId}</h2></div>
            <span className="revision-badge">rev {revision}</span>
          </div>

          <div className="spec-completeness">
            <div><span>规格完整度</span><b>{completion}%</b></div>
            <div className="spec-track"><span style={{ width: `${completion}%` }} /></div>
            <p>{!generated ? "完成首轮构想后生成可审阅规格" : completion < 80 ? "仍有关键决定需要确认" : "已具备冻结测试计划的条件"}</p>
          </div>

          {generated ? <>
            <div className="spec-section">
              <span className="spec-section-label">游戏支柱</span>
              <div className="pillar-list">{generated.spec.features.map((feature) => <span key={feature}>{feature}</span>)}</div>
            </div>

            <div className="spec-section spec-facts">
              <span className="spec-section-label">范围</span>
              <dl>
                <div><dt>标题</dt><dd>{generated.spec.title}</dd></div>
                <div><dt>类型</dt><dd>{generated.spec.genre}</dd></div>
                <div><dt>引擎</dt><dd>Godot {generated.spec.godotVersion}</dd></div>
                <div><dt>玩家</dt><dd>桌面单机</dd></div>
                <div><dt>目标</dt><dd>{generated.spec.targetPlatforms.join(" · ")}</dd></div>
              </dl>
            </div>

            <div className="spec-section">
              <span className="spec-section-label">验收标准</span>
              <ul className="acceptance-list">
                {generated.spec.acceptanceCriteria.map((item) => <li key={item.id}><CheckIcon /><span>{item.description}</span></li>)}
              </ul>
            </div>

            <div className="spec-section">
              <span className="spec-section-label">{approved ? "冻结测试计划" : "测试计划草稿"}</span>
              <div className="test-chip-list">{generated.testPlan.scenarios.map((test) => <span key={test}>{test}</span>)}</div>
            </div>
          </> : <div className="spec-section">
            <span className="spec-section-label">等待构想</span>
            <p>这里不会预填演示游戏。发送第一条构想后，平台才会生成项目专属的游戏支柱、范围、验收标准和测试计划。</p>
          </div>}

          <div className="spec-footer">
            {approved ? (
              <div className="approved-banner"><CheckIcon /><span><b>规格已冻结</b><small>新反馈将创建下一次不可变迭代</small></span></div>
            ) : (
              <button className="button button-acid approve-button" disabled={!workspaceReady || busy || completion < 68 || !dialogueAuthority} onClick={approveSpec} type="button"><CheckIcon /> 批准 {specId} 并启动开发</button>
            )}
            <p>{generated
              ? "批准会锁定规格、Agent Profile、提交和目标矩阵。之后的配置变化不会影响本次任务。"
              : "首轮构想尚未生成规格，因此当前没有可批准或开发的内容。"}</p>
          </div>
        </aside>
      </div>

      {mode === "existing" && (candidateAcceptanceReady || humanRepairTakeover) ? (
        <section className="iteration-section">
          <div className="iteration-heading">
            <div>
              <span className="eyebrow">{humanRepairTakeover ? "交付流程需要人工修订" : "候选版本反馈"}</span>
              <h2>{humanRepairTakeover ? "提交人工修改说明" : "继续迭代"}</h2>
              <p>{humanRepairTakeover
                ? "平台已暂停自动重试。修改说明会生成新的不可变规格草稿，批准后才会恢复开发。"
                : "反馈会进入同一 Draft PR，并让旧证据立即失效。"}</p>
            </div>
            <span>{feedbackCount} 次历史迭代</span>
          </div>
          <div className="feedback-box">
            <span className="feedback-icon"><FileIcon /></span>
            <textarea aria-label={humanRepairTakeover ? "人工修复修改说明" : "候选版本反馈"} onChange={(event) => setFeedback(event.target.value)} placeholder={humanRepairTakeover ? "说明需要调整的玩法、范围或验收标准……" : "例如：风暴出现得太频繁，希望新手前五分钟最多出现一次……"} rows={3} value={feedback} />
            <button className="button button-primary" disabled={!feedback.trim() || busy} onClick={submitFeedback} type="button">{humanRepairTakeover ? "生成新规格草稿" : "创建新迭代"} <ArrowIcon /></button>
          </div>
          {candidateAcceptanceReady ? <button className="button button-acid" disabled={busy} onClick={acceptCandidate} type="button"><CheckIcon /> 接受候选版本并合并</button> : null}
        </section>
      ) : null}

      {mode === "existing" && (!localFixture || approved || projectId === "ember-archipelago") ? <LocalDeliveryPanel
        localFixture={localFixture}
        onStatus={syncDelivery}
        projectId={projectId}
        refreshToken={deliveryRefresh}
      /> : null}
    </AppShell>
  );
}

function mergeMessages(current: readonly Message[], persisted: readonly SpecDialogueMessage[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of persisted) {
    byId.set(message.id, {
      id: message.id,
      role: message.role,
      text: message.text,
      meta: message.role === "assistant" ? "构想助手 · 已保存" : "已保存",
    });
  }
  return [...byId.values()];
}
