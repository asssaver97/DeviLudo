"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  AGENT_RUNTIME_KINDS,
  type AgentModelConfiguration,
  type AgentRuntimeAvailability,
  type AgentRuntimeKind,
  type InstanceAgentSettings,
} from "@/lib/product/contracts";
import { FileIcon, LinkIcon, SettingsIcon, ShieldIcon, SparkIcon } from "./console/Icons";

type ConfigurationMode = "SIMPLE" | "SETTINGS_JSON";
type ModelMode = "SINGLE" | "EXPANDED";

const DEFAULT_SETTINGS: InstanceAgentSettings = Object.freeze({
  agentRuntime: "CLAUDE_CODE",
  baseUrl: "https://api.anthropic.com",
  models: null,
  apiKeyConfigured: false,
  apiKeyMasked: null,
  apiKeyFingerprint: null,
  revision: 0,
  updatedAt: null,
});

const RUNTIME_COPY: Readonly<Record<AgentRuntimeKind, Readonly<{ name: string; description: string }>>> = Object.freeze({
  CLAUDE_CODE: Object.freeze({ name: "Claude Code", description: "使用 Anthropic Messages 兼容网关执行 Agent。" }),
  CODEX_CLI: Object.freeze({ name: "Codex CLI", description: "使用 OpenAI Responses 兼容网关执行 Agent。" }),
});

const EMPTY_MODELS: AgentModelConfiguration = Object.freeze({
  primary: "",
  opus: "",
  sonnet: "",
  haiku: "",
  subagent: "",
});

