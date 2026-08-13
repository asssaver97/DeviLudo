"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { cachedValue, clientCacheKeys, loadCached, storeCached } from "@/lib/product/client-cache";
import {
  AGENT_RUNTIME_KINDS,
  type AgentModelConfiguration,
  type AgentRoleModelConfiguration,
  type AgentRuntimeAvailability,
  type AgentRuntimeKind,
  type InstanceAgentSettings,
} from "@/lib/product/contracts";
import { FileIcon, LinkIcon, SettingsIcon, ShieldIcon, SparkIcon } from "./console/Icons";
import { localeTag, useLanguage } from "./i18n/LanguageProvider";

type ConfigurationMode = "SIMPLE" | "SETTINGS_JSON";
type ModelMode = "SINGLE" | "EXPANDED";
type AgentSettingsPayload = Readonly<{ settings: InstanceAgentSettings; runtimes: readonly AgentRuntimeAvailability[] }>;

const DEFAULT_SETTINGS: InstanceAgentSettings = Object.freeze({
  agentRuntime: "CLAUDE_CODE",
  baseUrl: "https://api.anthropic.com",
  models: null,
  roleModels: Object.freeze({
    design: "codex-mini-latest",
    development: "codex-mini-latest",
    test: "codex-mini-latest",
  }),
  apiKeyConfigured: false,
  testPolicyReady: false,
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
  const { locale, text } = useLanguage();
  const initialPayload = cachedValue<AgentSettingsPayload>(clientCacheKeys.agentSettings);
  const initialSettings = initialPayload?.settings ?? DEFAULT_SETTINGS;
  const initialModels = initialSettings.models ?? EMPTY_MODELS;
  const initialRoleModels = initialSettings.roleModels ?? roleModelsFromRoutes(initialSettings.agentRuntime, initialModels);
  const [settings, setSettings] = useState<InstanceAgentSettings>(initialSettings);
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeKind>(initialSettings.agentRuntime);
  const [baseUrl, setBaseUrl] = useState(initialSettings.baseUrl);
  const [modelMode, setModelMode] = useState<ModelMode>(hasDistinctModels(initialModels) ? "EXPANDED" : "SINGLE");
  const [singleModel, setSingleModel] = useState(initialModels.primary);
  const [expandedModels, setExpandedModels] = useState<AgentModelConfiguration>(initialModels);
  const [roleModels, setRoleModels] = useState<AgentRoleModelConfiguration>(initialRoleModels);
  const [apiKey, setApiKey] = useState("");
  const [configurationMode, setConfigurationMode] = useState<ConfigurationMode>("SIMPLE");
  const [settingsJson, setSettingsJson] = useState(() => formatClaudeSettingsJson(initialSettings.baseUrl, initialSettings.apiKeyMasked ?? "", initialSettings.models));
  const [runtimes, setRuntimes] = useState<readonly AgentRuntimeAvailability[]>(initialPayload?.runtimes ?? []);
  const [loading, setLoading] = useState(!initialPayload);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void loadCached<AgentSettingsPayload>(clientCacheKeys.agentSettings, 60_000, async () => {
        const response = await fetch("/api/settings/agent", { cache: "no-store" });
        const body = await response.json() as {
          settings?: InstanceAgentSettings;
          runtimes?: readonly AgentRuntimeAvailability[];
          message?: string;
        };
        if (!response.ok || !body.settings) throw new Error(body.message ?? text("无法读取 Agent 设置", "Unable to load Agent settings"));
        return Object.freeze({ settings: body.settings, runtimes: body.runtimes ?? [] });
      })
      .then(body => {
        if (!active) return;
        const value = body.settings;
        setSettings(value);
        setAgentRuntime(value.agentRuntime);
        setBaseUrl(value.baseUrl);
        const loadedModels = value.models ?? EMPTY_MODELS;
        setExpandedModels(loadedModels);
        setSingleModel(loadedModels.primary);
        setModelMode(hasDistinctModels(loadedModels) ? "EXPANDED" : "SINGLE");
        setRoleModels(value.roleModels ?? roleModelsFromRoutes(value.agentRuntime, loadedModels));
        setSettingsJson(formatClaudeSettingsJson(value.baseUrl, value.apiKeyMasked ?? "", value.models));
        setRuntimes(body.runtimes);
      })
      .catch(fetchError => {
        if (active) setError(fetchError instanceof Error ? fetchError.message : text("无法读取 Agent 设置", "Unable to load Agent settings"));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [text]);

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
          ? { agentRuntime, settingsJson, roleModels }
          : {
              agentRuntime,
              baseUrl,
              roleModels,
              ...(agentRuntime === "CLAUDE_CODE" ? { models: effectiveModels(modelMode, singleModel, expandedModels) } : {}),
              ...(apiKey ? { apiKey } : {}),
            }),
      });
      const body = await response.json() as { settings?: InstanceAgentSettings; message?: string };
      if (!response.ok || !body.settings) throw new Error(body.message ?? text("保存失败", "Save failed"));
      storeCached(clientCacheKeys.agentSettings, Object.freeze({ settings: body.settings, runtimes }), 60_000);
      setSettings(body.settings);
      setAgentRuntime(body.settings.agentRuntime);
      setBaseUrl(body.settings.baseUrl);
      const savedModels = body.settings.models ?? EMPTY_MODELS;
      setExpandedModels(savedModels);
      setSingleModel(savedModels.primary);
      setModelMode(hasDistinctModels(savedModels) ? "EXPANDED" : "SINGLE");
      setRoleModels(body.settings.roleModels);
      setApiKey("");
      setSettingsJson(formatClaudeSettingsJson(
        body.settings.baseUrl,
        body.settings.apiKeyMasked ?? "",
        body.settings.models,
      ));
      setNotice(text("Agent 配置已保存，仅影响之后启动的任务。", "Agent settings saved. They apply to newly started jobs only."));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : text("保存失败", "Save failed"));
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
      setError(modeError instanceof Error ? modeError.message : text("settings.json 格式无效", "Invalid settings.json"));
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

  function updateRoleModel(key: keyof AgentRoleModelConfiguration, value: string) {
    setRoleModels(current => Object.freeze({ ...current, [key]: value }));
  }

  const runtime = RUNTIME_COPY[agentRuntime];
  const runtimeAvailability = runtimes.find(candidate => candidate.kind === agentRuntime);
  return (
    <>
      <section className="page-heading agent-config-heading">
        <div>
          <span className="eyebrow">{text("CONFIGURATION · 全局配置", "CONFIGURATION · INSTANCE GLOBAL")}</span>
          <h1>{text("Agent 设置", "AGENT SETTINGS")}</h1>
          <p>{text("配置当前 Deviludo 实例使用的 Agent 运行时与推理服务连接。", "Configure the Agent runtime and inference provider used by this Deviludo instance.")}</p>
        </div>
        <span className="scope-badge"><ShieldIcon /> INSTANCE GLOBAL</span>
      </section>

      <section className="agent-settings-summary" aria-label={text("当前 Agent 配置", "Current Agent configuration")}>
        <article><span><SparkIcon /></span><div><small>Agent Runtime</small><strong>{runtime.name}</strong><p>{runtimeAvailability?.installed ? text(`已检测 · v${runtimeAvailability.version}`, `Detected · v${runtimeAvailability.version}`) : loading ? text("正在检测本地运行时", "Detecting local runtime") : text("未检测到安装", "Not installed")}</p></div></article>
        <article><span><LinkIcon /></span><div><small>Provider Endpoint</small><strong>{hostLabel(baseUrl)}</strong><p>{modelSummary(modelMode, singleModel, expandedModels) || baseUrl}</p></div></article>
        <article><span><ShieldIcon /></span><div><small>Credential</small><strong>{settings.apiKeyConfigured ? text("已安全配置", "SECURELY CONFIGURED") : text("等待配置", "NOT CONFIGURED")}</strong><p>{settings.apiKeyMasked ?? text("API Key 尚未配置", "API Key not configured")}</p></div></article>
      </section>

      <div className="agent-config-layout">
        <section className="settings-card agent-config-form-card">
          <div className="settings-card-title agent-config-card-title">
            <div><span className="step-number">01</span><h2>{text("连接配置", "CONNECTION")}</h2></div>
            <div className="agent-config-title-actions">
              <span>{loading ? "SYNCING" : "READY"}</span>
              {agentRuntime === "CLAUDE_CODE" ? (
                <div aria-label={text("连接配置填写方式", "Connection configuration mode")} className="config-mode-switch" role="group">
                  <button aria-label={text("使用简易表单", "Use simple form")} className={configurationMode === "SIMPLE" ? "is-active" : ""} onClick={() => switchConfigurationMode("SIMPLE")} title={text("简易表单", "Simple form")} type="button"><SettingsIcon /></button>
                  <button aria-label={text("编辑 settings.json", "Edit settings.json")} className={configurationMode === "SETTINGS_JSON" ? "is-active" : ""} onClick={() => switchConfigurationMode("SETTINGS_JSON")} title="settings.json" type="button"><FileIcon /></button>
                </div>
              ) : null}
            </div>
          </div>
          <form className="settings-form agent-config-form" onSubmit={save}>
            <fieldset disabled={loading || saving}>
              <legend>{text("Agent 运行时", "Agent runtime")}</legend>
              <div className="agent-runtime-options">
                {AGENT_RUNTIME_KINDS.map(kind => (
                  <label className={`agent-runtime-choice ${agentRuntime === kind ? "is-selected" : ""}`} key={kind}>
                    <input checked={agentRuntime === kind} name="agentRuntime" onChange={() => selectRuntime(kind)} type="radio" value={kind} />
                    <span><span className="agent-runtime-name"><b>{RUNTIME_COPY[kind].name}</b><em className={runtimeClass(runtimes, kind, loading)}>{runtimeLabel(runtimes, kind, loading, text)}</em></span><small>{runtimeDescription(kind, text)}</small></span>
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
                    placeholder={settings.apiKeyMasked ?? text("输入 API Key", "Enter API Key")}
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
                      <label className="agent-model-single"><span>{text("统一模型", "Unified model")}</span>
                        <div className="agent-model-input-row">
                          <input aria-label={text("统一模型", "Unified model")} autoCapitalize="none" autoComplete="off" disabled={loading || saving} maxLength={200} onChange={event => setSingleModel(event.target.value)} placeholder="claude-fable-5-max" required type="text" value={singleModel} />
                          <ModelModeButton direction="left" disabled={loading || saving} expanded={false} onClick={() => switchModelMode("EXPANDED")} />
                        </div>
                      </label>
                    ) : (
                      <div className="agent-model-expanded">
                        <ModelInput
                          action={<ModelModeButton direction="down" disabled={loading || saving} expanded onClick={() => switchModelMode("SINGLE")} />}
                          disabled={loading || saving}
                          label={text("主模型", "Primary")}
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

            <fieldset className="agent-model-fieldset agent-role-model-fieldset">
              <legend>{text("群聊 Agent", "GROUP CHAT AGENTS")}</legend>
              <p className="agent-role-model-description">{text(
                "三个角色会依次参与每轮项目群聊，并使用各自的模型。开发角色的模型同时用于后续代码生成任务。",
                "All three roles participate in every project turn with their own model. The Development model also drives subsequent code-generation jobs.",
              )}</p>
              <div className="agent-model-expanded">
                <ModelInput disabled={loading || saving} label={text("设计 Agent", "Design Agent")} onChange={value => updateRoleModel("design", value)} value={roleModels.design} />
                <ModelInput disabled={loading || saving} label={text("开发 Agent", "Development Agent")} onChange={value => updateRoleModel("development", value)} value={roleModels.development} />
                <ModelInput disabled={loading || saving} label={text("测试 Agent", "Test Agent")} onChange={value => updateRoleModel("test", value)} value={roleModels.test} />
                <p className={`agent-config-notice ${settings.testPolicyReady ? "is-success" : ""}`} role="status">{settings.testPolicyReady
                  ? text("测试 Agent 玩家策略已通过真实视觉决策校验", "Test Agent player policy is ready for visual decisions")
                  : text("测试 Agent 玩家策略将在下一次 E2E 首次视觉决策时完成校验", "Test Agent player policy will be verified by the next E2E visual decision")}</p>
              </div>
            </fieldset>

            {notice ? <p className="agent-config-notice is-success" role="status">{notice}</p> : null}
            {error ? <p className="agent-config-notice is-error" role="alert">{error}</p> : null}
            <button className="button button-primary agent-config-submit" disabled={loading || saving} type="submit">{saving ? text("正在保存…", "SAVING…") : text("保存配置", "SAVE SETTINGS")}</button>
          </form>
        </section>

        <aside className="settings-card agent-config-security">
          <div className="settings-card-title"><div><span className="step-number">02</span><h2>{text("安全边界", "SECURITY BOUNDARY")}</h2></div><span>FAIL CLOSED</span></div>
          <div className="agent-config-lock"><SettingsIcon /><span><b>{text("实例全局生效", "INSTANCE GLOBAL")}</b><small>{text("所有工作区共享同一套 Agent 连接配置。", "All workspaces share this Agent connection configuration.")}</small></span></div>
          <ul>
            <li><b>{text("API Key 隔离", "API KEY ISOLATION")}</b><span>{text("明文只进入 Core 的 Secret 边界；数据库和页面仅保留掩码、指纹与版本引用。", "Plaintext enters only the Core secret boundary; the database and UI retain only a mask and version reference.")}</span></li>
            <li><b>{text("任务配置冻结", "IMMUTABLE JOB SETTINGS")}</b><span>{text("已运行任务不会被改写，新任务锁定当时的运行时、Base URL 和凭据版本。", "Running jobs are never rewritten; new jobs lock the current runtime, Base URL, and credential version.")}</span></li>
            <li><b>{text("Agent 只在 CORE 执行", "AGENT RUNS IN CORE ONLY")}</b><span>{text("E2E Linux、Windows、macOS 节点永远不会获得 Agent 或 Provider 凭据。", "E2E Linux, Windows, and macOS nodes never receive Agent or provider credentials.")}</span></li>
          </ul>
          {settings.updatedAt ? <p className="agent-config-updated">{text("最后更新", "Last updated")} {formatTime(settings.updatedAt, localeTag(locale))}</p> : null}
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
  const { text } = useLanguage();
  return (
    <button
      aria-expanded={expanded}
      aria-label={expanded ? text("收起模型配置", "Collapse model settings") : text("展开模型配置", "Expand model settings")}
      className={`agent-model-mode-button is-${direction}`}
      disabled={disabled}
      onClick={onClick}
      title={expanded ? text("收起模型配置", "Collapse model settings") : text("展开模型配置", "Expand model settings")}
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
  text: (chinese: string, english: string) => string,
): string {
  if (loading) return text("检测中", "CHECKING");
  const runtime = runtimes.find(candidate => candidate.kind === kind);
  return runtime?.installed ? `v${runtime.version}` : text("未安装", "NOT INSTALLED");
}

function runtimeDescription(kind: AgentRuntimeKind, text: (chinese: string, english: string) => string): string {
  return kind === "CLAUDE_CODE"
    ? text("使用 Anthropic Messages 兼容网关执行 Agent。", "Runs Agents through an Anthropic Messages-compatible gateway.")
    : text("使用 OpenAI Responses 兼容网关执行 Agent。", "Runs Agents through an OpenAI Responses-compatible gateway.");
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

function roleModelsFromRoutes(
  runtime: AgentRuntimeKind,
  models: AgentModelConfiguration,
): AgentRoleModelConfiguration {
  if (runtime === "CLAUDE_CODE") return Object.freeze({
    design: models.sonnet || models.primary,
    development: models.primary,
    test: models.haiku || models.primary,
  });
  return Object.freeze({
    design: "codex-mini-latest",
    development: "codex-mini-latest",
    test: "codex-mini-latest",
  });
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

function formatTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
