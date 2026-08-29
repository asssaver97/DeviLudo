"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { isMusicAsset, type AssetManifest, type AssetItem } from "@/lib/product/asset-manifest";
import { useLanguage } from "./i18n/LanguageProvider";

type AssetManifestPanelProps = {
  projectId: string;
  refreshKey?: number;
  onManifestChange?: (payload: AssetManifestPayload) => void;
  onOpenSourceImage?: (sourcePath: string) => Promise<void>;
  mediaKind?: "image" | "music";
};

type AssetListFilter = "all" | "complete" | "generating" | "failed";

export type AssetCompletion = Readonly<{
  total: number;
  uploaded: number;
  failed: number;
  complete: boolean;
}>;

/** Core answers with nulls for a project whose assets have not been planned yet. */
export type AssetManifestPayload = Readonly<{
  manifest: AssetManifest | null;
  items: readonly AssetItem[] | null;
  completion: AssetCompletion | null;
}>;

const EMPTY_COMPLETION: AssetCompletion = Object.freeze({
  total: 0, uploaded: 0, failed: 0, complete: false,
});

function completionOf(items: readonly AssetItem[]): AssetCompletion {
  const uploaded = items.filter(item => ["existing", "generated", "uploaded"].includes(item.status)).length;
  return Object.freeze({
    total: items.length,
    uploaded,
    failed: items.filter(item => item.status === "failed").length,
    complete: items.length > 0 && uploaded === items.length,
  });
}

