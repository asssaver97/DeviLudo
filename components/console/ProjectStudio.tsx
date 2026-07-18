"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import type { SpecDialogueMessage, SpecModelResult } from "@/services/spec-dialogue/src/contracts";
import { AppShell } from "./AppShell";
import { ArrowIcon, CheckIcon, ClockIcon, FileIcon, GithubIcon, SparkIcon } from "./Icons";
import { LocalDeliveryPanel, type DeliveryPanelStatus } from "./LocalDeliveryPanel";

type Message = {
  id: string;
  role: "assistant" | "user";
  text: string;
  meta?: string;
};

const initialMessages: Message[] = [
  {
    id: "history-1",
    role: "user",
    text: "我想做一款发生在漂浮群岛上的航海生存游戏。玩家驾驶一艘会成长的船，在岛屿之间收集余烬。",
    meta: "10:06",
  },
  {
    id: "history-2",
    role: "assistant",
    text: "这个核心意象很清楚。为了让首个可玩版本能在一周内闭环，我建议先确定一次航行的目标：玩家是带着资源安全返港，还是击败守护群岛的首领？",
    meta: "构想助手 · 10:06",
  },
  {
    id: "history-3",
    role: "user",
    text: "每局 20 分钟，找到三枚余烬核心后返港。途中会有风暴和海盗，但不想做成很硬核的生存游戏。",
    meta: "10:08",
  },
  {
    id: "history-4",
    role: "assistant",
    text: "明白：轻量资源压力、明确的 20 分钟目标。新手局可以把失败定义为船体归零或时间耗尽，并保留少量永久材料，避免失败没有收获。你希望战斗偏即时瞄准，还是让玩家更专注航线与技能组合？",
    meta: "构想助手 · 10:08",
  },
];

const acceptance = [
  "从新游戏进入核心循环不超过 45 秒",
  "20 分钟内可完成收集、返港与结算闭环",
  "暂停、设置、保存与读取均支持键鼠和手柄",
  "Windows / Linux / macOS 生产导出无崩溃",
  "失败后保留 20% 材料，且不会破坏存档",
];

const frozenTests = ["启动与退出", "核心循环", "胜负条件", "存档回读", "暂停设置", "性能基线", "崩溃捕获", "视觉快照"];