export function AgentSettings() {
  const [settings, setSettings] = useState<InstanceAgentSettings>(DEFAULT_SETTINGS);
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeKind>(DEFAULT_SETTINGS.agentRuntime);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_SETTINGS.baseUrl);
  const [modelMode, setModelMode] = useState<ModelMode>("SINGLE");
  const [singleModel, setSingleModel] = useState("");
  const [expandedModels, setExpandedModels] = useState<AgentModelConfiguration>(EMPTY_MODELS);
  const [apiKey, setApiKey] = useState("");
  const [configurationMode, setConfigurationMode] = useState<ConfigurationMode>("SIMPLE");
  const [settingsJson, setSettingsJson] = useState(() => formatClaudeSettingsJson(DEFAULT_SETTINGS.baseUrl, "", null));
  const [runtimes, setRuntimes] = useState<readonly AgentRuntimeAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/agent", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json() as {
          settings?: InstanceAgentSettings;
          runtimes?: readonly AgentRuntimeAvailability[];
          message?: string;
        };
        if (!response.ok || !body.settings) throw new Error(body.message ?? "无法读取 Agent 设置");
        return body;
      })
      .then(body => {
        if (controller.signal.aborted) return;
        const value = body.settings!;
        setSettings(value);
        setAgentRuntime(value.agentRuntime);
        setBaseUrl(value.baseUrl);
        const loadedModels = value.models ?? EMPTY_MODELS;
        setExpandedModels(loadedModels);
        setSingleModel(loadedModels.primary);
        setModelMode(hasDistinctModels(loadedModels) ? "EXPANDED" : "SINGLE");
        setSettingsJson(formatClaudeSettingsJson(value.baseUrl, value.apiKeyMasked ?? "", value.models));
        setRuntimes(body.runtimes ?? []);
      })
      .catch(fetchError => {
        if (!controller.signal.aborted) setError(fetchError instanceof Error ? fetchError.message : "无法读取 Agent 设置");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/settings/agent", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(configurationMode === "SETTINGS_JSON"
          ? { agentRuntime, settingsJson }
          : {
              agentRuntime,
              baseUrl,
              ...(agentRuntime === "CLAUDE_CODE" ? { models: effectiveModels(modelMode, singleModel, expandedModels) } : {}),
              ...(apiKey ? { apiKey } : {}),
            }),
      });
      const body = await response.json() as { settings?: InstanceAgentSettings; message?: string };
      if (!response.ok || !body.settings) throw new Error(body.message ?? "保存失败");
      setSettings(body.settings);
      setAgentRuntime(body.settings.agentRuntime);
      setBaseUrl(body.settings.baseUrl);
      const savedModels = body.settings.models ?? EMPTY_MODELS;
      setExpandedModels(savedModels);
      setSingleModel(savedModels.primary);
      setModelMode(hasDistinctModels(savedModels) ? "EXPANDED" : "SINGLE");
      setApiKey("");
      setSettingsJson(formatClaudeSettingsJson(
        body.settings.baseUrl,
        body.settings.apiKeyMasked ?? "",
        body.settings.models,
      ));
      setNotice("Agent 配置已保存，仅影响之后启动的任务。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function selectRuntime(kind: AgentRuntimeKind) {
    setAgentRuntime(kind);
    if (kind !== "CLAUDE_CODE") setConfigurationMode("SIMPLE");
  }

  function switchConfigurationMode(mode: ConfigurationMode) {
    setError("");
    if (mode === "SETTINGS_JSON") {
      setSettingsJson(formatClaudeSettingsJson(
        baseUrl,
        apiKey || settings.apiKeyMasked || "",
        effectiveModels(modelMode, singleModel, expandedModels),
      ));
      setConfigurationMode(mode);
      return;
    }
    try {
      const connection = connectionFromClaudeSettingsJson(settingsJson);
      setBaseUrl(connection.baseUrl);
      setApiKey(connection.apiKey);
      setExpandedModels(connection.models);
      setSingleModel(connection.models.primary);
      setModelMode(hasDistinctModels(connection.models) ? "EXPANDED" : "SINGLE");
      setConfigurationMode(mode);
    } catch (modeError) {
      setError(modeError instanceof Error ? modeError.message : "settings.json 格式无效");
    }
  }

  function switchModelMode(mode: ModelMode) {
    if (mode === modelMode) return;
    if (mode === "EXPANDED") {
      setExpandedModels(modelsFromSingle(singleModel));
    } else {
      setSingleModel(expandedModels.primary);
    }
    setModelMode(mode);
  }

  function updateExpandedModel(key: keyof AgentModelConfiguration, value: string) {
    setExpandedModels(current => Object.freeze({ ...current, [key]: value }));
  }

  const runtime = RUNTIME_COPY[agentRuntime];
  const runtimeAvailability = runtimes.find(candidate => candidate.kind === agentRuntime);
  return (
    <>
      <section className="page-heading agent-config-heading">
        <div>
          <span className="eyebrow">CONFIGURATION · 全局配置</span>
          <h1>Agent 设置</h1>
          <p>配置当前 Deviludo 实例使用的 Agent 运行时与推理服务连接。</p>
        </div>
        <span className="scope-badge"><ShieldIcon /> INSTANCE GLOBAL</span>
      </section>

      <section className="agent-settings-summary" aria-label="当前 Agent 配置">
        <article><span><SparkIcon /></span><div><small>Agent Runtime</small><strong>{runtime.name}</strong><p>{runtimeAvailability?.installed ? `已检测 · v${runtimeAvailability.version}` : loading ? "正在检测本地运行时" : "未检测到安装"}</p></div></article>
        <article><span><LinkIcon /></span><div><small>Provider Endpoint</small><strong>{hostLabel(baseUrl)}</strong><p>{modelSummary(modelMode, singleModel, expandedModels) || baseUrl}</p></div></article>
        <article><span><ShieldIcon /></span><div><small>Credential</small><strong>{settings.apiKeyConfigured ? "已安全配置" : "等待配置"}</strong><p>{settings.apiKeyMasked ?? "API Key 尚未配置"}</p></div></article>
      </section>

      <div className="agent-config-layout">
        <section className="settings-card agent-config-form-card">
          <div className="settings-card-title agent-config-card-title">
            <div><span className="step-number">01</span><h2>连接配置</h2></div>
            <div className="agent-config-title-actions">
              <span>{loading ? "SYNCING" : "READY"}</span>
              {agentRuntime === "CLAUDE_CODE" ? (
                <div aria-label="连接配置填写方式" className="config-mode-switch" role="group">
                  <button aria-label="使用简易表单" className={configurationMode === "SIMPLE" ? "is-active" : ""} onClick={() => switchConfigurationMode("SIMPLE")} title="简易表单" type="button"><SettingsIcon /></button>
                  <button aria-label="编辑 settings.json" className={configurationMode === "SETTINGS_JSON" ? "is-active" : ""} onClick={() => switchConfigurationMode("SETTINGS_JSON")} title="settings.json" type="button"><FileIcon /></button>
                </div>
              ) : null}
            </div>
          </div>
          <form className="settings-form agent-config-form" onSubmit={save}>
            <fieldset disabled={loading || saving}>
              <legend>Agent 运行时</legend>
              <div className="agent-runtime-options">
                {AGENT_RUNTIME_KINDS.map(kind => (
                  <label className={`agent-runtime-choice ${agentRuntime === kind ? "is-selected" : ""}`} key={kind}>
                    <input checked={agentRuntime === kind} name="agentRuntime" onChange={() => selectRuntime(kind)} type="radio" value={kind} />
                    <span><span className="agent-runtime-name"><b>{RUNTIME_COPY[kind].name}</b><em className={runtimeClass(runtimes, kind, loading)}>{runtimeLabel(runtimes, kind, loading)}</em></span><small>{RUNTIME_COPY[kind].description}</small></span>
                    <i aria-hidden="true" />
                  </label>
                ))}
              </div>
            </fieldset>

            {configurationMode === "SIMPLE" ? (
              <>
                <label>Provider Base URL
                  <input autoComplete="url" disabled={loading || saving} maxLength={2048} name="baseUrl" onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required type="url" value={baseUrl} />
                </label>

                <label>API Key
                  <input
                    aria-autocomplete="none"
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    className="agent-api-key-input"
                    data-1p-ignore="true"
                    data-bwignore="true"
                    data-form-type="other"
                    data-lpignore="true"
                    disabled={loading || saving}
                    maxLength={4096}
                    minLength={8}
                    name="providerCredential"
                    onChange={event => setApiKey(event.target.value)}
                    placeholder={settings.apiKeyMasked ?? "输入 API Key"}
                    required={!settings.apiKeyConfigured}
                    spellCheck={false}
                    type="text"
                    value={apiKey}
                  />
                </label>

                {agentRuntime === "CLAUDE_CODE" ? (
                  <fieldset className="agent-model-fieldset">
                    <legend>Model</legend>
                    <div className="agent-model-heading">
                      <span>Model</span>
                    </div>
                    {modelMode === "SINGLE" ? (
                      <label className="agent-model-single"><span>统一模型</span>
                        <div className="agent-model-input-row">
                          <input aria-label="统一模型" autoCapitalize="none" autoComplete="off" disabled={loading || saving} maxLength={200} onChange={event => setSingleModel(event.target.value)} placeholder="claude-fable-5-max" required type="text" value={singleModel} />
                          <ModelModeButton direction="left" disabled={loading || saving} expanded={false} onClick={() => switchModelMode("EXPANDED")} />
                        </div>
                      </label>
                    ) : (
                      <div className="agent-model-expanded">
                        <ModelInput
                          action={<ModelModeButton direction="down" disabled={loading || saving} expanded onClick={() => switchModelMode("SINGLE")} />}
                          disabled={loading || saving}
                          label="主模型"
                          onChange={value => updateExpandedModel("primary", value)}
                          value={expandedModels.primary}
                        />
                        <ModelInput disabled={loading || saving} label="Opus" onChange={value => updateExpandedModel("opus", value)} value={expandedModels.opus} />
                        <ModelInput disabled={loading || saving} label="Sonnet" onChange={value => updateExpandedModel("sonnet", value)} value={expandedModels.sonnet} />
                        <ModelInput disabled={loading || saving} label="Haiku" onChange={value => updateExpandedModel("haiku", value)} value={expandedModels.haiku} />
                        <ModelInput disabled={loading || saving} label="Subagent" onChange={value => updateExpandedModel("subagent", value)} value={expandedModels.subagent} />
                      </div>
                    )}
                  </fieldset>
                ) : null}
              </>
            ) : (
              <label className="settings-json-editor">Claude Code settings.json
                <textarea autoCapitalize="none" autoComplete="off" disabled={loading || saving} onChange={event => setSettingsJson(event.target.value)} spellCheck={false} value={settingsJson} />
              </label>
            )}

            {notice ? <p className="agent-config-notice is-success" role="status">{notice}</p> : null}
            {error ? <p className="agent-config-notice is-error" role="alert">{error}</p> : null}
            <button className="button button-primary agent-config-submit" disabled={loading || saving} type="submit">{saving ? "正在保存…" : "保存配置"}</button>
          </form>
        </section>

        <aside className="settings-card agent-config-security">
          <div className="settings-card-title"><div><span className="step-number">02</span><h2>安全边界</h2></div><span>FAIL CLOSED</span></div>
          <div className="agent-config-lock"><SettingsIcon /><span><b>实例全局生效</b><small>所有工作区共享同一套 Agent 连接配置。</small></span></div>
          <ul>
            <li><b>API Key 隔离</b><span>明文只进入 Core 的 Secret 边界；数据库和页面仅保留掩码、指纹与版本引用。</span></li>
            <li><b>任务配置冻结</b><span>已运行任务不会被改写，新任务锁定当时的运行时、Base URL 和凭据版本。</span></li>
            <li><b>Agent 只在 CORE 执行</b><span>E2E Linux、Windows、macOS 节点永远不会获得 Agent 或 Provider 凭据。</span></li>
          </ul>
          {settings.updatedAt ? <p className="agent-config-updated">最后更新 {formatTime(settings.updatedAt)}</p> : null}
        </aside>
      </div>
    </>
  );
}

