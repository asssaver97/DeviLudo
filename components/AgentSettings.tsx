"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { cachedValue, clientCacheKeys, loadCached, storeCached } from "@/lib/product/client-cache";
import {
  AGENT_RUNTIME_KINDS,
  CODEX_ACCOUNT_DEFAULT_MODEL,
  type AgentModelConfiguration,
  type AgentRoleModelConfiguration,
  type AgentRuntimeAvailability,
  type AgentRuntimeKind,
  type InstanceAgentSettings,
} from "@/lib/product/contracts";
import { FileIcon, SettingsIcon, ShieldIcon } from "./console/Icons";
import { useLanguage } from "./i18n/LanguageProvider";

type ConfigurationMode = "SIMPLE" | "SETTINGS_JSON";
type ModelMode = "SINGLE" | "EXPANDED";
type AgentSettingsPayload = Readonly<{
  settings: InstanceAgentSettings;
  runtimes: readonly AgentRuntimeAvailability[];
}>;

const DEFAULT_SETTINGS: InstanceAgentSettings = Object.freeze({
  agentRuntime: "CLAUDE_CODE",
  baseUrl: "https://api.anthropic.com",
  model: null,
  models: null,
  roleModels: Object.freeze({
    design: "claude-sonnet-4-5",
    development: "claude-opus-4-1",
    test: "claude-haiku-4-5",
  }),
  imageModel: null,
  imageGenerationReady: false,
  apiKeyConfigured: false,
  testPolicyReady: false,
  apiKeyMasked: null,
  apiKeyFingerprint: null,
  revision: 0,
  updatedAt: null,
});

const RUNTIME_COPY: Readonly<Record<AgentRuntimeKind, Readonly<{ name: string }>>> = Object.freeze({
  CLAUDE_CODE: Object.freeze({ name: "Claude Code" }),
  CODEX_CLI: Object.freeze({ name: "Codex CLI" }),
});

const EMPTY_MODELS: AgentModelConfiguration = Object.freeze({
  primary: "",
  opus: "",
  sonnet: "",
  haiku: "",
  subagent: "",
});

