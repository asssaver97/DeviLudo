"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "./AppShell";
import { CheckIcon, GamepadIcon, ShieldIcon } from "./Icons";

type AgentKind = "claude-code" | "codex-cli";
type ModelRoles = { primaryModel: string; planningModel: string; smallFastModel: string; subagentModel: string };
type Profile = {
  id: string; agent: AgentKind; scope: string; scopeId: string; state: string; installationId: string;
  providerRevisionId: string; credentialVersionId: string;
  budget: { maxUsd: number; maxTurns: number; timeoutSeconds: number };
  fallbackProfileRevisionId: string | null;
};
type Provider = { id: string; protocol: string; baseUrl: string; models: ModelRoles; state: string };
type Installation = { id: string; agent: AgentKind; version?: string; adapterVersion?: string; workerPool?: string; imageDigest?: string; state: string; health: string };
type AgentData = {
  catalog?: Array<{ installations?: Installation[] }>;
  installations?: Installation[];
  profiles?: Profile[];
  providers?: Provider[];
  defaults?: Record<string, string>;
};

export function ProjectAgentSettings({ projectId }: { projectId: string }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [selected, setSelected] = useState("");
  const [configurationSource, setConfigurationSource] = useState("等待解析");
  const [notice, setNotice] = useState("正在校验项目权限…");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/agent-settings`, { headers: { accept: "application/json" } });
    const payload = await response.json() as { data?: AgentData | Array<unknown>; meta?: AgentData; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? "无法读取项目 Agent 设置");
    const data: AgentData = Array.isArray(payload.data) ? payload.meta ?? {} : payload.data ?? {};
    const tenantSource = Object.keys(data.defaults ?? {}).find((scope) => scope.startsWith("tenant:"));
    const active = (data.profiles ?? []).filter((profile) => profile.state === "ACTIVE"
      && (profile.scope === "platform"
        || profile.scope === "tenant"
        || (profile.scope === "project" && profile.scopeId === projectId)));
    const projectSource = `project:${projectId}`;
    const source = data.defaults?.[projectSource]
      ? projectSource
      : tenantSource && data.defaults?.[tenantSource]
        ? tenantSource
        : "platform";
    setProfiles(active);
    setProviders(data.providers ?? []);
    setInstallations([...(data.catalog?.flatMap((entry) => entry.installations ?? []) ?? []), ...(data.installations ?? [])]);
    setSelected(data.defaults?.[source] ?? active[0]?.id ?? "");
    setConfigurationSource(source);
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
      setConfigurationSource(`project:${projectId}`);
      setNotice("项目默认 Profile 已锁定；运行中的任务保持原 revision，新任务使用该选择。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "项目 Agent 选择失败"); }
    finally { setBusy(false); }
  }

  const current = profiles.find((profile) => profile.id === selected);
  const currentProvider = providers.find((provider) => provider.id === current?.providerRevisionId);
  const currentInstallation = installations.find((installation) => installation.id === current?.installationId);
  return <AppShell>
    {notice ? <div className="toast" role="status"><CheckIcon /><span>{notice}</span><button onClick={() => setNotice("")} type="button">×</button></div> : null}
    <section className="page-heading settings-heading agent-settings-heading"><div><span className="eyebrow">项目策略 · {projectId}</span><h1>项目 Agent 选择</h1><p>只可选择租户与平台已经批准的 ACTIVE Profile；无法在项目层读取或覆盖 API Key。</p></div><span className="scope-badge"><GamepadIcon />ProjectOwner</span></section>
    <div className="project-agent-layout">
      <section className="settings-card">
        <div className="settings-card-title"><div><span className="step-number">A</span><h2>有效配置</h2></div><span>项目最高优先级</span></div>
        <div className="effective-agent"><span>{current?.agent === "codex-cli" ? "CX" : "CL"}</span><div><small>当前选择</small><h3>{current?.agent === "codex-cli" ? "Codex CLI" : "Claude Code"}</h3><code>{current?.id ?? "等待配置"}</code></div></div>
        <dl className="effective-lock-grid">
          <div><dt>Installation</dt><dd>{currentInstallation ? `${currentInstallation.version ?? "固定版本"} · ${currentInstallation.id}` : "等待锁定"}</dd></div>
          <div><dt>Provider</dt><dd>{currentProvider ? `${currentProvider.protocol} · ${providerHost(currentProvider.baseUrl)}` : "等待锁定"}</dd></div>
          <div><dt>模型角色</dt><dd>{currentProvider ? `primary ${currentProvider.models.primaryModel} · planning ${currentProvider.models.planningModel} · fast ${currentProvider.models.smallFastModel} · subagent ${currentProvider.models.subagentModel}` : "等待锁定"}</dd></div>
          <div><dt>预算 / 超时</dt><dd>{current ? `$${current.budget.maxUsd} · ${current.budget.maxTurns} turns · ${current.budget.timeoutSeconds}s` : "等待锁定"}</dd></div>
        </dl>
        <dl className="scope-chain"><div><dt>1</dt><dd><b>有效来源</b><small>{configurationSource}</small></dd></div><div><dt>2</dt><dd><b>租户允许列表</b><small>只展示 ACTIVE Profile</small></dd></div><div><dt>3</dt><dd><b>平台兜底</b><small>Claude Code</small></dd></div></dl>
      </section>
      <section className="settings-card">
        <div className="settings-card-title"><div><span className="step-number">B</span><h2>选择 Profile</h2></div><span>{profiles.length} 项可用</span></div>
        <div className="project-profile-options">{profiles.map((profile) => {
          const provider = providers.find((item) => item.id === profile.providerRevisionId);
          return <label className={selected === profile.id ? "selected" : ""} key={profile.id}><input checked={selected === profile.id} name="profile" onChange={() => setSelected(profile.id)} type="radio" /><span><b>{profile.agent === "claude-code" ? "Claude Code" : "Codex CLI"}</b><small>{profile.scope} · {profile.installationId} · ${profile.budget.maxUsd} / {profile.budget.maxTurns} turns</small><code>{provider?.models.primaryModel ?? "Provider revision 不可见"} · {profile.id}</code></span><i>{profile.state}</i></label>;
        })}</div>
        <button className="button button-primary project-profile-save" disabled={busy || !selected} onClick={save} type="button">{busy ? "正在锁定…" : "保存项目选择"}</button>
      </section>
      <aside className="project-agent-note"><ShieldIcon /><div><b>凭据隔离不变</b><p>这里保存的只是不可变 Profile revision ID。源码、CLI 配置和项目成员都无法得到长期上游 Key。</p><Link href="/settings/agents">由 TenantAdmin 管理 Provider →</Link></div></aside>
    </div>
  </AppShell>;
}

function providerHost(value: string): string {
  try { return new URL(value).host; }
  catch { return "无效 Provider 地址"; }
}
