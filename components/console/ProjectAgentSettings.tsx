"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "./AppShell";
import { CheckIcon, GamepadIcon, ShieldIcon } from "./Icons";

type Profile = { id: string; agent: "claude-code" | "codex-cli"; scope: string; scopeId: string; state: string; installationId: string };

export function ProjectAgentSettings({ projectId }: { projectId: string }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState("正在校验项目权限…");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/agent-settings`, { headers: { accept: "application/json" } });
    const payload = await response.json() as { data?: { profiles?: Profile[]; defaults?: Record<string, string> } | Array<unknown>; meta?: { profiles?: Profile[]; defaults?: Record<string, string> }; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? "无法读取项目 Agent 设置");
    const data = Array.isArray(payload.data) ? payload.meta ?? {} : payload.data ?? {};
    const active = (data.profiles ?? []).filter((profile) => profile.state === "ACTIVE");
    setProfiles(active);
    setSelected(data.defaults?.[`project:${projectId}`] ?? data.defaults?.platform ?? active[0]?.id ?? "");
    setNotice("");
  }, [projectId]);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh().catch((error) => setNotice(error instanceof Error ? error.message : "读取失败")), 0);
    return () => window.clearTimeout(initial);
  }, [refresh]);

  async function save() {
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/agent-settings`, {
        method: "PUT", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ profileRevisionId: selected }),
      });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "项目 Agent 选择失败");
      setNotice("项目默认 Profile 已锁定；运行中的任务保持原 revision，新任务使用该选择。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "项目 Agent 选择失败"); }
    finally { setBusy(false); }
  }

  const current = profiles.find((profile) => profile.id === selected);
  return <AppShell>
    {notice ? <div className="toast" role="status"><CheckIcon /><span>{notice}</span><button onClick={() => setNotice("")} type="button">×</button></div> : null}
    <section className="page-heading settings-heading agent-settings-heading"><div><span className="eyebrow">项目策略 · {projectId}</span><h1>项目 Agent 选择</h1><p>只可选择租户与平台已经批准的 ACTIVE Profile；无法在项目层读取或覆盖 API Key。</p></div><span className="scope-badge"><GamepadIcon />ProjectOwner</span></section>
    <div className="project-agent-layout">
      <section className="settings-card">
        <div className="settings-card-title"><div><span className="step-number">A</span><h2>有效配置</h2></div><span>项目最高优先级</span></div>
        <div className="effective-agent"><span>{current?.agent === "codex-cli" ? "CX" : "CL"}</span><div><small>当前选择</small><h3>{current?.agent === "codex-cli" ? "Codex CLI" : "Claude Code"}</h3><code>{current?.id ?? "等待配置"}</code></div></div>
        <dl className="scope-chain"><div><dt>1</dt><dd><b>项目覆盖</b><small>{selected || "未设置"}</small></dd></div><div><dt>2</dt><dd><b>租户允许列表</b><small>只展示 ACTIVE Profile</small></dd></div><div><dt>3</dt><dd><b>平台兜底</b><small>Claude Code</small></dd></div></dl>
      </section>
      <section className="settings-card">
        <div className="settings-card-title"><div><span className="step-number">B</span><h2>选择 Profile</h2></div><span>{profiles.length} 项可用</span></div>
        <div className="project-profile-options">{profiles.map((profile) => <label className={selected === profile.id ? "selected" : ""} key={profile.id}><input checked={selected === profile.id} name="profile" onChange={() => setSelected(profile.id)} type="radio" /><span><b>{profile.agent === "claude-code" ? "Claude Code" : "Codex CLI"}</b><small>{profile.scope} · {profile.installationId}</small><code>{profile.id}</code></span><i>{profile.state}</i></label>)}</div>
        <button className="button button-primary project-profile-save" disabled={busy || !selected} onClick={save} type="button">{busy ? "正在锁定…" : "保存项目选择"}</button>
      </section>
      <aside className="project-agent-note"><ShieldIcon /><div><b>凭据隔离不变</b><p>这里保存的只是不可变 Profile revision ID。源码、CLI 配置和项目成员都无法得到长期上游 Key。</p><Link href="/settings/agents">由 TenantAdmin 管理 Provider →</Link></div></aside>
    </div>
  </AppShell>;
}
