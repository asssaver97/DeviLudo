"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AppShell } from "./AppShell";
import { CheckIcon, GamepadIcon, ShieldIcon, SparkIcon } from "./Icons";

type AgentKind = "claude-code" | "codex-cli";
type ModelRoles = { primaryModel: string; planningModel: string; smallFastModel: string; subagentModel: string };
type Profile = {
  id: string; agent: AgentKind; scope: string; scopeId: string; state: string; installationId: string;
  providerRevisionId: string; credentialVersionId: string;
  budget: { maxUsd: number; maxTurns: number; timeoutSeconds: number };
  fallbackProfileRevisionId: string | null;
};
type Provider = { id: string; agent: AgentKind; baseUrl: string; protocol: string; models: ModelRoles; state: string };
type Credential = { id: string; familyId?: string; label: string; scope?: string; scopeId?: string; state: string; version?: number; createdAt?: string; rotatedAt?: string | null; lastUsedAt?: string | null; maskedFingerprint?: string; masked?: string };
type Installation = { id: string; agent: AgentKind; state: string; health: string; version?: string; workerPool?: string; imageDigest?: string };
type AgentData = {
  catalog?: Array<{ id: AgentKind; installations?: Installation[] }>;
  installations?: Installation[];
  profiles?: Profile[];
  providers?: Provider[];
  credentials?: Credential[];
  defaults?: Record<string, string>;
  meta?: Record<string, unknown>;
};

