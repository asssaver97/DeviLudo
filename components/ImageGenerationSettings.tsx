"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ImageGenerationConfig, ImageGenerationProvider } from "@/lib/product/asset-manifest";

const PROVIDERS: readonly ImageGenerationProvider[] = ["dalle-3", "stable-diffusion-xl", "midjourney", "replicate"];

const PROVIDER_INFO: Record<ImageGenerationProvider, { name: string; description: string; requiresApiKey: boolean }> = {
  "dalle-3": {
    name: "DALL-E 3",
    description: "OpenAI 的图片生成模型，质量高，适合游戏美术",
    requiresApiKey: true,
  },
  "stable-diffusion-xl": {
    name: "Stable Diffusion XL",
    description: "开源模型，可自托管或使用 Replicate API",
    requiresApiKey: true,
  },
  "midjourney": {
    name: "Midjourney",
    description: "需要通过第三方 API 网关接入",
    requiresApiKey: true,
  },
  "replicate": {
    name: "Replicate",
    description: "多模型平台，支持 SDXL、Flux 等",
    requiresApiKey: true,
  },
};

export function ImageGenerationSettings() {
  const [config, setConfig] = useState<ImageGenerationConfig | null>(null);
  const [provider, setProvider] = useState<ImageGenerationProvider>("dalle-3");
  const [apiKey, setApiKey] = useState("");
  const [apiEndpoint, setApiEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const response = await fetch("/api/settings/image-generation");
      if (response.ok) {
        const data = await response.json();
        setConfig(data);
        if (data) {
          setProvider(data.provider);
          setApiEndpoint(data.apiEndpoint || "");
          setModel(data.model || "");
        }
      }
    } catch (error) {
      console.error("Failed to load image generation config:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setNotice("");

    try {
      const payload: Partial<ImageGenerationConfig> & { provider: ImageGenerationProvider } = {
        provider,
        apiEndpoint: apiEndpoint || undefined,
        model: model || undefined,
      };

      if (apiKey) {
        (payload as any).apiKey = apiKey;
      }

      const response = await fetch("/api/settings/image-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        setNotice("配置已保存");
        setApiKey("");
        await loadConfig();
      } else {
        const error = await response.json();
        setNotice(`保存失败: ${error.message || response.statusText}`);
      }
    } catch (error) {
      setNotice(`保存失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="settings-loading">加载配置...</div>;
  }

  const currentProvider = PROVIDER_INFO[provider];

  return (
    <div className="image-generation-settings">
      <h3>图片生成配置</h3>
      <p className="settings-description">
        配置后，Agent 规划的游戏素材可以自动生成。如果不配置，需要手动上传素材。
      </p>

      <form onSubmit={handleSubmit} className="settings-form">
        <div className="form-group">
          <label htmlFor="provider">图片生成提供商</label>
          <select
            id="provider"
            value={provider}
            onChange={e => setProvider(e.target.value as ImageGenerationProvider)}
            className="form-control"
          >
            {PROVIDERS.map(p => (
              <option key={p} value={p}>
                {PROVIDER_INFO[p].name}
              </option>
            ))}
          </select>
          <div className="form-help">{currentProvider.description}</div>
        </div>

        {currentProvider.requiresApiKey && (
          <div className="form-group">
            <label htmlFor="apiKey">API Key</label>
            <input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={config?.apiKey ? "••••••••（已配置）" : "输入 API Key"}
              className="form-control"
            />
            <div className="form-help">
              {config?.apiKey ? "已配置 API Key，留空表示不修改" : "必填"}
            </div>
          </div>
        )}

        <div className="form-group">
          <label htmlFor="apiEndpoint">API 端点（可选）</label>
          <input
            id="apiEndpoint"
            type="url"
            value={apiEndpoint}
            onChange={e => setApiEndpoint(e.target.value)}
            placeholder={provider === "dalle-3" ? "https://api.openai.com/v1" : "https://api.replicate.com"}
            className="form-control"
          />
          <div className="form-help">留空使用默认端点</div>
        </div>

        <div className="form-group">
          <label htmlFor="model">模型名称（可选）</label>
          <input
            id="model"
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={provider === "dalle-3" ? "dall-e-3" : provider === "replicate" ? "stability-ai/sdxl" : ""}
            className="form-control"
          />
          <div className="form-help">留空使用默认模型</div>
        </div>

        <div className="form-actions">
          <button type="submit" disabled={saving || (!apiKey && !config?.apiKey)} className="btn-primary">
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>

        {notice && (
          <div className={`form-notice ${notice.includes("失败") ? "notice-error" : "notice-success"}`}>
            {notice}
          </div>
        )}
      </form>

      {config && (
        <div className="config-status">
          <h4>当前配置</h4>
          <dl>
            <dt>提供商</dt>
            <dd>{PROVIDER_INFO[config.provider].name}</dd>
            {config.apiKey && (
              <>
                <dt>API Key</dt>
                <dd>已配置 ✓</dd>
              </>
            )}
            {config.apiEndpoint && (
              <>
                <dt>端点</dt>
                <dd>{config.apiEndpoint}</dd>
              </>
            )}
            {config.model && (
              <>
                <dt>模型</dt>
                <dd>{config.model}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