export function AgentSettings() {
  const { errorText, text } = useLanguage();
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
  const [imageModel, setImageModel] = useState(initialSettings.imageModel ?? "");
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
        if (!response.ok || !body.settings) throw new Error(errorText(body.message, "无法读取 Agent 设置", "Unable to load Agent settings"));
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
        setImageModel(value.imageModel ?? "");
        setSettingsJson(formatClaudeSettingsJson(value.baseUrl, value.apiKeyMasked ?? "", value.models));
        setRuntimes(body.runtimes);
      })
      .catch(fetchError => {
        if (active) setError(fetchError instanceof Error ? fetchError.message : text("无法读取 Agent 设置", "Unable to load Agent settings"));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [errorText, text]);

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
          ? { agentRuntime, settingsJson, roleModels, imageModel: imageModel.trim() || null }
          : {
              agentRuntime,
              ...(agentRuntime === "CLAUDE_CODE" ? {
                roleModels,
                imageModel: imageModel.trim() || null,
                baseUrl,
                models: effectiveModels(modelMode, singleModel, expandedModels),
                ...(apiKey ? { apiKey } : {}),
              } : {}),
            }),
      });
      const body = await response.json() as { settings?: InstanceAgentSettings; message?: string };
      if (!response.ok || !body.settings) throw new Error(errorText(body.message, "保存失败", "Save failed"));
      storeCached(clientCacheKeys.agentSettings, Object.freeze({ settings: body.settings, runtimes }), 60_000);
      setSettings(body.settings);
      setAgentRuntime(body.settings.agentRuntime);
      setBaseUrl(body.settings.baseUrl);
      const savedModels = body.settings.models ?? EMPTY_MODELS;
      setExpandedModels(savedModels);
      setSingleModel(savedModels.primary);
      setModelMode(hasDistinctModels(savedModels) ? "EXPANDED" : "SINGLE");
      setRoleModels(body.settings.roleModels);
      setImageModel(body.settings.imageModel ?? "");
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
    if (kind === "CODEX_CLI") {
      setConfigurationMode("SIMPLE");
      setRoleModels(roleModelsFromRoutes(kind, EMPTY_MODELS));
      setImageModel("");
      setApiKey("");
      return;
    }
    const next = settings.agentRuntime === "CLAUDE_CODE" ? settings : DEFAULT_SETTINGS;
    setBaseUrl(next.baseUrl);
    const nextModels = next.models ?? EMPTY_MODELS;
    setExpandedModels(nextModels);
    setSingleModel(nextModels.primary);
    setModelMode(hasDistinctModels(nextModels) ? "EXPANDED" : "SINGLE");
    setRoleModels(next.roleModels);
    setImageModel(next.imageModel ?? "");
    setApiKey("");
    setSettingsJson(formatClaudeSettingsJson(next.baseUrl, next.apiKeyMasked ?? "", next.models));
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
      const connection = connectionFromClaudeSettingsJson(settingsJson, text);
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

  return (
    <>
      <section className="page-heading agent-config-heading">
        <div>
          <span className="eyebrow">{text("CONFIGURATION · 全局配置", "CONFIGURATION · INSTANCE GLOBAL")}</span>
          <h1>{text("Agent 设置", "AGENT SETTINGS")}</h1>
          <p>{text("选择一个 Agent 连接，设计、开发、测试和图片生成都沿用该连接。", "Choose one Agent connection for design, development, testing, and image generation.")}</p>
        </div>
        <span className="scope-badge"><ShieldIcon /> INSTANCE GLOBAL</span>
      </section>

      <div className="settings-page-stack">
        <section className="settings-card settings-section agent-config-form-card">
          <div className="settings-card-title agent-config-card-title">
            <div><h2>{text("Agent 连接", "AGENT CONNECTION")}</h2></div>
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

            {agentRuntime === "CODEX_CLI" ? (
              <div className="agent-connection-status" role="status">
                <ShieldIcon />
                <div><b>{text("OpenAI 官方登录", "OFFICIAL OPENAI SIGN-IN")}</b><p>{text(
                  "使用宿主机 Codex CLI 的 ChatGPT 登录。这里不重复填写 Provider、Base URL 或凭据。",
                  "Uses the host Codex CLI ChatGPT session. No Provider, Base URL, or credential is duplicated here.",
                )}</p></div>
              </div>
            ) : configurationMode === "SIMPLE" ? (
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
                    required={settings.agentRuntime !== "CLAUDE_CODE" || !settings.apiKeyConfigured}
                    spellCheck={false}
                    type="text"
                    value={apiKey}
                  />
                </label>

                <fieldset className="agent-model-fieldset">
                    <legend>Model</legend>
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

              </>
            ) : (
              <label className="settings-json-editor">Claude Code settings.json
                <textarea autoCapitalize="none" autoComplete="off" disabled={loading || saving} onChange={event => setSettingsJson(event.target.value)} spellCheck={false} value={settingsJson} />
              </label>
            )}

            {agentRuntime === "CLAUDE_CODE" ? (
              <label>{text("图片生成模型（可选）", "Image model (optional)")}
                <input autoCapitalize="none" autoComplete="off" disabled={loading || saving} maxLength={200} name="imageModel" onChange={event => setImageModel(event.target.value)} placeholder="gpt-image-1" type="text" value={imageModel} />
                <small className="field-help">{text("沿用当前连接的 Provider、Base URL 和凭据；留空则关闭自动图片生成。", "Uses the selected connection's Provider, Base URL, and credential. Leave blank to disable automatic image generation.")}</small>
              </label>
            ) : null}

            {agentRuntime === "CLAUDE_CODE" ? <fieldset className="agent-model-fieldset agent-role-model-fieldset">
              <legend>{text("群聊 Agent", "GROUP CHAT AGENTS")}</legend>
              <p className="agent-role-model-description">{text(
                "按角色选择模型；开发模型同时用于代码生成。",
                "Choose a model per role; the Development model also generates code.",
              )}</p>
              <div className="agent-model-expanded">
                <ModelInput disabled={loading || saving} label={text("设计 Agent", "Design Agent")} onChange={value => updateRoleModel("design", value)} value={roleModels.design} />
                <ModelInput disabled={loading || saving} label={text("开发 Agent", "Development Agent")} onChange={value => updateRoleModel("development", value)} value={roleModels.development} />
                <ModelInput disabled={loading || saving} label={text("测试 Agent", "Test Agent")} onChange={value => updateRoleModel("test", value)} value={roleModels.test} />
                <p className={`agent-config-notice ${settings.testPolicyReady ? "is-success" : ""}`} role="status">{settings.testPolicyReady
                  ? text("测试 Agent 玩家策略已通过真实视觉决策校验", "Test Agent player policy is ready for visual decisions")
                  : text("测试 Agent 玩家策略将在下一次 E2E 首次视觉决策时完成校验", "Test Agent player policy will be verified by the next E2E visual decision")}</p>
              </div>
            </fieldset> : null}

            {notice ? <p className="agent-config-notice is-success" role="status">{notice}</p> : null}
            {error ? <p className="agent-config-notice is-error" role="alert">{error}</p> : null}
            <button className="button button-primary agent-config-submit" disabled={loading || saving} type="submit">{saving ? text("正在保存…", "SAVING…") : text("保存配置", "SAVE SETTINGS")}</button>
          </form>
        </section>

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
  if (!runtime?.installed) return text("未安装", "NOT INSTALLED");
  if (kind !== "CODEX_CLI") return `v${runtime.version}`;
  const auth = runtime.authentication === "CHATGPT"
    ? text("ChatGPT 已登录", "CHATGPT SIGNED IN")
    : runtime.authentication === "API_KEY"
      ? text("API Key 登录", "API KEY SIGN-IN")
      : text("未登录", "SIGNED OUT");
  return `v${runtime.version} · ${auth}`;
}

