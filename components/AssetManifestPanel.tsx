"use client";

import { useCallback, useEffect, useState } from "react";
import type { AssetManifest, AssetItem, ImageGenerationConfig } from "@/lib/product/asset-manifest";

type AssetManifestPanelProps = {
  projectId: string;
};

export function AssetManifestPanel({ projectId }: AssetManifestPanelProps) {
  const [manifest, setManifest] = useState<AssetManifest | null>(null);
  const [items, setItems] = useState<readonly AssetItem[]>([]);
  const [autoGenerateEnabled, setAutoGenerateEnabled] = useState(false);
  const [generationConfig, setGenerationConfig] = useState<ImageGenerationConfig | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [completion, setCompletion] = useState({ total: 0, uploaded: 0, failed: 0, complete: false });

  const loadManifest = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/asset-manifest`);
      if (response.ok) {
        const data = await response.json();
        setManifest(data.manifest);
        setItems(data.items || []);
        setAutoGenerateEnabled(data.manifest?.autoGenerateEnabled || false);
        setCompletion(data.completion || { total: 0, uploaded: 0, failed: 0, complete: false });
      }
    } catch (error) {
      console.error("Failed to load asset manifest:", error);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadGenerationConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/image-generation");
      if (response.ok) {
        const data = await response.json();
        setGenerationConfig(data);
      }
    } catch (error) {
      console.error("Failed to load generation config:", error);
    }
  }, []);

  useEffect(() => {
    loadManifest();
    loadGenerationConfig();
  }, [loadManifest, loadGenerationConfig]);

  const toggleAutoGenerate = async () => {
    if (!manifest) return;

    const newValue = !autoGenerateEnabled;
    try {
      const response = await fetch(`/api/projects/${projectId}/asset-manifest/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newValue }),
      });

      if (response.ok) {
        setAutoGenerateEnabled(newValue);
      }
    } catch (error) {
      console.error("Failed to toggle auto-generate:", error);
    }
  };

  const handleUpload = async (assetKey: string, file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("assetKey", assetKey);

      const response = await fetch(`/api/projects/${projectId}/asset-manifest/upload`, {
        method: "POST",
        body: formData,
      });

      if (response.ok) {
        await loadManifest();
      }
    } catch (error) {
      console.error("Failed to upload asset:", error);
    } finally {
      setUploading(false);
    }
  };

  const triggerRebuild = async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/rebuild-with-assets`, {
        method: "POST",
      });

      if (response.ok) {
        // Notify user that rebuild started
        alert("重新构建已启动");
      }
    } catch (error) {
      console.error("Failed to trigger rebuild:", error);
    }
  };

  if (loading) {
    return <div className="asset-manifest-loading">加载素材清单...</div>;
  }

  if (!manifest) {
    return <div className="asset-manifest-empty">项目尚未生成素材清单</div>;
  }

  const configComplete = generationConfig && generationConfig.provider &&
    (generationConfig.apiKey || generationConfig.apiEndpoint);

  return (
    <div className="asset-manifest-panel">
      <div className="asset-manifest-header">
        <h3>游戏素材</h3>
        <div className="asset-manifest-controls">
          <label className="auto-generate-toggle">
            <input
              type="checkbox"
              checked={autoGenerateEnabled}
              onChange={toggleAutoGenerate}
              disabled={!configComplete}
            />
            <span>自动生成素材</span>
          </label>
          {autoGenerateEnabled && !configComplete && (
            <span className="config-warning">⚠️ 请在设置中配置图片生成模型</span>
          )}
        </div>
      </div>

      <div className="asset-manifest-status">
        <span>总计: {completion.total}</span>
        <span>已完成: {completion.uploaded}</span>
        {completion.failed > 0 && <span className="failed">失败: {completion.failed}</span>}
        {completion.complete && (
          <button className="rebuild-button" onClick={triggerRebuild}>
            ✓ 使用素材重新构建
          </button>
        )}
      </div>

      <div className="asset-items-list">
        {items.map(item => (
          <div key={item.id} className={`asset-item asset-item-${item.status}`}>
            <div className="asset-item-header">
              <span className="asset-key">{item.assetKey}</span>
              <span className="asset-type">{item.assetType}</span>
              <span className="asset-status">{item.status}</span>
            </div>
            <div className="asset-description">{item.description}</div>
            {item.frameCount && (
              <div className="asset-meta">
                动画帧数: {item.frameCount} | 尺寸: {item.dimensions || "自动"}
              </div>
            )}
            {item.generationPrompt && (
              <div className="asset-prompt-box">
                <div className="asset-prompt-label">生成提示词:</div>
                <div className="asset-prompt-content">{item.generationPrompt}</div>
              </div>
            )}
            {item.status === "planned" && !autoGenerateEnabled && (
              <div className="asset-upload">
                <input
                  type="file"
                  accept="image/*"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) handleUpload(item.assetKey, file);
                  }}
                  disabled={uploading}
                />
              </div>
            )}
            {item.errorMessage && (
              <div className="asset-error">{item.errorMessage}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
