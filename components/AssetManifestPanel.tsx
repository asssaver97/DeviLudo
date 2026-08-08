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

  // Generation settles in the background with nothing to push the result here, so
  // the panel polls while work is outstanding and stops once it is not.
  const generationOutstanding = autoGenerateEnabled
    && items.some(item => item.status === "planned" || item.status === "generating");
  useEffect(() => {
    if (!generationOutstanding) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (document.visibilityState === "visible") await loadManifest().catch(() => undefined);
      if (!stopped) timer = setTimeout(poll, 5_000);
    };
    timer = setTimeout(poll, 5_000);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [generationOutstanding, loadManifest]);

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
        // Turning it on makes planned assets claimable, so reload to start the
        // poll above rather than waiting for the next manual refresh.
        if (newValue) await loadManifest();
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

  const generatingCount = items.filter(item => item.status === "generating").length;

  // A credential is what generation actually needs; an endpoint alone cannot
  // authenticate a request. Treating endpoint-only as configured let the toggle be
  // switched on for a setup that could never generate anything.
  const configComplete = Boolean(generationConfig?.provider && generationConfig.apiKeyMask);
  // Midjourney has no synchronous HTTP generation API, so the generator rejects
  // it per asset. Saying so here is better than letting every asset fail.
  const providerSupported = generationConfig?.provider !== "midjourney";

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
              disabled={!configComplete || !providerSupported}
            />
            <span>自动生成素材</span>
          </label>
          {/* The toggle used to be disabled with no explanation, which read as a
              bug. Whenever it cannot be used, say which condition is missing. */}
          {!configComplete ? (
            <span className="config-warning">
              ⚠️ 需要先在<a href="/settings">设置</a>里配置图片生成模型和 API Key
            </span>
          ) : !providerSupported ? (
            <span className="config-warning">
              ⚠️ Midjourney 没有可用的同步生成接口，请在设置里改用 DALL-E 3、Stable Diffusion XL 或 Replicate
            </span>
          ) : null}
        </div>
      </div>

      <div className="asset-manifest-status">
        <span>总计: {completion.total}</span>
        <span>已完成: {completion.uploaded}</span>
        {generatingCount > 0 && <span className="generating">正在生成: {generatingCount}</span>}
        {completion.failed > 0 && <span className="failed">失败: {completion.failed}</span>}
        {completion.complete && (
          <button className="rebuild-button" disabled={rebuilding} onClick={() => void triggerRebuild()} type="button">
            {rebuilding ? "正在启动重新构建..." : "✓ 使用素材重新构建"}
          </button>
        )}
      </div>
      {/* A failed asset is not a dead end: its prompt can be re-planned by a rerun,
          or the art can be uploaded directly. Say so rather than leaving a red
          count with no next step. */}
      {completion.failed > 0 && (
        <p className="asset-manifest-note">
          有 {completion.failed} 个素材自动生成失败（已达重试上限）。可以直接在下方上传自备素材，或重跑 Agent 生成以重新规划提示词。
        </p>
      )}

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
            {/* Upload stays available whatever the toggle says. Auto-generate is a
                convenience, not a commitment: hiding this while generation was on
                left an asset with no way forward if the provider kept rejecting
                its prompt, and a user who has the art on disk should never have to
                turn a setting off to use it. Only an asset already being generated
                hides it, because that write would race the generator. */}
            {item.status !== "generating" && (
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
                {item.status === "planned" && autoGenerateEnabled ? (
                  <small className="asset-upload-hint">排队自动生成中，也可以直接上传自备素材</small>
                ) : null}
                {item.status === "generated" || item.status === "uploaded" ? (
                  <small className="asset-upload-hint">已有素材，上传新文件会替换它</small>
                ) : null}
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