function ModelInput({
  action,
  disabled,
  label,
  onChange,
  value,
}: Readonly<{
  action?: ReactNode;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}>) {
  return (
    <label><span>{label}</span>
      <div className={action ? "agent-model-input-row" : undefined}>
        <input autoCapitalize="none" autoComplete="off" disabled={disabled} maxLength={200} onChange={event => onChange(event.target.value)} placeholder="claude-fable-5-max" required type="text" value={value} />
        {action}
      </div>
    </label>
  );
}

function ModelModeButton({
  direction,
  disabled,
  expanded,
  onClick,
}: Readonly<{
  direction: "down" | "left";
  disabled: boolean;
  expanded: boolean;
  onClick: () => void;
}>) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={expanded ? "收起模型配置" : "展开模型配置"}
      className={`agent-model-mode-button is-${direction}`}
      disabled={disabled}
      onClick={onClick}
      title={expanded ? "收起模型配置" : "展开模型配置"}
      type="button"
    >
      <span aria-hidden="true">&lt;</span>
    </button>
  );
}

function runtimeLabel(
  runtimes: readonly AgentRuntimeAvailability[],
  kind: AgentRuntimeKind,
  loading: boolean,
): string {
  if (loading) return "检测中";
  const runtime = runtimes.find(candidate => candidate.kind === kind);
  return runtime?.installed ? `v${runtime.version}` : "未安装";
}