export function TenantAgentSettings() {
  const [data, setData] = useState<AgentData | null>(null);
  const [tenantId, setTenantId] = useState("tenant-local");
  const [role, setRole] = useState("TenantAdmin");
  const [notice, setNotice] = useState("正在读取租户 Agent 策略…");
  const [busy, setBusy] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [rotatingCredentialId, setRotatingCredentialId] = useState("");
  const [restoringCredentialId, setRestoringCredentialId] = useState("");
  const [localFixture, setLocalFixture] = useState(false);
  const [draftAgent, setDraftAgent] = useState<AgentKind>("claude-code");

  const refresh = useCallback(async () => {
    const [agentResponse, sessionResponse] = await Promise.all([
      fetch("/api/settings/agents", { headers: { accept: "application/json" } }),
      fetch("/api/auth/session", { headers: { accept: "application/json" } }),
    ]);
    const agentPayload = await agentResponse.json() as { data?: AgentData; meta?: Record<string, unknown>; error?: { message?: string } };
    const sessionPayload = await sessionResponse.json() as { data?: { tenantId: string; role: string; authMode?: string } };
    if (!agentResponse.ok || !agentPayload.data) throw new Error(agentPayload.error?.message ?? "无法读取租户 Agent 配置");
    const normalized = normalize(agentPayload.data, agentPayload.meta);
    setData(normalized);
    setTenantId(sessionPayload.data?.tenantId ?? "tenant-local");
    setRole(sessionPayload.data?.role ?? "TenantAdmin");
    setLocalFixture(sessionPayload.data?.authMode === "local-fixture");
    const visibleActive = (normalized.profiles ?? []).filter((profile) => profile.state === "ACTIVE"
      && (profile.scope === "platform" || profile.scopeId === (sessionPayload.data?.tenantId ?? "tenant-local")));
    const exactDefault = normalized.defaults?.[`tenant:${sessionPayload.data?.tenantId ?? "tenant-local"}`];
    setSelectedProfile(visibleActive.some((profile) => profile.id === exactDefault)
      ? exactDefault ?? "" : normalized.defaults?.platform ?? visibleActive[0]?.id ?? "");
    setNotice("");
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh().catch((error) => setNotice(error instanceof Error ? error.message : "读取失败")), 0);
    return () => window.clearTimeout(initial);
  }, [refresh]);

  const installations = useMemo(() => {
    const rows = [...(data?.catalog?.flatMap((entry) => entry.installations ?? []) ?? []), ...(data?.installations ?? [])];
    return rows.filter((entry) => ["READY", "CANARY", "ACTIVE"].includes(entry.state));
  }, [data]);
  const activeProfiles = (data?.profiles ?? []).filter((profile) => profile.state === "ACTIVE"
    && (profile.scope === "platform" || (profile.scope === "tenant" && profile.scopeId === tenantId)));
  const credentialRows = data?.credentials ?? [];
  const credentials = credentialRows.filter((credential) => credential.state === "ACTIVE");
  const draftInstallations = installations.filter((installation) => installation.agent === draftAgent);
  const draftFallbacks = activeProfiles.filter((profile) => profile.agent === draftAgent
    && profile.scope === "tenant" && profile.scopeId === tenantId);
  const effectiveProfile = activeProfiles.find((profile) => profile.id === selectedProfile);
  const effectiveProvider = (data?.providers ?? []).find((provider) => provider.id === effectiveProfile?.providerRevisionId);
  const readOnly = role !== "TenantAdmin";

  async function createCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate("/api/settings/agents/credentials", "POST", {
      label: String(form.get("label") ?? ""), apiKey: String(form.get("apiKey") ?? ""),
    }, "API Key 已写入 Vault；页面只会再次显示掩码和版本。", event.currentTarget);
  }

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const agent = String(form.get("agent")) as AgentKind;
    const credentialVersionId = String(form.get("credentialVersionId") ?? "");
    await mutate("/api/settings/agents/profiles", "POST", {
      agent,
      installationId: String(form.get("installationId") ?? ""),
      credentialVersionId,
      baseUrl: String(form.get("baseUrl") ?? ""),
      authentication: agent === "claude-code" ? "x-api-key" : "bearer",
      primaryModel: String(form.get("primaryModel") ?? ""),
      planningModel: String(form.get("planningModel") ?? ""),
      smallFastModel: String(form.get("smallFastModel") ?? ""),
      subagentModel: String(form.get("subagentModel") ?? ""),
      inputUsdPerMillionTokens: Number(form.get("inputPrice") ?? 0),
      outputUsdPerMillionTokens: Number(form.get("outputPrice") ?? 0),
      maxBudgetUsd: Number(form.get("budget") ?? 25),
      maxTurns: Number(form.get("maxTurns") ?? 100),
      timeoutSeconds: Number(form.get("timeoutSeconds") ?? 7200),
      dataRegion: String(form.get("dataRegion") ?? ""),
      retentionPolicy: String(form.get("retentionPolicy") ?? ""),
      trainingPolicy: String(form.get("trainingPolicy") ?? ""),
      ...(String(form.get("fallbackProfileRevisionId") ?? "")
        ? { fallbackProfileRevisionId: String(form.get("fallbackProfileRevisionId")) }
        : {}),
    }, "Provider/Profile 草稿已创建；安全管理员批准前不会影响新任务。", event.currentTarget);
  }

  async function rotateCredential(event: FormEvent<HTMLFormElement>, credentialId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const replaced = await mutate(`/api/settings/agents/credentials/${encodeURIComponent(credentialId)}/rotate`, "POST", {
      apiKey: String(form.get("apiKey") ?? ""),
    }, "凭据已安全轮换；Provider/Profile 后继和默认项已在探针通过后原子切换。", event.currentTarget);
    if (replaced) setRotatingCredentialId("");
  }

  async function restoreLocalBinding(event: FormEvent<HTMLFormElement>, credentialId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const restored = await mutate(`/api/settings/agents/credentials/${encodeURIComponent(credentialId)}/restore-local-binding`, "POST", {
      apiKey: String(form.get("apiKey") ?? ""),
    }, "活动凭据指纹一致；租户 Provider/Profile 的本机绑定已重新探针并激活。", event.currentTarget);
    if (restored) setRestoringCredentialId("");
  }

  async function revokeCredential(credential: Credential) {
    if (!window.confirm(`立即撤销 ${credential.label}（${credential.id}）？撤销后该版本不能再签发新租约。`)) return;
    await mutate(`/api/settings/agents/credentials/${encodeURIComponent(credential.id)}/revoke`, "POST", {},
      "凭据版本已撤销；受影响的新任务会保持 Provider 等待状态。");
  }

  async function selectDefault() {
    await mutate("/api/settings/agents/default", "PUT", { profileRevisionId: selectedProfile }, "租户默认已更新，只影响之后入队的任务。");
  }

  async function validateProfile(profileId: string) {
    await mutate(`/api/settings/agents/profiles/${encodeURIComponent(profileId)}/validate`, "POST", {}, "Provider 探针已完成；Profile 正在等待 SecurityAdmin 激活。");
  }

  async function mutate(path: string, method: "POST" | "PUT", body: Record<string, unknown>, success: string, form?: HTMLFormElement): Promise<boolean> {
    setBusy(true); setNotice("");
    try {
      const response = await fetch(path, { method, headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "配置操作失败");
      form?.reset(); await refresh(); setNotice(success); return true;
    } catch (error) { setNotice(error instanceof Error ? error.message : "配置操作失败"); return false; }
    finally { setBusy(false); }
  }

  return <AppShell>
    {notice ? <div className="toast" role="status"><CheckIcon /><span>{notice}</span><button onClick={() => setNotice("")} type="button">×</button></div> : null}
    <section className="page-heading settings-heading agent-settings-heading">
      <div><span className="eyebrow">租户策略 · {tenantId}</span><h1>开发 Agent</h1><p>配置租户 BYOK 与 Provider 草稿，并从已批准 Profile 中选择默认 Agent。平台安全策略不可在这里放宽。</p></div>
      <span className="scope-badge"><ShieldIcon />{readOnly ? "只读审计" : "TenantAdmin"}</span>
    </section>

    <section className="agent-settings-summary">
      <article><span><SparkIcon /></span><div><small>有效默认</small><strong>{effectiveProfile?.agent === "codex-cli" ? "Codex CLI" : "Claude Code"}</strong><p>{effectiveProvider?.models.primaryModel ?? "项目覆盖 → 租户覆盖 → 平台 Claude Code"}</p></div></article>
      <article><span><ShieldIcon /></span><div><small>凭据边界</small><strong>{credentials.length} 个 ACTIVE 版本</strong><p>明文只进入 Vault，CLI 仅取得短期 Gateway token</p></div></article>
      <article><span><GamepadIcon /></span><div><small>项目覆盖</small><strong>按项目选择</strong><p><Link href="/projects">从项目目录选择 →</Link></p></div></article>
    </section>

    <div className="agent-settings-grid">
      <section className="settings-card">
        <div className="settings-card-title"><div><span className="step-number">1</span><h2>写入 BYOK 凭据</h2></div><span>只写 / 不回显</span></div>
        <form className="settings-form" onSubmit={createCredential}>
          <label>凭据标签<input disabled={busy || readOnly} name="label" placeholder="例如 Anthropic 租户生产 Key" required /></label>
          <label>API Key<input autoComplete="new-password" disabled={busy || readOnly} name="apiKey" placeholder="保存后无法查看" required type="password" /></label>
          <button className="button button-primary" disabled={busy || readOnly} type="submit">安全写入 Vault</button>
        </form>
        <div className="masked-list credential-version-list">{credentialRows.length ? credentialRows.map((item) => <article key={item.id}>
          <div className="credential-version-summary"><span><b>{item.label}</b><small>{item.id} · v{item.version ?? "?"} · {item.state}</small><small>创建 {credentialTime(item.createdAt)} · 轮换 {credentialTime(item.rotatedAt)} · 最后使用 {credentialTime(item.lastUsedAt)}</small></span><code>{item.maskedFingerprint ?? item.masked ?? "已掩码"}</code></div>
          <div className="credential-version-actions">
            {item.state === "ACTIVE" ? <button disabled={busy || readOnly} onClick={() => { setRestoringCredentialId(""); setRotatingCredentialId(item.id); }} type="button">轮换</button> : null}
            {localFixture && item.state === "ACTIVE" ? <button disabled={busy || readOnly} onClick={() => { setRotatingCredentialId(""); setRestoringCredentialId(item.id); }} type="button">恢复本机绑定</button> : null}
            {item.state !== "REVOKED" ? <button disabled={busy || readOnly} onClick={() => void revokeCredential(item)} type="button">撤销</button> : null}
          </div>
          {rotatingCredentialId === item.id ? <form className="credential-rotation-form" onSubmit={(event) => void rotateCredential(event, item.id)}>
            <label>新的 API Key<input autoComplete="new-password" disabled={busy || readOnly} minLength={8} name="apiKey" placeholder="提交后立即清空" required type="password" /></label>
            <button className="button button-primary" disabled={busy || readOnly} type="submit">确认轮换</button>
            <button className="button button-secondary" disabled={busy} onClick={() => setRotatingCredentialId("")} type="button">取消</button>
          </form> : null}
          {restoringCredentialId === item.id ? <form className="credential-rotation-form" onSubmit={(event) => void restoreLocalBinding(event, item.id)}>
            <label>该版本原 API Key<input autoComplete="new-password" disabled={busy || readOnly} minLength={8} name="apiKey" placeholder="只用于恢复进程内安全绑定" required type="password" /></label>
            <button className="button button-primary" disabled={busy || readOnly} type="submit">重新探针并激活</button>
            <button className="button button-secondary" disabled={busy} onClick={() => setRestoringCredentialId("")} type="button">取消</button>
          </form> : null}
        </article>) : <p>尚无租户凭据。平台凭据不会暴露给租户页面。</p>}</div>
      </section>

      <section className="settings-card settings-card-wide">
        <div className="settings-card-title"><div><span className="step-number">2</span><h2>创建 Provider / Profile 草稿</h2></div><span>激活需 SecurityAdmin</span></div>
        <form className="settings-form provider-grid" onSubmit={createProfile}>
          <label>Agent<select disabled={busy || readOnly} name="agent" onChange={(event) => setDraftAgent(event.target.value as AgentKind)} value={draftAgent}><option value="claude-code">Claude Code（默认）</option><option value="codex-cli">Codex CLI</option></select></label>
          <label>固定 Installation<select disabled={busy || readOnly} name="installationId" required>{draftInstallations.map((item) => <option key={item.id} value={item.id}>{item.version ? `${item.version} · ` : ""}{item.id}</option>)}</select></label>
          <label>凭据版本<select disabled={busy || readOnly} name="credentialVersionId" required><option value="">选择 ACTIVE 凭据</option>{credentials.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}</select></label>
          <label>协议 / 认证<input readOnly value={draftAgent === "claude-code" ? "Anthropic Messages · x-api-key" : "OpenAI Responses · bearer"} /></label>
          <label className="provider-wide">HTTPS Base URL<input disabled={busy || readOnly} name="baseUrl" placeholder="https://gateway.example.com/v1" required type="url" /></label>
          <label>Primary Model<input disabled={busy || readOnly} name="primaryModel" placeholder="精确 ID；禁止 latest / sonnet" required /></label>
          <label>Planning Model<input disabled={busy || readOnly} name="planningModel" placeholder="留空固定到 Primary" /></label>
          <label>Small / Fast Model<input disabled={busy || readOnly} name="smallFastModel" placeholder="留空固定到 Primary" /></label>
          <label>Subagent Model<input disabled={busy || readOnly} name="subagentModel" placeholder="留空固定到 Primary" /></label>
          <label>任务预算（USD）<input defaultValue="25" disabled={busy || readOnly} max="100" min="0.01" name="budget" required step="0.01" type="number" /></label>
          <label>最大 Turns<input defaultValue="100" disabled={busy || readOnly} max="200" min="1" name="maxTurns" required step="1" type="number" /></label>
          <label>超时（秒）<input defaultValue="7200" disabled={busy || readOnly} max="14400" min="60" name="timeoutSeconds" required step="60" type="number" /></label>
          <label>同 Agent Fallback<select disabled={busy || readOnly} name="fallbackProfileRevisionId"><option value="">无；故障进入 WAITING_PROVIDER</option>{draftFallbacks.map((profile) => <option key={profile.id} value={profile.id}>{profile.id}</option>)}</select></label>
          <label>输入价 / 百万 token<input defaultValue="3" disabled={busy || readOnly} min="0" name="inputPrice" step="0.01" type="number" /></label>
          <label>输出价 / 百万 token<input defaultValue="15" disabled={busy || readOnly} min="0" name="outputPrice" step="0.01" type="number" /></label>
          <label>数据地域<input disabled={busy || readOnly} name="dataRegion" placeholder="cn-east / us-east" required /></label>
          <label>数据保留政策<input disabled={busy || readOnly} name="retentionPolicy" placeholder="例如 zero application retention" required /></label>
          <label>训练政策<input disabled={busy || readOnly} name="trainingPolicy" placeholder="例如 no training" required /></label>
          <button className="button button-primary provider-submit" disabled={busy || readOnly || !credentials.length || !draftInstallations.length} type="submit">保存不可变草稿</button>
        </form>
      </section>

      <section className="settings-card settings-card-full">
        <div className="settings-card-title"><div><span className="step-number">3</span><h2>选择租户默认 Profile</h2></div><span>仅新任务</span></div>
        <div className="profile-selection-row"><select disabled={busy || readOnly} onChange={(event) => setSelectedProfile(event.target.value)} value={selectedProfile}>{activeProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.agent === "claude-code" ? "Claude Code" : "Codex CLI"} · {profile.scope} · {profile.id}</option>)}</select><button className="button button-primary" disabled={busy || readOnly || !selectedProfile} onClick={selectDefault} type="button">设为租户默认</button></div>
        <div className="profile-table">{(data?.profiles ?? []).map((profile) => {
          const provider = (data?.providers ?? []).find((item) => item.id === profile.providerRevisionId);
          return <div key={profile.id}><span className={`profile-state state-${profile.state.toLowerCase()}`}>{profile.state}</span><b>{profile.agent}</b><code>{profile.id}</code><small>{profile.scope}:{profile.scopeId} · ${profile.budget.maxUsd} / {profile.budget.maxTurns} turns / {profile.budget.timeoutSeconds}s<br />{provider ? `primary ${provider.models.primaryModel} · planning ${provider.models.planningModel} · fast ${provider.models.smallFastModel} · subagent ${provider.models.subagentModel}` : "Provider revision 不可见"}</small>{profile.scope === "tenant" && ["DRAFT", "DEGRADED"].includes(profile.state) ? <button disabled={busy || readOnly} onClick={() => validateProfile(profile.id)} type="button">运行探针</button> : <span />}</div>;
        })}</div>
      </section>
    </div>
  </AppShell>;
}

function normalize(data: AgentData, meta?: Record<string, unknown>): AgentData {
  if (Array.isArray(data)) return { catalog: data, ...(meta ?? {}) } as AgentData;
  return data;
}

function credentialTime(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