function runtimeDescription(kind: AgentRuntimeKind, text: (chinese: string, english: string) => string): string {
  return kind === "CLAUDE_CODE"
    ? text("使用 Anthropic Messages 兼容网关执行 Agent。", "Runs Agents through an Anthropic Messages-compatible gateway.")
    : text("只使用宿主机 OpenAI 官方登录，不读取 Claude Provider 配置。", "Uses only the host's official OpenAI login and never reads Claude Provider settings.");
}

function runtimeClass(
  runtimes: readonly AgentRuntimeAvailability[],
  kind: AgentRuntimeKind,
  loading: boolean,
): string {
  const runtime = runtimes.find(candidate => candidate.kind === kind);
  const ready = runtime?.installed && (kind !== "CODEX_CLI" || runtime.authentication === "CHATGPT");
  return `agent-runtime-status ${loading ? "is-checking" : ready ? "is-installed" : "is-missing"}`;
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

function connectionFromClaudeSettingsJson(
  value: string,
  text: (chinese: string, english: string) => string,
): Readonly<{
  baseUrl: string;
  apiKey: string;
  models: AgentModelConfiguration;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(text("settings.json 不是有效 JSON，修复后才能切回简易表单。", "settings.json is not valid JSON. Fix it before returning to the simple form."));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(text("settings.json 必须包含 JSON 对象。", "settings.json must contain a JSON object."));
  }
  const env = (parsed as Record<string, unknown>).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error(text("settings.json 缺少 env 对象。", "settings.json must contain an env object."));
  }
  const values = env as Record<string, unknown>;
  if (typeof values.ANTHROPIC_BASE_URL !== "string") {
    throw new Error(text("settings.json 缺少 ANTHROPIC_BASE_URL。", "settings.json is missing ANTHROPIC_BASE_URL."));
  }
  const credential = values.ANTHROPIC_API_KEY || values.ANTHROPIC_AUTH_TOKEN || "";
  if (typeof credential !== "string") throw new Error(text("settings.json 中的凭据必须是字符串。", "The credential in settings.json must be a string."));
  const models = {
    primary: values.ANTHROPIC_MODEL,
    opus: values.ANTHROPIC_DEFAULT_OPUS_MODEL,
    sonnet: values.ANTHROPIC_DEFAULT_SONNET_MODEL,
    haiku: values.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    subagent: values.CLAUDE_CODE_SUBAGENT_MODEL,
  };
  if (Object.values(models).some(model => typeof model !== "string")) {
    throw new Error(text("settings.json 中的模型变量必须是字符串。", "Model variables in settings.json must be strings."));
  }
  const configuredModelCount = Object.values(models).filter(Boolean).length;
  if (configuredModelCount !== 0 && configuredModelCount !== 5) {
    throw new Error(text("settings.json 必须同时填写全部 5 个模型变量。", "Fill in all five model variables in settings.json together."));
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
    design: CODEX_ACCOUNT_DEFAULT_MODEL,
    development: CODEX_ACCOUNT_DEFAULT_MODEL,
    test: CODEX_ACCOUNT_DEFAULT_MODEL,
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
