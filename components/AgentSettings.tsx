"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  AGENT_RUNTIME_KINDS,
  type AgentRuntimeKind,
  type TenantAgentSettings,
} from "@/lib/product/contracts";
import { LinkIcon, SettingsIcon, ShieldIcon, SparkIcon } from "./console/Icons";

const DEFAULT_SETTINGS: TenantAgentSettings = Object.freeze({
  agentRuntime: "CLAUDE_CODE",
  baseUrl: "https://api.anthropic.com",
  apiKeyConfigured: false,
  apiKeyFingerprint: null,
  revision: 0,
  updatedAt: null,
});

const RUNTIME_COPY: Readonly<Record<AgentRuntimeKind, Readonly<{ name: string; description: string }>>> = Object.freeze({
  CLAUDE_CODE: Object.freeze({ name: "Claude Code", description: "使用 Anthropic Messages 兼容网关执行 Agent。" }),
  CODEX_CLI: Object.freeze({ name: "Codex CLI", description: "使用 OpenAI Responses 兼容网关执行 Agent。" }),
});

export function AgentSettings() {
  const [settings, setSettings] = useState<TenantAgentSettings>(DEFAULT_SETTINGS);
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeKind>(DEFAULT_SETTINGS.agentRuntime);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_SETTINGS.baseUrl);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/agent", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json() as { settings?: TenantAgentSettings; message?: string };
        if (!response.ok || !body.settings) throw new Error(body.message ?? "无法读取 Agent 设置");
        return body.settings;
      })
      .then(value => {
        if (controller.signal.aborted) return;
        setSettings(value);
        setAgentRuntime(value.agentRuntime);
        setBaseUrl(value.baseUrl);
      })
      .catch(fetchError => {
        if (!controller.signal.aborted) setError(fetchError instanceof Error ? fetchError.message : "无法读取 Agent 设置");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const apiKey = String(form.get("apiKey") ?? "");
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/settings/agent", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentRuntime,
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
        }),
      });
      const body = await response.json() as { settings?: TenantAgentSettings; message?: string };
      if (!response.ok || !body.settings) throw new Error(body.message ?? "保存失败");
      setSettings(body.settings);
      setAgentRuntime(body.settings.agentRuntime);
      setBaseUrl(body.settings.baseUrl);
      formElement.reset();
      setNotice("Agent 配置已保存，仅影响之后启动的任务。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const runtime = RUNTIME_COPY[agentRuntime];
  return (
    <>
      <section className="page-heading agent-config-heading">
        <div>
          <span className="eyebrow">CONFIGURATION · 租户级配置</span>
          <h1>Agent 设置</h1>
          <p>配置 Agent 运行时与推理服务连接。修改只作用于当前租户之后创建的 Agent 任务。</p>
        </div>
        <span className="scope-badge"><ShieldIcon /> TENANT ISOLATED</span>
      </section>

      <section className="agent-settings-summary" aria-label="当前 Agent 配置">
        <article><span><SparkIcon /></span><div><small>Agent Runtime</small><strong>{runtime.name}</strong><p>{settings.revision ? `配置修订 v${settings.revision}` : "尚未保存租户配置"}</p></div></article>
        <article><span><LinkIcon /></span><div><small>Provider Endpoint</small><strong>{hostLabel(baseUrl)}</strong><p>{baseUrl}</p></div></article>
        <article><span><ShieldIcon /></span><div><small>Credential</small><strong>{settings.apiKeyConfigured ? "已安全配置" : "等待配置"}</strong><p>{settings.apiKeyFingerprint ?? "API Key 不会返回浏览器"}</p></div></article>
      </section>

      <div className="agent-config-layout">
        <section className="settings-card agent-config-form-card">
          <div className="settings-card-title"><div><span className="step-number">01</span><h2>连接配置</h2></div><span>{loading ? "SYNCING" : "READY"}</span></div>
          <form className="settings-form agent-config-form" onSubmit={save}>
            <fieldset disabled={loading || saving}>
              <legend>Agent 运行时</legend>
              <div className="agent-runtime-options">
                {AGENT_RUNTIME_KINDS.map(kind => (
                  <label className={`agent-runtime-choice ${agentRuntime === kind ? "is-selected" : ""}`} key={kind}>
                    <input checked={agentRuntime === kind} name="agentRuntime" onChange={() => setAgentRuntime(kind)} type="radio" value={kind} />
                    <span><b>{RUNTIME_COPY[kind].name}</b><small>{RUNTIME_COPY[kind].description}</small></span>
                    <i aria-hidden="true" />
                  </label>
                ))}
              </div>
            </fieldset>

            <label>Provider Base URL
              <input autoComplete="url" disabled={loading || saving} maxLength={2048} name="baseUrl" onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required type="url" value={baseUrl} />
              <small>生产环境必须使用 HTTPS；不得包含账号、查询参数或 URL fragment。</small>
            </label>

            <label>API Key
              <input autoComplete="new-password" disabled={loading || saving} maxLength={4096} minLength={8} name="apiKey" placeholder={settings.apiKeyConfigured ? "留空以保留当前 API Key" : "输入 API Key"} required={!settings.apiKeyConfigured} type="password" />
              <small>{settings.apiKeyConfigured ? `当前指纹 ${settings.apiKeyFingerprint}` : "首次保存必须填写；保存后不可查看明文。"}</small>
            </label>

            {notice ? <p className="agent-config-notice is-success" role="status">{notice}</p> : null}
            {error ? <p className="agent-config-notice is-error" role="alert">{error}</p> : null}
            <button className="button button-primary agent-config-submit" disabled={loading || saving} type="submit">{saving ? "正在保存…" : "保存配置"}</button>
          </form>
        </section>

        <aside className="settings-card agent-config-security">
          <div className="settings-card-title"><div><span className="step-number">02</span><h2>安全边界</h2></div><span>FAIL CLOSED</span></div>
          <div className="agent-config-lock"><SettingsIcon /><span><b>租户级生效</b><small>配置绑定当前 tenantId，不允许跨租户读取或引用。</small></span></div>
          <ul>
            <li><b>API Key 只写</b><span>明文只进入 Core 的 Secret 边界；数据库和页面仅保留指纹与版本引用。</span></li>
            <li><b>任务配置冻结</b><span>已运行任务不会被改写，新任务锁定当时的运行时、Base URL 和凭据版本。</span></li>
            <li><b>Agent 只在 CORE 执行</b><span>E2E Linux、Windows、macOS 节点永远不会获得 Agent 或 Provider 凭据。</span></li>
          </ul>
          {settings.updatedAt ? <p className="agent-config-updated">最后更新 {formatTime(settings.updatedAt)}</p> : null}
        </aside>
      </div>
    </>
  );
}

function hostLabel(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "等待有效地址";
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
