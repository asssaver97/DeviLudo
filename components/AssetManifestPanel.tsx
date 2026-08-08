"use client";

import { useCallback, useEffect, useState } from "react";
import type { AssetManifest, AssetItem, ImageGenerationConfig } from "@/lib/product/asset-manifest";

type AssetManifestPanelProps = {
  projectId: string;
  /** Lets the studio refresh the delivery view once a rerun has been accepted. */
  onRerunStarted?: () => void;
};

type AssetCompletion = Readonly<{
  total: number;
  uploaded: number;
  failed: number;
  complete: boolean;
}>;

/** Core answers with nulls for a project whose assets have not been planned yet. */
type AssetManifestPayload = Readonly<{
  manifest: AssetManifest | null;
  items: readonly AssetItem[] | null;
  completion: AssetCompletion | null;
}>;

const EMPTY_COMPLETION: AssetCompletion = Object.freeze({
  total: 0, uploaded: 0, failed: 0, complete: false,
});

export function AssetManifestPanel({ projectId, onRerunStarted }: AssetManifestPanelProps) {
  const [manifest, setManifest] = useState<AssetManifest | null>(null);
  const [items, setItems] = useState<readonly AssetItem[]>([]);
  const [autoGenerateEnabled, setAutoGenerateEnabled] = useState(false);
  const [generationConfig, setGenerationConfig] = useState<ImageGenerationConfig | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [completion, setCompletion] = useState<AssetCompletion>(EMPTY_COMPLETION);

  const applyManifest = useCallback((data: AssetManifestPayload) => {
    setManifest(data.manifest);
    setItems(data.items ?? []);
    setAutoGenerateEnabled(data.manifest?.autoGenerateEnabled ?? false);
    setCompletion(data.completion ?? EMPTY_COMPLETION);
  }, []);

  const loadManifest = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/asset-manifest`);
      if (response.ok) applyManifest(await response.json() as AssetManifestPayload);
    } catch (error) {
      console.error("Failed to load asset manifest:", error);
    } finally {
      setLoading(false);
    }
  }, [applyManifest, projectId]);

  // Fetching is kept separate from applying so the effect below can set state in
  // a promise callback rather than synchronously in the effect body.
  const fetchManifest = useCallback(async (signal: AbortSignal): Promise<AssetManifestPayload | null> => {
    const response = await fetch(`/api/projects/${projectId}/asset-manifest`, { signal });
    return response.ok ? await response.json() as AssetManifestPayload : null;
  }, [projectId]);

  const fetchGenerationConfig = useCallback(async (signal: AbortSignal): Promise<ImageGenerationConfig | null> => {
    const response = await fetch("/api/settings/image-generation", { signal });
    return response.ok ? await response.json() as ImageGenerationConfig | null : null;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchManifest(controller.signal)
      .then(data => {
        if (controller.signal.aborted || !data) return;
        applyManifest(data);
      })
      .catch(() => undefined)
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    void fetchGenerationConfig(controller.signal)
      .then(config => { if (!controller.signal.aborted) setGenerationConfig(config); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [applyManifest, fetchGenerationConfig, fetchManifest]);

  const toggleAutoGenerate = async () => {
    if (!manifest) return;

    const newValue = !autoGenerateEnabled;
    try {
      const response = await fetch(`/api/projects/${projectId}/asset-manifest/auto-generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    setUploadError(null);
    setUploading(true);
    try {
      // Core takes the bytes base64-encoded in JSON so the upload travels the
      // same authenticated proxy path as every other project mutation.
      const content = await fileToBase64(file);
      const response = await fetch(`/api/projects/${projectId}/asset-manifest/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetKey, contentType: file.type, content }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setUploadError(payload?.message ?? "素材上传失败，请确认格式为 PNG/JPEG/WebP");
        return;
      }
      await loadManifest();
    } catch {
      setUploadError("素材上传失败，请稍后再试");
    } finally {
      setUploading(false);
    }
  };

  // Uploaded assets only reach the game through a build, so "rebuild with
  // assets" is an ARTIFACT_BUILD rerun: it keeps the Agent's generated source
  // and re-runs packaging plus every stage after it.
  const triggerRebuild = async () => {
    setRebuildError(null);
    setRebuilding(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/rerun-stage`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `stage-rerun:ARTIFACT_BUILD:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ stage: "ARTIFACT_BUILD" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setRebuildError(payload?.message ?? "重新构建启动失败，请稍后再试");
        return;
      }
      onRerunStarted?.();
    } catch {
      setRebuildError("重新构建启动失败，请稍后再试");
    } finally {
      setRebuilding(false);
    }
  };

  if (loading) {
    return <div className="asset-manifest-loading">加载素材清单...</div>;
  }

  if (!manifest) {
    return <div className="asset-manifest-empty">项目尚未生成素材清单</div>;
  }

  const configComplete = generationConfig && generationConfig.provider &&
    (generationConfig.apiKeyMask || generationConfig.apiEndpoint);

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
          <button className="rebuild-button" disabled={rebuilding} onClick={() => void triggerRebuild()} type="button">
            {rebuilding ? "正在启动重新构建..." : "✓ 使用素材重新构建"}
          </button>
        )}
      </div>

      {rebuildError && <p className="asset-manifest-error" role="alert">{rebuildError}</p>}
      {uploadError && <p className="asset-manifest-error" role="alert">{uploadError}</p>}

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
                  accept="image/png,image/jpeg,image/webp"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) void handleUpload(item.assetKey, file);
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

/** Base64-encode in chunks so a multi-megabyte asset cannot blow the call stack. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
