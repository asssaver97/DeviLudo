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

  if (!project) return <ProductShell><section className="project-catalog-empty product-studio-loading">{error ?? "正在进入项目…"}</section></ProductShell>;
  const specification = project.specification;
  const coreLoop = stringList(specification.coreLoop);
  const acceptance = stringList(specification.acceptanceCriteria);
  const revisions = stringList(specification.revisionNotes);
  const active = !["DRAFT", "SUCCEEDED", "FAILED", "CANCELLED"].includes(project.workflowState);

  return (
    <ProductShell>
      <section className="project-page-header product-studio-header">
        <div><div className="breadcrumb"><Link href="/projects">游戏项目</Link><span>/</span><b>{project.name}</b></div><span className="eyebrow">PROJECT · 项目</span><h1>{project.name}</h1><p>{project.concept}</p></div>
        <div className={`spec-state product-studio-state ${project.workflowState === "SUCCEEDED" ? "approved" : "draft"} state-${project.workflowState.toLowerCase()}`}><i />{WORKFLOW_LABELS[project.workflowState] ?? project.workflowState}</div>
      </section>
      {error ? <div className="inline-notice danger">{error}</div> : null}

      <div className="studio-grid product-studio-grid">
        <section className="conversation-panel product-specification-panel">
          <div className="conversation-header product-panel-heading"><div><span className="step-number">01</span><span><b>游戏规格</b><small>{project.workflowState === "DRAFT" ? "等待你的批准" : "制作中"}</small></span></div></div>
          <article className="spec-section product-spec-block"><span className="spec-section-label">产品愿景</span><p>{String(specification.vision ?? project.concept)}</p></article>
          <article className="spec-section product-spec-block"><span className="spec-section-label">核心循环</span><ol>{coreLoop.map(item => <li key={item}>{item}</li>)}</ol></article>
          <article className="spec-section product-spec-block"><span className="spec-section-label">玩家体验</span><p>{String(specification.playerExperience ?? "")}</p></article>
          <article className="spec-section product-spec-block"><span className="spec-section-label">验收标准</span><ul>{acceptance.map(item => <li key={item}>✓ {item}</li>)}</ul></article>
          {revisions.length ? <article className="spec-section product-spec-block"><span className="spec-section-label">修订记录</span><ul>{revisions.map((item, index) => <li key={`${index}:${item}`}>↳ {item}</li>)}</ul></article> : null}
          {project.workflowState === "DRAFT" ? (
            <div className="composer product-spec-actions">
              <textarea onChange={event => setNote(event.target.value)} placeholder="补充或修正规格，例如：单局改为 10 分钟，并加入手柄震动反馈……" value={note} />
              <div><button className="button button-secondary" disabled={busy || note.trim().length < 2} onClick={() => void mutate("specification", { note: note.trim() })}>提交修订</button><button className="button button-primary" disabled={busy} onClick={() => void mutate("approve")}>批准规格并启动 Agent →</button></div>
            </div>
          ) : null}
        </section>

        <aside className="spec-panel product-pipeline-panel">
          <div className="spec-panel-header product-pipeline-header"><div><span className="eyebrow">交付流水线</span><h2>PIPELINE</h2></div><span className="revision-badge">{active ? "自动刷新" : "当前状态"}</span></div>
          <div className="product-pipeline-list">
            {PIPELINE.map(([kind, label], index) => {
              const jobs = project.jobs.filter(job => job.kind === kind);
              const state = aggregateJobState(jobs.map(job => job.state));
              return (
                <div className={`product-pipeline-stage job-${state.toLowerCase()}`} key={kind}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div><b>{label}</b><small>{jobs.length ? jobs.map(job => `${job.targetOperatingSystem ?? "core"}: ${job.state}`).join(" · ") : "尚未入队"}</small></div>
                  <i>{state === "SUCCEEDED" ? "✓" : state === "RUNNING" ? "●" : state === "QUEUED" ? "…" : "○"}</i>
                </div>
              );
            })}
          </div>
          {active ? <button className="button button-secondary product-cancel-button" disabled={busy} onClick={() => void mutate("cancel")}>取消本次交付</button> : null}
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
