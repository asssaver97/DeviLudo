"use client";

import { useEffect, useState, type FormEvent } from "react";
import { cachedValue, clientCacheKeys, loadCached, storeCached } from "@/lib/product/client-cache";
import {
  AGENT_RUNTIME_KINDS,
  type AgentModelOverrides,
  type AgentRuntimeLocalDefault,
  type AgentRuntimeAvailability,
  type AgentRuntimeKind,
  type InstanceAgentSettings,
} from "@/lib/product/contracts";
import { EyeIcon, FileIcon, SettingsIcon, ShieldIcon } from "./console/Icons";
import { useLanguage } from "./i18n/LanguageProvider";

type ConfigurationMode = "SIMPLE" | "SETTINGS_JSON";
type CodexConnectionMode = "OFFICIAL" | "CUSTOM";
type AgentSettingsPayload = Readonly<{
  settings: InstanceAgentSettings;
  runtimes: readonly AgentRuntimeAvailability[];
  localDefaults: readonly AgentRuntimeLocalDefault[];
}>;

const DEFAULT_SETTINGS: InstanceAgentSettings = Object.freeze({
  agentRuntime: "CLAUDE_CODE",
  baseUrl: "https://api.anthropic.com",
  primaryModel: "claude-sonnet-4-5",
  modelOverrides: emptyModelOverrides(),
  imageModel: null,
  imageGenerationBackend: null,
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

export function AgentSettings() {
  const { errorText, text } = useLanguage();
  const initialPayload = cachedValue<AgentSettingsPayload>(clientCacheKeys.agentSettings);
  const initialSettings = initialPayload?.settings ?? DEFAULT_SETTINGS;
  const initialDefaults = initialPayload?.localDefaults ?? [];
  const initialConnection = runtimeConnection(initialSettings.agentRuntime, initialSettings, initialDefaults);
  const [settings, setSettings] = useState<InstanceAgentSettings>(initialSettings);
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeKind>(initialConnection.agentRuntime);
  const [baseUrl, setBaseUrl] = useState(initialConnection.baseUrl);
  const [primaryModel, setPrimaryModel] = useState(initialConnection.primaryModel);
  const [modelOverrides, setModelOverrides] = useState<AgentModelOverrides>(initialSettings.modelOverrides);
  const [imageModel, setImageModel] = useState(initialSettings.imageModel ?? "");
  const [apiKey, setApiKey] = useState(initialConnection.apiKeyMasked ?? "");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [revealingApiKey, setRevealingApiKey] = useState(false);
  const [configurationMode, setConfigurationMode] = useState<ConfigurationMode>("SIMPLE");
  const [codexConnectionMode, setCodexConnectionMode] = useState<CodexConnectionMode>(
    initialSettings.agentRuntime === "CODEX_CLI" && initialSettings.baseUrl !== "https://chatgpt.com" ? "CUSTOM" : "OFFICIAL",
  );
  const [settingsJson, setSettingsJson] = useState(() => formatClaudeSettingsJson(initialConnection.baseUrl, initialConnection.apiKeyMasked ?? "", initialConnection.primaryModel));
  const [runtimes, setRuntimes] = useState<readonly AgentRuntimeAvailability[]>(initialPayload?.runtimes ?? []);
  const [localDefaults, setLocalDefaults] = useState<readonly AgentRuntimeLocalDefault[]>(initialDefaults);
  const [loading, setLoading] = useState(!initialPayload);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void loadCached<AgentSettingsPayload>(clientCacheKeys.agentSettings, 60_000, async () => {
        const response = await fetch("/api/settings/agent", { cache: "no-store" });
        const body = await response.json() as {
          settings?: InstanceAgentSettings;
          runtimes?: readonly AgentRuntimeAvailability[];
          localDefaults?: readonly AgentRuntimeLocalDefault[];
          message?: string;
        };
        if (!response.ok || !body.settings) throw new Error(errorText(body.message, "无法读取 Agent 设置", "Unable to load Agent settings"));
        return Object.freeze({ settings: body.settings, runtimes: body.runtimes ?? [], localDefaults: body.localDefaults ?? [] });
      })
      .then(body => {
        if (!active) return;
        const value = body.settings;
        const connection = runtimeConnection(value.agentRuntime, value, body.localDefaults);
        setSettings(value);
        setAgentRuntime(connection.agentRuntime);
        setBaseUrl(connection.baseUrl);
        setCodexConnectionMode(connection.agentRuntime === "CODEX_CLI" && connection.baseUrl !== "https://chatgpt.com" ? "CUSTOM" : "OFFICIAL");
        setPrimaryModel(connection.primaryModel);
        setModelOverrides(value.modelOverrides);
        setImageModel(value.imageModel ?? "");
        setApiKey(connection.apiKeyMasked ?? "");
        setApiKeyVisible(false);
        setSettingsJson(formatClaudeSettingsJson(connection.baseUrl, connection.apiKeyMasked ?? "", connection.primaryModel));
        setRuntimes(body.runtimes);
        setLocalDefaults(body.localDefaults);
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
        body: JSON.stringify(currentFormInput()),
      });
      const body = await response.json() as { settings?: InstanceAgentSettings; message?: string };
      if (!response.ok || !body.settings) throw new Error(errorText(body.message, "保存失败", "Save failed"));
      storeCached(clientCacheKeys.agentSettings, Object.freeze({ settings: body.settings, runtimes, localDefaults }), 60_000);
      setSettings(body.settings);
      setAgentRuntime(body.settings.agentRuntime);
      setBaseUrl(body.settings.baseUrl);
      setCodexConnectionMode(body.settings.agentRuntime === "CODEX_CLI" && body.settings.baseUrl !== "https://chatgpt.com" ? "CUSTOM" : "OFFICIAL");
      setPrimaryModel(body.settings.primaryModel);
      setModelOverrides(body.settings.modelOverrides);
      setImageModel(body.settings.imageModel ?? "");
      setApiKey(body.settings.apiKeyMasked ?? "");
      setApiKeyVisible(false);
      setSettingsJson(formatClaudeSettingsJson(
        body.settings.baseUrl,
        body.settings.apiKeyMasked ?? "",
        body.settings.primaryModel,
      ));
      setNotice(text("Agent 配置已保存，仅影响之后启动的任务。", "Agent settings saved. They apply to newly started jobs only."));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : text("保存失败", "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/settings/agent/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(currentFormInput()),
      });
      const body = await response.json() as { ok?: boolean; message?: string };
      if (!response.ok || !body.ok) throw new Error(errorText(body.message, "连接测试失败", "Connection test failed"));
      setNotice(text("Agent 连接测试成功。", "Agent connection test passed."));
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : text("连接测试失败", "Connection test failed"));
    } finally {
      setTesting(false);
    }
  }

  async function toggleApiKeyVisibility() {
    if (apiKeyVisible) {
      setApiKeyVisible(false);
      return;
    }
    if (apiKey && !isMaskedKey(apiKey)) {
      setApiKeyVisible(true);
      return;
    }
    setRevealingApiKey(true);
    setError("");
    try {
      const response = await fetch("/api/settings/agent/credential", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(currentFormInput()),
      });
      const body = await response.json() as { apiKey?: string; message?: string };
      if (!response.ok || !body.apiKey) throw new Error(errorText(body.message, "无法读取 API Key", "Unable to read the API key"));
      setApiKey(body.apiKey);
      setApiKeyVisible(true);
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : text("无法读取 API Key", "Unable to read the API key"));
    } finally {
      setRevealingApiKey(false);
    }
  }

  function currentFormInput(): Readonly<Record<string, unknown>> {
    return configurationMode === "SETTINGS_JSON" && agentRuntime === "CLAUDE_CODE"
      ? { agentRuntime, settingsJson, modelOverrides, imageModel }
      : {
          agentRuntime,
          primaryModel,
          modelOverrides,
          ...(agentRuntime === "CLAUDE_CODE" ? {
            baseUrl,
            imageModel,
            ...(apiKey ? { apiKey } : {}),
          } : codexConnectionMode === "CUSTOM" ? {
            baseUrl,
            ...(apiKey ? { apiKey } : {}),
          } : {}),
        };
  }

  function selectRuntime(kind: AgentRuntimeKind) {
    setAgentRuntime(kind);
    const next = runtimeConnection(kind, settings, localDefaults);
    if (kind === "CODEX_CLI") {
      setConfigurationMode("SIMPLE");
      const custom = next.baseUrl !== "https://chatgpt.com";
      setCodexConnectionMode(custom ? "CUSTOM" : "OFFICIAL");
      setBaseUrl(next.baseUrl);
      setPrimaryModel(next.primaryModel);
      setModelOverrides(settings.agentRuntime === "CODEX_CLI" ? settings.modelOverrides : emptyModelOverrides());
      setImageModel("");
      setApiKey(next.apiKeyMasked ?? "");
      setApiKeyVisible(false);
      return;
    }
    setBaseUrl(next.baseUrl);
    setPrimaryModel(next.primaryModel);
    setModelOverrides(settings.agentRuntime === "CLAUDE_CODE" ? settings.modelOverrides : emptyModelOverrides());
    setImageModel(settings.agentRuntime === "CLAUDE_CODE" ? settings.imageModel ?? "" : "");
    setApiKey(next.apiKeyMasked ?? "");
    setApiKeyVisible(false);
    setSettingsJson(formatClaudeSettingsJson(next.baseUrl, next.apiKeyMasked ?? "", next.primaryModel));
  }

  function switchConfigurationMode(mode: ConfigurationMode) {
    setError("");
    if (mode === "SETTINGS_JSON") {
      setSettingsJson(formatClaudeSettingsJson(
        baseUrl,
        apiKey || settings.apiKeyMasked || "",
        primaryModel,
      ));
      setConfigurationMode(mode);
      return;
    }
    try {
      const connection = connectionFromClaudeSettingsJson(settingsJson, text);
      setBaseUrl(connection.baseUrl);
      setApiKey(connection.apiKey);
      setPrimaryModel(connection.primaryModel);
      setConfigurationMode(mode);
    } catch (modeError) {
      setError(modeError instanceof Error ? modeError.message : text("settings.json 格式无效", "Invalid settings.json"));
    }
  }

  function updateModelOverride(key: keyof AgentModelOverrides, value: string) {
    setModelOverrides(current => Object.freeze({ ...current, [key]: value.trim() ? value : null }));
  }

  const selectedLocalDefault = localDefaults.find(candidate => candidate.agentRuntime === agentRuntime) ?? null;

  return (
    <>
      <section className="page-heading agent-config-heading">
        <div>
          <span className="eyebrow">{text("CONFIGURATION · 全局配置", "CONFIGURATION · INSTANCE GLOBAL")}</span>
          <h1>{text("Agent 设置", "AGENT SETTINGS")}</h1>
          <p>{text("选择一个 Agent 运行时；文本 Agent 可继承主模型，图片生成后端会随运行时自动切换。", "Choose one Agent runtime. Text Agents may inherit the primary model; the image-generation backend follows the selected runtime automatically.")}</p>
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
                    <span><span className="agent-runtime-name"><b>{RUNTIME_COPY[kind].name}</b><em className={runtimeClass(runtimes, kind, loading, codexConnectionMode)}>{runtimeLabel(runtimes, kind, loading, text)}</em></span><small>{runtimeDescription(kind, text)}</small></span>
                    <i aria-hidden="true" />
                  </label>
                ))}
              </div>
            </fieldset>

            {selectedLocalDefault ? (
              <aside className="agent-local-default" role="status">
                <b>{text("已读取本地默认配置", "LOCAL DEFAULT LOADED")} · {selectedLocalDefault.source}</b>
                <span>Base URL · {selectedLocalDefault.baseUrl}</span>
                <span>{text("主模型", "Primary model")} · {selectedLocalDefault.primaryModel}</span>
                {selectedLocalDefault.apiKeyMasked ? <span>API Key · {selectedLocalDefault.apiKeyMasked}</span> : null}
              </aside>
            ) : null}

            {agentRuntime === "CODEX_CLI" ? (
              <>
                <label>{text("Codex 连接", "Codex connection")}
                  <select disabled={loading || saving} onChange={event => {
                    const mode = event.target.value as CodexConnectionMode;
                    const discovered = localDefaults.find(candidate => candidate.agentRuntime === "CODEX_CLI") ?? null;
                    const useDiscovered = discovered && (discovered.baseUrl === "https://chatgpt.com") === (mode === "OFFICIAL");
                    setCodexConnectionMode(mode);
                    setBaseUrl(useDiscovered ? discovered.baseUrl : mode === "OFFICIAL" ? "https://chatgpt.com" : "https://api.x.ai/v1");
                    setPrimaryModel(useDiscovered ? discovered.primaryModel : mode === "OFFICIAL" ? "account-default" : "xai/grok-4.6");
                    setApiKey(useDiscovered ? discovered.apiKeyMasked ?? "" : "");
                    setApiKeyVisible(false);
                  }} value={codexConnectionMode}>
                    <option value="OFFICIAL">{text("OpenAI 官方登录（默认）", "Official OpenAI sign-in (default)")}</option>
                    <option value="CUSTOM">{text("自定义 Responses Provider", "Custom Responses Provider")}</option>
                  </select>
                </label>
                {codexConnectionMode === "OFFICIAL" ? (
                  <div className="agent-connection-status" role="status">
                    <ShieldIcon />
                    <div><b>{text("OpenAI 官方登录", "OFFICIAL OPENAI SIGN-IN")}</b><p>{text(
                      "使用宿主机 Codex CLI 的 ChatGPT 登录和本地主模型配置。",
                      "Uses the host Codex CLI ChatGPT session and local primary-model setting.",
                    )}</p></div>
                  </div>
                ) : (
                  <>
                    <label>Responses Base URL
                      <input autoComplete="url" disabled={loading || saving} maxLength={2048} onChange={event => {
                        setBaseUrl(event.target.value);
                        if (isMaskedKey(apiKey)) setApiKey("");
                      }} placeholder="https://api.x.ai/v1" required type="url" value={baseUrl} />
                      <small className="field-help">{text("外部域名必须在 DEVILUDO_PROVIDER_ALLOWLIST 中；宿主机网关使用 http://host.docker.internal:端口。", "External domains must be in DEVILUDO_PROVIDER_ALLOWLIST; use http://host.docker.internal:port for a host gateway.")}</small>
                    </label>
                    <SecretInput
                      apiKey={apiKey}
                      disabled={loading || saving}
                      loading={revealingApiKey}
                      onChange={setApiKey}
                      onToggle={() => void toggleApiKeyVisibility()}
                      placeholder={selectedLocalDefault?.apiKeyMasked ?? settings.apiKeyMasked ?? text("输入 API Key", "Enter API Key")}
                      required={!apiKey}
                      text={text}
                      visible={apiKeyVisible}
                    />
                  </>
                )}
                <label>{text("主模型", "Primary model")}
                  <input autoCapitalize="none" autoComplete="off" disabled={loading || saving} maxLength={200} name="primaryModel" onChange={event => setPrimaryModel(event.target.value)} placeholder="account-default" required type="text" value={primaryModel} />
                  <small className="field-help">{codexConnectionMode === "OFFICIAL"
                    ? text("填写 Codex CLI 可用模型；account-default 使用账户默认模型。", "Enter a Codex CLI model; account-default uses the account default.")
                    : text("填写 Provider 暴露的模型，例如 xai/grok-4.6。", "Enter a model exposed by the Provider, such as xai/grok-4.6.")}</small>
                </label>
              </>
            ) : configurationMode === "SIMPLE" ? (
              <>
                <label>Provider Base URL
                  <input autoComplete="url" disabled={loading || saving} maxLength={2048} name="baseUrl" onChange={event => {
                    setBaseUrl(event.target.value);
                    if (isMaskedKey(apiKey)) setApiKey("");
                  }} placeholder="https://api.example.com/v1" required type="url" value={baseUrl} />
                </label>

                <SecretInput
                  apiKey={apiKey}
                  disabled={loading || saving}
                  loading={revealingApiKey}
                  onChange={setApiKey}
                  onToggle={() => void toggleApiKeyVisibility()}
                  placeholder={selectedLocalDefault?.apiKeyMasked ?? settings.apiKeyMasked ?? text("输入 API Key", "Enter API Key")}
                  required={!apiKey}
                  text={text}
                  visible={apiKeyVisible}
                />

                <label>{text("主模型", "Primary model")}
                  <input autoCapitalize="none" autoComplete="off" disabled={loading || saving} maxLength={200} name="primaryModel" onChange={event => setPrimaryModel(event.target.value)} placeholder="claude-sonnet-4-5" required type="text" value={primaryModel} />
                </label>

              </>
            ) : (
              <label className="settings-json-editor">Claude Code settings.json
                <textarea autoCapitalize="none" autoComplete="off" disabled={loading || saving} onChange={event => setSettingsJson(event.target.value)} spellCheck={false} value={settingsJson} />
              </label>
            )}

            <fieldset className="agent-model-fieldset agent-role-model-fieldset">
              <legend>{text("Agent 模型", "AGENT MODELS")}</legend>
              <div className="agent-model-top-level">
                <ModelInput disabled={loading || saving} inheritLabel={text("继承主模型", "Inherits primary")} label={text("意图 Agent", "Intent Agent")} onChange={value => updateModelOverride("intent", value)} placeholder={primaryModel} value={modelOverrides.intent ?? ""} />
                {agentRuntime === "CLAUDE_CODE"
                  ? <ModelInput disabled={loading || saving} label={text("图片生成模型", "Image generation model")} onChange={setImageModel} placeholder={text("例如 gpt-image-2", "For example, gpt-image-2")} value={imageModel} />
                  : <ModelInput disabled inheritLabel={text("Codex 内置 ImageGen · 随运行时自动选择", "Codex built-in ImageGen · selected by runtime")} label={text("图片生成模型", "Image generation model")} onChange={() => undefined} placeholder="gpt-image-2" value="gpt-image-2" />}
              </div>
              <details className="agent-role-model-details">
                <summary>{text("配置项目 Agent 模型", "CONFIGURE PROJECT AGENT MODELS")}<span>4</span></summary>
                <div className="agent-model-expanded">
                  <ModelInput disabled={loading || saving} inheritLabel={text("继承主模型", "Inherits primary")} label={text("项目分析 Agent", "Project Analysis Agent")} onChange={value => updateModelOverride("analysis", value)} placeholder={primaryModel} value={modelOverrides.analysis ?? ""} />
                  <ModelInput disabled={loading || saving} inheritLabel={text("继承主模型", "Inherits primary")} label={text("设计 Agent", "Design Agent")} onChange={value => updateModelOverride("design", value)} placeholder={primaryModel} value={modelOverrides.design ?? ""} />
                  <ModelInput disabled={loading || saving} inheritLabel={text("继承主模型", "Inherits primary")} label={text("UI 设计 Agent", "UI Design Agent")} onChange={value => updateModelOverride("uiDesign", value)} placeholder={primaryModel} value={modelOverrides.uiDesign ?? ""} />
                  <ModelInput disabled={loading || saving} inheritLabel={text("继承主模型", "Inherits primary")} label={text("开发 Agent", "Development Agent")} onChange={value => updateModelOverride("development", value)} placeholder={primaryModel} value={modelOverrides.development ?? ""} />
                  <ModelInput disabled={loading || saving} inheritLabel={text("继承主模型", "Inherits primary")} label={text("测试 Agent", "Test Agent")} onChange={value => updateModelOverride("test", value)} placeholder={primaryModel} value={modelOverrides.test ?? ""} />
                </div>
              </details>
            </fieldset>

            {notice ? <p className="agent-config-notice is-success" role="status">{notice}</p> : null}
            {error ? <p className="agent-config-notice is-error" role="alert">{error}</p> : null}
            <div className="agent-config-actions">
              <button className="button button-primary agent-config-submit" disabled={loading || saving || testing} type="submit">{saving ? text("正在保存…", "SAVING…") : text("保存配置", "SAVE SETTINGS")}</button>
              <button className="button agent-config-submit" disabled={loading || saving || testing} onClick={testConnection} type="button">{testing ? text("正在测试…", "TESTING…") : text("测试连接", "TEST CONNECTION")}</button>
            </div>
          </form>
        </section>

      </div>
    </>
  );
}