export function AssetManifestPanel({
  projectId,
  refreshKey = 0,
  onManifestChange,
  onOpenSourceImage,
  mediaKind = "image",
}: AssetManifestPanelProps) {
  const { errorText, text } = useLanguage();
  const [manifest, setManifest] = useState<AssetManifest | null>(null);
  const [items, setItems] = useState<readonly AssetItem[]>([]);
  const [autoGenerateEnabled, setAutoGenerateEnabled] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sourceOpenError, setSourceOpenError] = useState<string | null>(null);
  const [openingSourcePath, setOpeningSourcePath] = useState<string | null>(null);
  const [assetFilter, setAssetFilter] = useState<AssetListFilter>("all");
  const [completion, setCompletion] = useState<AssetCompletion>(EMPTY_COMPLETION);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadAssetKeyRef = useRef<string | null>(null);
  const music = mediaKind === "music";

  const applyManifest = useCallback((data: AssetManifestPayload) => {
    const selectedItems = (data.items ?? []).filter(item => isMusicAsset(item) === music);
    setManifest(data.manifest);
    setItems(selectedItems);
    setAutoGenerateEnabled(data.manifest?.autoGenerateEnabled ?? false);
    setCompletion(completionOf(selectedItems));
    onManifestChange?.(data);
  }, [music, onManifestChange]);

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

  useEffect(() => {
    const controller = new AbortController();
    void fetchManifest(controller.signal)
      .then(data => {
        if (controller.signal.aborted || !data) return;
        applyManifest(data);
      })
      .catch(() => undefined)
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [applyManifest, fetchManifest, refreshKey]);

  // Generation settles in the background and gates artifact construction, so the
  // panel polls while work is outstanding and stops once it is not.
  const generationOutstanding = autoGenerateEnabled
    && !music
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
        body: JSON.stringify({ assetKey, contentType: file.type || contentTypeFromFilename(file.name), content }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setUploadError(errorText(
          payload?.message,
          music ? "音乐上传失败，请确认格式为 MP3/Ogg/WAV" : "素材上传失败，请确认格式为 PNG/JPEG/WebP",
          music ? "Music upload failed. Use an MP3, Ogg, or WAV file." : "Asset upload failed. Use a PNG, JPEG, or WebP image.",
        ));
        return;
      }
      await loadManifest();
    } catch {
      setUploadError(text(music ? "音乐上传失败，请稍后再试" : "素材上传失败，请稍后再试", music ? "Music upload failed. Try again shortly." : "Asset upload failed. Try again shortly."));
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

  const openSourceImage = async (sourcePath: string) => {
    setSourceOpenError(null);
    setOpeningSourcePath(sourcePath);
    try {
      if (onOpenSourceImage) await onOpenSourceImage(sourcePath);
      else window.open(sourceImageUrl(projectId, sourcePath), "_blank", "noopener,noreferrer");
    } catch (reason) {
      setSourceOpenError(reason instanceof Error
        ? reason.message
        : text("源码图片打开失败", "Unable to open the source image"));
    } finally {
      setOpeningSourcePath(null);
    }
  };

  if (loading) {
    return <div className="asset-manifest-loading">{text("加载素材清单…", "Loading asset manifest…")}</div>;
  }

  if (!manifest) {
    return <div className="asset-manifest-empty">{text(music ? "项目尚未规划音乐素材" : "项目尚未生成美术素材清单", music ? "No music assets have been planned for this project" : "No art manifest has been generated for this project")}</div>;
  }

  const generatingCount = items.filter(item => item.status === "generating").length;
  const filteredItems = items.filter(item => {
    if (assetFilter === "complete") return ["existing", "generated", "uploaded"].includes(item.status);
    if (assetFilter === "generating") return item.status === "generating";
    if (assetFilter === "failed") return item.status === "failed";
    return true;
  });

  // Generation policy lives with the rest of the project delivery settings.
  // Applying supplied assets is intentionally owned by the Build node's rerun
  // control, so the list has no second, state-divergent rebuild entry point.
  return (
    <div className="asset-manifest-panel">
      <div className="asset-manifest-header">
        <h3>{text(music ? "音乐素材" : "美术素材", music ? "MUSIC ASSETS" : "ART ASSETS")}</h3>
      </div>

      {music ? <p className="asset-manifest-note asset-manifest-upload-only">{text("音乐暂不支持 AI 生成。请根据每项用途说明，逐项上传 MP3、Ogg Vorbis 或 WAV 文件；上传内容会在下次制品构建时进入游戏。", "AI music generation is not available yet. Upload an MP3, Ogg Vorbis, or WAV file for each described cue; uploaded files enter the next artifact build.")}</p> : null}

      <div aria-label={text("按素材状态筛选", "Filter assets by status")} className="asset-manifest-status" role="group">
        <button aria-controls={`asset-${mediaKind}-list`} aria-pressed={assetFilter === "all"} className={`asset-manifest-filter ${assetFilter === "all" ? "is-active" : ""}`} onClick={() => setAssetFilter("all")} type="button">
          {text("全部", "All")}: {completion.total}
        </button>
        <button aria-controls={`asset-${mediaKind}-list`} aria-pressed={assetFilter === "complete"} className={`asset-manifest-filter complete ${assetFilter === "complete" ? "is-active" : ""}`} onClick={() => setAssetFilter("complete")} type="button">
          {text(music ? "已上传" : "完成", music ? "Uploaded" : "Complete")}: {completion.uploaded}
        </button>
        {!music ? <button aria-controls="asset-image-list" aria-pressed={assetFilter === "generating"} className={`asset-manifest-filter generating ${assetFilter === "generating" ? "is-active" : ""}`} onClick={() => setAssetFilter("generating")} type="button">
          {text("生成中", "Generating")}: {generatingCount}
        </button> : null}
        {!music && completion.failed > 0 && <button aria-controls="asset-image-list" aria-pressed={assetFilter === "failed"} className={`asset-manifest-filter failed ${assetFilter === "failed" ? "is-active" : ""}`} onClick={() => setAssetFilter("failed")} type="button">{text("失败", "Failed")}: {completion.failed}</button>}
      </div>
      {/* A failed asset is not a dead end: the Art branch can requeue only
          unresolved entries, while upload remains available here. */}
      {completion.failed > 0 && (
        <p className="asset-manifest-note">
          {text(
            `有 ${completion.failed} 个素材自动生成失败（已达重试上限）。可以直接上传自备素材，或点击上方美术节点的重跑按钮，只补齐缺失素材。`,
            `${completion.failed} asset${completion.failed === 1 ? "" : "s"} failed automatic generation. Upload replacement art or use the Art node's rerun control to retry only missing assets.`,
          )}
        </p>
      )}

      {uploadError && <p className="asset-manifest-error" role="alert">{uploadError}</p>}
      {sourceOpenError && <p className="asset-manifest-error" role="alert">{sourceOpenError}</p>}

      <input
        ref={uploadInputRef}
        aria-hidden="true"
        className="asset-upload-picker"
        tabIndex={-1}
        type="file"
        accept={music ? "audio/mpeg,audio/ogg,audio/wav,audio/x-wav,.mp3,.ogg,.wav" : "image/png,image/jpeg,image/webp"}
        onChange={event => {
          const file = event.target.files?.[0];
          const assetKey = uploadAssetKeyRef.current;
          if (file && assetKey) void handleUpload(assetKey, file);
        }}
      />
      <div aria-label={text(music ? "音乐素材列表" : "图片素材列表", music ? "Music asset list" : "Image asset list")} className="asset-items-list" id={`asset-${mediaKind}-list`} role="region" tabIndex={0}>
        {filteredItems.length === 0 ? <p className="asset-items-empty">{text(music ? "尚未规划音乐素材，或当前筛选下没有内容" : "该状态下没有图片素材", music ? "No music assets have been planned or match this filter" : "No image assets match this status")}</p> : null}
        {filteredItems.map(item => (
          <div key={item.id} className={`asset-item asset-item-${item.status}`}>
            <div className="asset-item-header">
              <span className="asset-key">{item.assetKey}</span>
              <span className="asset-type">{item.assetType}</span>
              <span className="asset-status">{item.status}</span>
            </div>
            <div className="asset-description">{item.description}</div>
            {!music && item.sourcePath ? (
              <button
                aria-label={text(`打开源码图片 ${item.sourcePath}`, `Open source image ${item.sourcePath}`)}
                className="asset-source-preview"
                disabled={openingSourcePath !== null}
                onClick={() => void openSourceImage(item.sourcePath!)}
                type="button"
              >
                <SourceAssetThumbnail projectId={projectId} sourcePath={item.sourcePath} />
                <span><b>{text("打开原文件", "OPEN ORIGINAL")}</b><small>{item.sourcePath}</small></span>
                <strong>{openingSourcePath === item.sourcePath ? text("打开中…", "OPENING…") : text("打开", "OPEN")}</strong>
              </button>
            ) : null}
            {!music && item.frameCount && (
              <div className="asset-meta">
                {text("动画帧数", "Animation frames")}: {item.frameCount} | {text("尺寸", "Size")}: {item.dimensions || text("自动", "Auto")}
              </div>
            )}
            {!music && item.generationPrompt && item.status !== "existing" && (
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
            {item.status !== "generating" && item.status !== "existing" && (
              <div className="asset-upload">
                <button
                  className="asset-upload-button"
                  disabled={uploading}
                  onClick={() => openUploadPicker(item.assetKey)}
                  type="button"
                >{item.status === "generated" || item.status === "uploaded" ? text("替换文件", "Replace file") : text("上传文件", "Upload file")}</button>
                {item.status === "planned" && autoGenerateEnabled ? (
                  <small className="asset-upload-hint">{music
                    ? text("仅支持用户上传，不会进入 AI 生成队列", "Upload only; this item never enters the AI generation queue")
                    : text("排队自动生成中，也可以直接上传自备素材", "Queued for automatic generation; you can also upload your own asset")}</small>
                ) : item.status === "planned" && music ? (
                  <small className="asset-upload-hint">{text("仅支持用户上传，不会进入 AI 生成队列", "Upload only; this item never enters the AI generation queue")}</small>
                ) : null}
                {item.status === "generated" || item.status === "uploaded" ? (
                  <small className="asset-upload-hint">{text("已有素材，上传新文件会替换它", "An asset already exists; uploading a new file will replace it")}</small>
                ) : null}
              </div>
            )}
            {item.status === "existing" ? (
              <small className="asset-upload-hint">{text("已从当前源码中检测到，无需重复生成", "Detected in the current source; no generation is needed")}</small>
            ) : null}
            {item.errorMessage && (
              <div className="asset-error">{errorText(item.errorMessage, "素材生成失败", "Asset generation failed")}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SourceAssetThumbnail({ projectId, sourcePath }: { projectId: string; sourcePath: string }) {
  const [failed, setFailed] = useState(false);
  const label = sourcePath.split(".").at(-1)?.toUpperCase() ?? "IMG";
  return (
    <span className="asset-source-thumbnail" aria-hidden="true">
      {failed ? <span>{label}</span> : (
        <Image
          alt=""
          height={72}
          loading="lazy"
          onError={() => setFailed(true)}
          src={sourceImageUrl(projectId, sourcePath)}
          unoptimized
          width={72}
        />
      )}
    </span>
  );
}

function sourceImageUrl(projectId: string, sourcePath: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/source-image?path=${encodeURIComponent(sourcePath)}`;
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

function contentTypeFromFilename(filename: string): string {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "ogg") return "audio/ogg";
  if (extension === "wav") return "audio/wav";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return "application/octet-stream";
}
