"use client";

import { useEffect, useState, type FormEvent } from "react";
import { cachedValue, clientCacheKeys, loadCached, storeCached } from "@/lib/product/client-cache";
import {
  AGENT_RUNTIME_KINDS,
  type AgentModelOverrides,
  type AgentRuntimeAvailability,
  type AgentRuntimeKind,
  type InstanceAgentSettings,
} from "@/lib/product/contracts";
import { FileIcon, SettingsIcon, ShieldIcon } from "./console/Icons";
import { useLanguage } from "./i18n/LanguageProvider";

type ConfigurationMode = "SIMPLE" | "SETTINGS_JSON";
type AgentSettingsPayload = Readonly<{
  settings: InstanceAgentSettings;
  runtimes: readonly AgentRuntimeAvailability[];
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
  const [settings, setSettings] = useState<InstanceAgentSettings>(initialSettings);
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeKind>(initialSettings.agentRuntime);
  const [baseUrl, setBaseUrl] = useState(initialSettings.baseUrl);
  const [primaryModel, setPrimaryModel] = useState(initialSettings.primaryModel);
  const [modelOverrides, setModelOverrides] = useState<AgentModelOverrides>(initialSettings.modelOverrides);
  const [imageModel, setImageModel] = useState(initialSettings.imageModel ?? "");
  const [apiKey, setApiKey] = useState("");
  const [configurationMode, setConfigurationMode] = useState<ConfigurationMode>("SIMPLE");
  const [settingsJson, setSettingsJson] = useState(() => formatClaudeSettingsJson(initialSettings.baseUrl, initialSettings.apiKeyMasked ?? "", initialSettings.primaryModel));
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
        setPrimaryModel(value.primaryModel);
        setModelOverrides(value.modelOverrides);
        setImageModel(value.imageModel ?? "");
        setSettingsJson(formatClaudeSettingsJson(value.baseUrl, value.apiKeyMasked ?? "", value.primaryModel));
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
          ? { agentRuntime, settingsJson, modelOverrides, imageModel }
          : {
              agentRuntime,
              primaryModel,
              modelOverrides,
              ...(agentRuntime === "CLAUDE_CODE" ? {
                baseUrl,
                imageModel,
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
      setPrimaryModel(body.settings.primaryModel);
      setModelOverrides(body.settings.modelOverrides);
      setImageModel(body.settings.imageModel ?? "");
      setApiKey("");
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

  function selectRuntime(kind: AgentRuntimeKind) {
    setAgentRuntime(kind);
    if (kind === "CODEX_CLI") {
      setConfigurationMode("SIMPLE");
      setPrimaryModel(settings.agentRuntime === "CODEX_CLI" ? settings.primaryModel : "account-default");
      setModelOverrides(settings.agentRuntime === "CODEX_CLI" ? settings.modelOverrides : emptyModelOverrides());
      setImageModel("");
      setApiKey("");
      return;
    }
    const next = settings.agentRuntime === "CLAUDE_CODE" ? settings : DEFAULT_SETTINGS;
    setBaseUrl(next.baseUrl);
    setPrimaryModel(next.primaryModel);
    setModelOverrides(next.modelOverrides);
    setImageModel(next.imageModel ?? "");
    setApiKey("");
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
                    <span><span className="agent-runtime-name"><b>{RUNTIME_COPY[kind].name}</b><em className={runtimeClass(runtimes, kind, loading)}>{runtimeLabel(runtimes, kind, loading, text)}</em></span><small>{runtimeDescription(kind, text)}</small></span>
                    <i aria-hidden="true" />
                  </label>
                ))}
              </div>
            </fieldset>

            {agentRuntime === "CODEX_CLI" ? (
              <>
                <div className="agent-connection-status" role="status">
                  <ShieldIcon />
                  <div><b>{text("OpenAI 官方登录", "OFFICIAL OPENAI SIGN-IN")}</b><p>{text(
                    "使用宿主机 Codex CLI 的 ChatGPT 登录。Provider、Base URL 和凭据由官方登录管理，模型可在下方配置。",
                    "Uses the host Codex CLI ChatGPT session. Official sign-in manages the Provider, Base URL, and credential; the model remains configurable below.",
                  )}</p></div>
                </div>
                <label>{text("主模型", "Primary model")}
                  <input autoCapitalize="none" autoComplete="off" disabled={loading || saving} maxLength={200} name="primaryModel" onChange={event => setPrimaryModel(event.target.value)} placeholder="account-default" required type="text" value={primaryModel} />
                  <small className="field-help">{text("填写 Codex CLI 可用模型；使用 account-default 时由官方登录选择账户默认模型。", "Enter a model available to Codex CLI, or use account-default to let official sign-in select the account default.")}</small>
                </label>
              </>
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

                <label>{text("主模型", "Primary model")}
                  <input autoCapitalize="none" autoComplete="off" disabled={loading || saving} maxLength={200} name="primaryModel" onChange={event => setPrimaryModel(event.target.value)} placeholder="claude-sonnet-4-5" required type="text" value={primaryModel} />
                  <small className="field-help">{text("设计、开发和测试 Agent 默认使用主模型；图片生成不继承。", "Design, Development, and Test Agents use this model by default; image generation does not inherit it.")}</small>
                </label>

              </>
            ) : (
              <label className="settings-json-editor">Claude Code settings.json
                <textarea autoCapitalize="none" autoComplete="off" disabled={loading || saving} onChange={event => setSettingsJson(event.target.value)} spellCheck={false} value={settingsJson} />
              </label>
            )}

            <fieldset className="agent-model-fieldset agent-role-model-fieldset">
              <legend>{text("Agent 模型", "AGENT MODELS")}</legend>
              <p className="agent-role-model-description">{text(
                agentRuntime === "CLAUDE_CODE"
                  ? "设计、开发和测试模型留空时继承主模型。Claude Code 使用当前连接的兼容 Images API；图片模型留空时关闭自动生成。"
                  : "设计、开发和测试模型留空时继承主模型；图片生成自动使用 Codex 内置 ImageGen（gpt-image-2），沿用官方登录且无需额外 Provider。",
                agentRuntime === "CLAUDE_CODE"
                  ? "Design, Development, and Test inherit the primary model when empty. Claude Code uses the selected connection's compatible Images API; an empty image model disables generation."
                  : "Design, Development, and Test inherit the primary model when empty. Image generation automatically uses Codex built-in ImageGen (gpt-image-2) with the official sign-in and no second Provider.",
              )}</p>
              <div className="agent-model-expanded">
                <ModelInput disabled={loading || saving} inheritLabel={text("继承主模型", "Inherits primary")} label={text("设计 Agent", "Design Agent")} onChange={value => updateModelOverride("design", value)} placeholder={primaryModel} value={modelOverrides.design ?? ""} />
                <ModelInput disabled={loading || saving} inheritLabel={text("继承主模型", "Inherits primary")} label={text("开发 Agent", "Development Agent")} onChange={value => updateModelOverride("development", value)} placeholder={primaryModel} value={modelOverrides.development ?? ""} />
                <ModelInput disabled={loading || saving} inheritLabel={text("继承主模型", "Inherits primary")} label={text("测试 Agent", "Test Agent")} onChange={value => updateModelOverride("test", value)} placeholder={primaryModel} value={modelOverrides.test ?? ""} />
                {agentRuntime === "CLAUDE_CODE"
                  ? <ModelInput disabled={loading || saving} inheritLabel={text("Images API · 留空时关闭图片生成", "Images API · empty disables generation")} label={text("图片生成模型", "Image generation model")} onChange={setImageModel} placeholder={text("例如 gpt-image-2", "For example, gpt-image-2")} value={imageModel} />
                  : <ModelInput disabled inheritLabel={text("Codex 内置 ImageGen · 随运行时自动选择", "Codex built-in ImageGen · selected by runtime")} label={text("图片生成模型", "Image generation model")} onChange={() => undefined} placeholder="gpt-image-2" value="gpt-image-2" />}
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

      </div>
    </>
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
  inheritLabel: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}>) {
  return (
    <label><span>{label}</span>
      <input autoCapitalize="none" autoComplete="off" disabled={disabled} maxLength={200} onChange={event => onChange(event.target.value)} placeholder={placeholder} type="text" value={value} />
      <small className="field-help">{inheritLabel}</small>
    </label>
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
  return Object.freeze({ design: null, development: null, test: null });
}