function SecretInput({
  apiKey,
  disabled,
  loading,
  onChange,
  onToggle,
  placeholder,
  required,
  text,
  visible,
}: Readonly<{
  apiKey: string;
  disabled: boolean;
  loading: boolean;
  onChange: (value: string) => void;
  onToggle: () => void;
  placeholder: string;
  required: boolean;
  text: (chinese: string, english: string) => string;
  visible: boolean;
}>) {
  return (
    <label>API Key
      <span className="agent-secret-input">
        <input
          aria-autocomplete="none"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          data-1p-ignore="true"
          data-bwignore="true"
          data-form-type="other"
          data-lpignore="true"
          disabled={disabled}
          maxLength={4096}
          minLength={8}
          name="providerCredential"
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
          required={required}
          spellCheck={false}
          type={visible ? "text" : "password"}
          value={apiKey}
        />
        <button
          aria-label={visible ? text("隐藏 API Key", "Hide API key") : text("显示 API Key", "Show API key")}
          disabled={disabled || loading}
          onClick={onToggle}
          title={visible ? text("隐藏 API Key", "Hide API key") : text("显示 API Key", "Show API key")}
          type="button"
        ><EyeIcon closed={visible} /></button>
      </span>
    </label>
  );
}

function ModelInput({
  disabled,
  inheritLabel,
  label,
  onChange,
  placeholder,
  value,
}: Readonly<{
  disabled: boolean;
  inheritLabel?: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}>) {
  return (
    <label><span>{label}</span>
      <input autoCapitalize="none" autoComplete="off" disabled={disabled} maxLength={200} onChange={event => onChange(event.target.value)} placeholder={placeholder} type="text" value={value} />
      {inheritLabel ? <small className="field-help">{inheritLabel}</small> : null}
    </label>
  );
}