function runtimeClass(
  runtimes: readonly AgentRuntimeAvailability[],
  kind: AgentRuntimeKind,
  loading: boolean,
): string {
  const installed = runtimes.find(candidate => candidate.kind === kind)?.installed;
  return `agent-runtime-status ${loading ? "is-checking" : installed ? "is-installed" : "is-missing"}`;
}

function formatClaudeSettingsJson(
  baseUrl: string,
  apiKey: string,
  models: AgentModelConfiguration | null,
): string {
  const values = models ?? EMPTY_MODELS;
  return JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: values.primary,
      ANTHROPIC_DEFAULT_OPUS_MODEL: values.opus,
      ANTHROPIC_DEFAULT_SONNET_MODEL: values.sonnet,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: values.haiku,
      CLAUDE_CODE_SUBAGENT_MODEL: values.subagent,
    },
  }, null, 2);
}

function connectionFromClaudeSettingsJson(value: string): Readonly<{
  baseUrl: string;
  apiKey: string;
  models: AgentModelConfiguration;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("settings.json 不是有效 JSON，修复后才能切回简易表单。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings.json 必须包含 JSON 对象。");
  }
  const env = (parsed as Record<string, unknown>).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("settings.json 缺少 env 对象。");
  }
  const values = env as Record<string, unknown>;
  if (typeof values.ANTHROPIC_BASE_URL !== "string") {
    throw new Error("settings.json 缺少 ANTHROPIC_BASE_URL。");
  }
  const credential = values.ANTHROPIC_API_KEY || values.ANTHROPIC_AUTH_TOKEN || "";
  if (typeof credential !== "string") throw new Error("settings.json 中的凭据必须是字符串。");
  const models = {
    primary: values.ANTHROPIC_MODEL,
    opus: values.ANTHROPIC_DEFAULT_OPUS_MODEL,
    sonnet: values.ANTHROPIC_DEFAULT_SONNET_MODEL,
    haiku: values.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    subagent: values.CLAUDE_CODE_SUBAGENT_MODEL,
  };
  if (Object.values(models).some(model => typeof model !== "string")) {
    throw new Error("settings.json 中的模型变量必须是字符串。");
  }
  const configuredModelCount = Object.values(models).filter(Boolean).length;
  if (configuredModelCount !== 0 && configuredModelCount !== 5) {
    throw new Error("settings.json 必须同时填写全部 5 个模型变量。");
  }
  return Object.freeze({
    baseUrl: values.ANTHROPIC_BASE_URL,
    apiKey: credential,
    models: Object.freeze(models as AgentModelConfiguration),
  });
}

function modelsFromSingle(value: string): AgentModelConfiguration {
  return Object.freeze({ primary: value, opus: value, sonnet: value, haiku: value, subagent: value });
}

function effectiveModels(
  mode: ModelMode,
  single: string,
  expanded: AgentModelConfiguration,
): AgentModelConfiguration {
  return mode === "SINGLE" ? modelsFromSingle(single) : expanded;
}

function hasDistinctModels(models: AgentModelConfiguration): boolean {
  return new Set(Object.values(models)).size > 1;
}

function modelSummary(
  mode: ModelMode,
  single: string,
  expanded: AgentModelConfiguration,
): string {
  if (mode === "SINGLE") return single ? `MODEL · ${single}` : "";
  return Object.values(expanded).every(Boolean) ? "MODELS · 5 ROUTES" : "";
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
