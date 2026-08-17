"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetManifest, AssetItem } from "@/lib/product/asset-manifest";
import type { InstanceAgentSettings } from "@/lib/product/contracts";
import { useLanguage } from "./i18n/LanguageProvider";

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
  const { errorText, text } = useLanguage();
  const [manifest, setManifest] = useState<AssetManifest | null>(null);
  const [items, setItems] = useState<readonly AssetItem[]>([]);
  const [autoGenerateEnabled, setAutoGenerateEnabled] = useState(false);
  const [imageGenerationReady, setImageGenerationReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [completion, setCompletion] = useState<AssetCompletion>(EMPTY_COMPLETION);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadAssetKeyRef = useRef<string | null>(null);

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

  const fetchAgentSettings = useCallback(async (signal: AbortSignal): Promise<InstanceAgentSettings | null> => {
    const response = await fetch("/api/settings/agent", { signal });
    if (!response.ok) return null;
    const payload = await response.json() as { settings?: InstanceAgentSettings };
    return payload.settings ?? null;
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
    void fetchAgentSettings(controller.signal)
      .then(settings => { if (!controller.signal.aborted) setImageGenerationReady(settings?.imageGenerationReady === true); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [applyManifest, fetchAgentSettings, fetchManifest]);

  // Generation settles in the background and gates artifact construction, so the
  // panel polls while work is outstanding and stops once it is not.
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
        setUploadError(errorText(payload?.message, "素材上传失败，请确认格式为 PNG/JPEG/WebP", "Asset upload failed. Use a PNG, JPEG, or WebP image."));
        return;
      }
      await loadManifest();
    } catch {
      setUploadError(text("素材上传失败，请稍后再试", "Asset upload failed. Try again shortly."));
    } finally {
      setUploading(false);
    }
  };

  const openUploadPicker = (assetKey: string) => {
    // Keep a single native picker outside the repeated list. Besides reducing the
    // expanded panel's DOM weight, calling click() synchronously preserves the
    // browser's user activation and opens the chooser without waiting for state.
    uploadAssetKeyRef.current = assetKey;
    if (uploadInputRef.current) {
      uploadInputRef.current.value = "";
      uploadInputRef.current.click();
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
        setRebuildError(errorText(payload?.message, "重新构建启动失败，请稍后再试", "Unable to start the rebuild. Try again shortly."));
        return;
      }
      onRerunStarted?.();
    } catch {
      setRebuildError(text("重新构建启动失败，请稍后再试", "Unable to start the rebuild. Try again shortly."));
    } finally {
      setRebuilding(false);
    }
  };

  if (loading) {
    return <div className="asset-manifest-loading">{text("加载素材清单…", "Loading asset manifest…")}</div>;
  }

  if (!manifest) {
    return <div className="asset-manifest-empty">{text("项目尚未生成素材清单", "No asset manifest has been generated for this project")}</div>;
  }

  const generatingCount = items.filter(item => item.status === "generating").length;

  // Readiness comes from the selected Agent connection and its optional image
  // model; the asset panel never owns a second Provider or credential.
  return (
    <div className="asset-manifest-panel">
      <div className="asset-manifest-header">
        <h3>{text("游戏素材", "GAME ASSETS")}</h3>
        <div className="asset-manifest-controls">
          <label className="auto-generate-toggle">
            <input
              type="checkbox"
              checked={autoGenerateEnabled}
              onChange={toggleAutoGenerate}
              disabled={!autoGenerateEnabled && !imageGenerationReady}
            />
            <span>{text("自动生成素材", "Generate assets automatically")}</span>
          </label>
          {/* The toggle used to be disabled with no explanation, which read as a
              bug. Whenever it cannot be used, say which condition is missing. */}
          {!imageGenerationReady && !autoGenerateEnabled ? (
            <span className="config-warning">
              {text("⚠️ 需要先在", "⚠️ Configure an image model in ")}<a href="/settings">{text("设置", "Settings")}</a>{text("的 Agent 连接中选择一个图片模型", " under the selected Agent connection first")}
            </span>
          ) : null}
        </div>
      </div>

      <div className="asset-manifest-status">
        <span>{text("总计", "Total")}: {completion.total}</span>
        <span>{text("已完成", "Complete")}: {completion.uploaded}</span>
        {generatingCount > 0 && <span className="generating">{text("正在生成", "Generating")}: {generatingCount}</span>}
        {completion.failed > 0 && <span className="failed">{text("失败", "Failed")}: {completion.failed}</span>}
        {completion.complete && (
          <button className="rebuild-button" disabled={rebuilding} onClick={() => void triggerRebuild()} type="button">
            {rebuilding ? text("正在启动重新构建…", "Starting rebuild…") : text("✓ 使用素材重新构建", "✓ Rebuild with assets")}
          </button>
        )}
      </div>
      {/* A failed asset is not a dead end: its prompt can be re-planned by a rerun,
          or the art can be uploaded directly. Say so rather than leaving a red
          count with no next step. */}
      {completion.failed > 0 && (
        <p className="asset-manifest-note">
          {text(
            `有 ${completion.failed} 个素材自动生成失败（已达重试上限）。可以直接在下方上传自备素材，或重跑 Agent 生成以重新规划提示词。`,
            `${completion.failed} asset${completion.failed === 1 ? "" : "s"} failed automatic generation after all retries. Upload replacement art below or re-run Agent Generation to create a new plan.`,
          )}
        </p>
      )}

      {rebuildError && <p className="asset-manifest-error" role="alert">{rebuildError}</p>}
      {uploadError && <p className="asset-manifest-error" role="alert">{uploadError}</p>}

      <input
        ref={uploadInputRef}
        aria-hidden="true"
        className="asset-upload-picker"
        tabIndex={-1}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={event => {
          const file = event.target.files?.[0];
          const assetKey = uploadAssetKeyRef.current;
          if (file && assetKey) void handleUpload(assetKey, file);
        }}
      />
      <div aria-label={text("图片素材列表", "Image asset list")} className="asset-items-list" role="region" tabIndex={0}>
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
                {text("动画帧数", "Animation frames")}: {item.frameCount} | {text("尺寸", "Size")}: {item.dimensions || text("自动", "Auto")}
              </div>
            )}
            {item.generationPrompt && (
              <div className="asset-prompt-box">
                <div className="asset-prompt-label">{text("生成提示词", "Generation prompt")}:</div>
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
                <button
                  className="asset-upload-button"
                  disabled={uploading}
                  onClick={() => openUploadPicker(item.assetKey)}
                  type="button"
                >{item.status === "generated" || item.status === "uploaded" ? text("替换文件", "Replace file") : text("上传文件", "Upload file")}</button>
                {item.status === "planned" && autoGenerateEnabled ? (
                  <small className="asset-upload-hint">{text("排队自动生成中，也可以直接上传自备素材", "Queued for automatic generation; you can also upload your own asset")}</small>
                ) : null}
                {item.status === "generated" || item.status === "uploaded" ? (
                  <small className="asset-upload-hint">{text("已有素材，上传新文件会替换它", "An asset already exists; uploading a new file will replace it")}</small>
                ) : null}
              </div>
            )}
            {item.errorMessage && (
              <div className="asset-error">{errorText(item.errorMessage, "素材生成失败", "Asset generation failed")}</div>
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