function runtimeConnection(
  kind: AgentRuntimeKind,
  settings: InstanceAgentSettings,
  localDefaults: readonly AgentRuntimeLocalDefault[],
): Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  primaryModel: string;
  apiKeyMasked: string | null;
}> {
  if (settings.revision > 0 && settings.agentRuntime === kind) {
    return Object.freeze({
      agentRuntime: kind,
      baseUrl: settings.baseUrl,
      primaryModel: settings.primaryModel,
      apiKeyMasked: settings.apiKeyMasked,
    });
  }
  const localDefault = localDefaults.find(candidate => candidate.agentRuntime === kind);
  if (localDefault) return localDefault;
  return kind === "CODEX_CLI"
    ? Object.freeze({ agentRuntime: kind, baseUrl: "https://chatgpt.com", primaryModel: "account-default", apiKeyMasked: null })
    : Object.freeze({ agentRuntime: kind, baseUrl: "https://api.anthropic.com", primaryModel: "claude-sonnet-4-5", apiKeyMasked: null });
}

function isMaskedKey(value: string): boolean {
  return /^.{3}\*{8}.{4}$/u.test(value);
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
    : text("使用官方登录或显式配置的 Responses Provider。", "Uses official sign-in or an explicitly configured Responses Provider.");
}

function runtimeClass(
  runtimes: readonly AgentRuntimeAvailability[],
  kind: AgentRuntimeKind,
  loading: boolean,
  codexConnectionMode: CodexConnectionMode,
): string {
  const runtime = runtimes.find(candidate => candidate.kind === kind);
  const ready = runtime?.installed && (kind !== "CODEX_CLI"
    || codexConnectionMode === "CUSTOM"
    || runtime.authentication === "CHATGPT");
  return `agent-runtime-status ${loading ? "is-checking" : ready ? "is-installed" : "is-missing"}`;
}

function formatClaudeSettingsJson(
  baseUrl: string,
  apiKey: string,
  primaryModel: string,
): string {
  return JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: primaryModel,
    },
  }, null, 2);
}

function connectionFromClaudeSettingsJson(
  value: string,
  text: (chinese: string, english: string) => string,
): Readonly<{
  baseUrl: string;
  apiKey: string;
  primaryModel: string;
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
  if (typeof values.ANTHROPIC_MODEL !== "string" || !values.ANTHROPIC_MODEL) {
    throw new Error(text("settings.json 缺少主模型 ANTHROPIC_MODEL。", "settings.json is missing the primary ANTHROPIC_MODEL."));
  }
  return Object.freeze({
    baseUrl: values.ANTHROPIC_BASE_URL,
    apiKey: credential,
    primaryModel: values.ANTHROPIC_MODEL,
  });
}

function emptyModelOverrides(): AgentModelOverrides {
  return Object.freeze({ intent: null, analysis: null, design: null, uiDesign: null, development: null, test: null });
}
