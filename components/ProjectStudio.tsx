"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ProductProjectDetail } from "@/lib/product/contracts";
import { WORKFLOW_LABELS } from "@/lib/product/contracts";
import { ProductShell } from "./ProductShell";

const PIPELINE = [
  ["AGENT_GENERATION", "Agent 生成"],
  ["ARTIFACT_BUILD", "制品构建"],
  ["E2E_TEST", "跨平台 E2E"],
  ["ARTIFACT_SIGN", "平台签名"],
  ["STEAM_PUBLISH", "Steam 上传"],
  ["STEAM_CLEAN_INSTALL", "干净回装"],
] as const;

export function ProjectStudio({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProductProjectDetail | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" });
    const payload = await response.json() as { project?: ProductProjectDetail; message?: string };
    if (!response.ok || !payload.project) throw new Error(payload.message ?? `项目读取失败 (${response.status})`);
    setProject(payload.project);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    const initial = setTimeout(() => {
      void load().catch(reason => active && setError(reason instanceof Error ? reason.message : "项目读取失败"));
    }, 0);
    const timer = setInterval(() => void load().catch(() => undefined), 1500);
    return () => { active = false; clearTimeout(initial); clearInterval(timer); };
  }, [load]);

  async function mutate(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? `操作失败 (${response.status})`);
      setNote("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (!project) return <ProductShell><div className="studioLoading">{error ?? "正在进入项目工作室…"}</div></ProductShell>;
  const specification = project.specification;
  const coreLoop = stringList(specification.coreLoop);
  const acceptance = stringList(specification.acceptanceCriteria);
  const revisions = stringList(specification.revisionNotes);
  const active = !["DRAFT", "SUCCEEDED", "FAILED", "CANCELLED"].includes(project.workflowState);

  return (
    <ProductShell>
      <section className="studioHeader">
        <div><Link href="/">← 游戏项目</Link><p className="productEyebrow">PROJECT STUDIO · 项目工作室</p><h1>{project.name}</h1><p>{project.concept}</p></div>
        <div className={`studioState state-${project.workflowState.toLowerCase()}`}><i />{WORKFLOW_LABELS[project.workflowState] ?? project.workflowState}</div>
      </section>
      {error ? <div className="productError">{error}</div> : null}

      <div className="studioLayout">
        <section className="specPanel">
          <div className="panelHeading"><div><span>01</span><h2>游戏规格</h2></div><small>{project.workflowState === "DRAFT" ? "等待你的批准" : "已锁定到本次工作流"}</small></div>
          <article className="specBlock"><label>产品愿景</label><p>{String(specification.vision ?? project.concept)}</p></article>
          <article className="specBlock"><label>核心循环</label><ol>{coreLoop.map(item => <li key={item}>{item}</li>)}</ol></article>
          <article className="specBlock"><label>玩家体验</label><p>{String(specification.playerExperience ?? "")}</p></article>
          <article className="specBlock"><label>验收标准</label><ul>{acceptance.map(item => <li key={item}>✓ {item}</li>)}</ul></article>
          {revisions.length ? <article className="specBlock"><label>修订记录</label><ul>{revisions.map((item, index) => <li key={`${index}:${item}`}>↳ {item}</li>)}</ul></article> : null}
          {project.workflowState === "DRAFT" ? (
            <div className="specActions">
              <textarea onChange={event => setNote(event.target.value)} placeholder="补充或修正规格，例如：单局改为 10 分钟，并加入手柄震动反馈……" value={note} />
              <div><button className="secondaryButton" disabled={busy || note.trim().length < 2} onClick={() => void mutate("specification", { note: note.trim() })}>提交修订</button><button className="approveButton" disabled={busy} onClick={() => void mutate("approve")}>批准规格并启动 Agent →</button></div>
            </div>
          ) : null}
        </section>

        <aside className="pipelinePanel">
          <div className="panelHeading"><div><span>02</span><h2>交付流水线</h2></div><small>{active ? "自动刷新" : "当前状态"}</small></div>
          <div className="pipelineList">
            {PIPELINE.map(([kind, label], index) => {
              const jobs = project.jobs.filter(job => job.kind === kind);
              const state = aggregateJobState(jobs.map(job => job.state));
              return (
                <div className={`pipelineStage job-${state.toLowerCase()}`} key={kind}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div><b>{label}</b><small>{jobs.length ? jobs.map(job => `${job.targetOperatingSystem ?? "core"}: ${job.state}`).join(" · ") : "尚未入队"}</small></div>
                  <i>{state === "SUCCEEDED" ? "✓" : state === "RUNNING" ? "●" : state === "QUEUED" ? "…" : "○"}</i>
                </div>
              );
            })}
          </div>
          {active ? <button className="cancelButton" disabled={busy} onClick={() => void mutate("cancel")}>取消本次交付</button> : null}
          <div className="runtimeNote"><b>本地执行范围</b><p>Core 负责 Agent 与制品；本机 macOS 节点负责 macOS 测试、签名和干净回装。Linux/Windows 作业会安全等待相应节点。</p></div>
        </aside>
      </div>
    </ProductShell>
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function aggregateJobState(states: readonly string[]): string {
  if (!states.length) return "PENDING";
  if (states.some(state => state === "FAILED")) return "FAILED";
  if (states.some(state => state === "RUNNING")) return "RUNNING";
  if (states.every(state => state === "SUCCEEDED")) return "SUCCEEDED";
  if (states.some(state => state === "QUEUED" || state === "RETRY")) return "QUEUED";
  return states[0];
}