export function ProjectStudio({ mode = "existing" }: { mode?: "new" | "existing" }) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [revision, setRevision] = useState(mode === "new" ? 1 : 8);
  const [approved, setApproved] = useState(mode === "existing");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [feedback, setFeedback] = useState("");
  const [feedbackCount, setFeedbackCount] = useState(2);
  const [generated, setGenerated] = useState<SpecModelResult | null>(null);
  const [dialogueAuthority, setDialogueAuthority] = useState<{
    conversationId: string;
    specRevisionId: string;
    testPlanRevisionId: string;
  } | null>(null);
  const [deliveryRefresh, setDeliveryRefresh] = useState(0);
  const [candidateAcceptanceReady, setCandidateAcceptanceReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const approvalCommandRef = useRef<string | null>(null);
  const acceptanceCommandRef = useRef<string | null>(null);

  const specId = `SPEC-${String(revision).padStart(3, "0")}`;
  const completion = useMemo(() => generated?.completeness ?? Math.min(92, 44 + messages.length * 6), [generated, messages.length]);

  async function sendMessage(text = draft) {
    const clean = text.trim();
    if (!clean || busy) return;
    const projectId = mode === "new" ? "new-project-draft" : "ember-archipelago";
    const localId = `pending-${crypto.randomUUID()}`;
    const commandId = crypto.randomUUID();
    setMessages((current) => [...current, { id: localId, role: "user", text: clean, meta: "刚刚" }]);
    setDraft("");
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/conversation`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `spec-chat-${commandId}` },
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
      setNotice(reason instanceof Error ? `构想服务失败：${reason.message}` : "构想服务失败");
    } finally { setBusy(false); }
  }

  async function approveSpec() {
    setBusy(true);
    const projectId = mode === "new" ? "new-project-draft" : "ember-archipelago";
    approvalCommandRef.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/projects/${projectId}/spec-revisions`, {
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
      approvalCommandRef.current = null;
      setApproved(true);
      if (Number.isSafeInteger(payload.data?.authority?.revision)) setRevision(payload.data!.authority!.revision!);
      setDeliveryRefresh((value) => value + 1);
      setNotice(`${specId} 已冻结，Claude Code 开发任务已锁定并入队。`);
    } catch (reason) {
      setNotice(reason instanceof Error ? `批准失败：${reason.message}` : "规格批准失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitFeedback() {
    if (!feedback.trim()) return;
    setBusy(true);
    try {
      const response = await fetch("/api/projects/ember-archipelago/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `feedback-${Date.now()}` },
        body: JSON.stringify({ feedback }),
      });
      const payload = await response.json() as {
        data?: {
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
      setDeliveryRefresh((value) => value + 1);
      setNotice("反馈已创建为新的不可变迭代；旧候选版本的测试证据已失效。");
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
      const response = await fetch("/api/projects/ember-archipelago/acceptance", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": acceptanceCommandRef.current },
        body: "{}",
      });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "候选版本验收失败");
      acceptanceCommandRef.current = null;
      setDeliveryRefresh((value) => value + 1);
      setNotice("候选版本已验收；系统正在合并固定的 Draft PR，随后会基于实际 main SHA 重跑发布门禁。");
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
    const awaitingApproval = status.mode === "LOCAL_D1"
      ? status.stage === "AWAITING_SPEC_APPROVAL"
      : status.stage === "IDEATION" || status.stage === "WAITING_SPEC_APPROVAL";
    setApproved(!awaitingApproval);
    if (status.mode === "LOCAL_D1") {
      const persistedRevision = Number.parseInt(status.specRevisionId.replace(/^SPEC-/, ""), 10);
      if (Number.isInteger(persistedRevision)) setRevision(persistedRevision);
    }
  }, []);

  return (
    <AppShell>
      {notice ? <div className="toast" role="status"><CheckIcon /> <span>{notice}</span><button onClick={() => setNotice("")} type="button">×</button></div> : null}

      <section className="project-page-header">
        <div>
          <div className="breadcrumb"><Link href="/">游戏项目</Link><span>/</span><b>{mode === "new" ? "新构想" : "余烬群岛"}</b></div>
          <h1>{mode === "new" ? "把想法聊成可开发的游戏" : "余烬群岛"}</h1>
          <p>{mode === "new" ? "构想助手会追问关键细节，并把每个决定实时写入规格。" : "候选 PR #18 · dev/spec-07 · 8b7e4a2"}</p>
        </div>
        <div className="project-header-actions">
          <span className={`spec-state ${approved ? "approved" : "draft"}`}><i /> {approved ? `${specId} 已批准` : `${specId} 草稿`}</span>
          {mode === "existing" ? <a className="button button-secondary" href="https://github.com" rel="noreferrer" target="_blank"><GithubIcon /> Draft PR #18</a> : null}
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
            {messages.map((message) => (
              <div className={`message ${message.role}`} key={message.id}>
                {message.role === "assistant" ? <span className="message-avatar">DL</span> : null}
                <div><p>{message.text}</p><small>{message.meta}</small></div>
              </div>
            ))}
            {busy && !approved ? <div className="message assistant"><span className="message-avatar">DL</span><div className="typing"><i /><i /><i /></div></div> : null}
          </div>

          <div className="quick-replies">
            <button onClick={() => sendMessage("战斗偏技能组合，玩家只需要控制船的方向和三种船载技能。") } type="button">技能组合优先</button>
            <button onClick={() => sendMessage("允许随时保存退出，回来后从当前岛屿入口继续。") } type="button">随时保存退出</button>
            <button onClick={() => sendMessage("首版只做简体中文，英文放到后续版本。") } type="button">首版仅中文</button>
          </div>

          <div className="composer">
            <textarea
              aria-label="回复构想助手"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="描述你想要的体验、规则或修改……"
              rows={3}
              value={draft}
            />
            <div><span>Enter 发送 · Shift + Enter 换行</span><button aria-label="发送" disabled={!draft.trim() || busy} onClick={() => sendMessage()} type="button"><ArrowIcon /></button></div>
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
            <p>{completion < 80 ? "还需确认 2 个关键决定" : "已具备冻结测试计划的条件"}</p>
          </div>

          <div className="spec-section">
            <span className="spec-section-label">游戏支柱</span>
            <div className="pillar-list"><span>轻量航海压力</span><span>20 分钟闭环</span><span>船只成长</span></div>
          </div>

          <div className="spec-section spec-facts">
            <span className="spec-section-label">范围</span>
            <dl>
              <div><dt>引擎</dt><dd>Godot {generated?.spec.godotVersion ?? "4.5.0"} · 2D</dd></div>
              <div><dt>玩家</dt><dd>桌面单机</dd></div>
              <div><dt>输入</dt><dd>键鼠 + 手柄</dd></div>
              <div><dt>目标</dt><dd>{generated?.spec.targetPlatforms.join(" · ") ?? "Win · Linux · macOS"}</dd></div>
              <div><dt>局长</dt><dd>约 20 分钟</dd></div>
            </dl>
          </div>

          <div className="spec-section">
            <span className="spec-section-label">验收标准</span>
            <ul className="acceptance-list">
              {(generated?.spec.acceptanceCriteria.map((item) => item.description) ?? acceptance).map((item) => <li key={item}><CheckIcon /><span>{item}</span></li>)}
            </ul>
          </div>

          <div className="spec-section">
            <span className="spec-section-label">冻结测试计划</span>
            <div className="test-chip-list">{(generated?.testPlan.scenarios ?? frozenTests).map((test) => <span key={test}>{test}</span>)}</div>
          </div>

          <div className="spec-footer">
            {approved ? (
              <div className="approved-banner"><CheckIcon /><span><b>规格已冻结</b><small>新反馈将创建下一次不可变迭代</small></span></div>
            ) : (
              <button className="button button-acid approve-button" disabled={busy || completion < 68} onClick={approveSpec} type="button"><CheckIcon /> 批准 {specId} 并启动开发</button>
            )}
            <p>批准会锁定规格、Agent Profile、提交和目标矩阵。之后的配置变化不会影响本次任务。</p>
          </div>
        </aside>
      </div>

      {mode === "existing" ? (
        <section className="iteration-section">
          <div className="iteration-heading">
            <div><span className="eyebrow">候选版本反馈</span><h2>继续迭代</h2><p>反馈会进入同一 Draft PR，并让旧证据立即失效。</p></div>
            <span>{feedbackCount} 次历史迭代</span>
          </div>
          <div className="feedback-box">
            <span className="feedback-icon"><FileIcon /></span>
            <textarea aria-label="候选版本反馈" onChange={(event) => setFeedback(event.target.value)} placeholder="例如：风暴出现得太频繁，希望新手前五分钟最多出现一次……" rows={3} value={feedback} />
            <button className="button button-primary" disabled={!feedback.trim() || busy} onClick={submitFeedback} type="button">创建新迭代 <ArrowIcon /></button>
          </div>
          {candidateAcceptanceReady ? (
            <button className="button button-acid" disabled={busy} onClick={acceptCandidate} type="button"><CheckIcon /> 接受候选版本并合并</button>
          ) : (
            <div className="release-gate-note"><ClockIcon /><span><b>候选验收尚未开放</b><small>所选三个平台全部通过后，才可合并；发布仍需实际 main SHA 门禁与 MFA。</small></span></div>
          )}
        </section>
      ) : null}

      <LocalDeliveryPanel
        onStatus={syncDelivery}
        projectId={mode === "new" ? "new-project-draft" : "ember-archipelago"}
        refreshToken={deliveryRefresh}
      />
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
