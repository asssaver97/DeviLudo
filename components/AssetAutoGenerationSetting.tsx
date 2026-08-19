"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AssetManifest } from "@/lib/product/asset-manifest";
import type { InstanceAgentSettings } from "@/lib/product/contracts";
import { useLanguage } from "./i18n/LanguageProvider";

type AssetAutoGenerationSettingProps = Readonly<{
  projectId: string;
  readOnly?: boolean;
  onChanged?: () => void;
}>;

type AssetManifestSettingPayload = Readonly<{
  manifest: AssetManifest | null;
}>;

export function AssetAutoGenerationSetting({ projectId, readOnly = false, onChanged }: AssetAutoGenerationSettingProps) {
  const { errorText, text } = useLanguage();
  const [manifestAvailable, setManifestAvailable] = useState(false);
  const [autoGenerateEnabled, setAutoGenerateEnabled] = useState(false);
  const [imageGenerationReady, setImageGenerationReady] = useState(false);
  const [agentRuntime, setAgentRuntime] = useState<InstanceAgentSettings["agentRuntime"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch(`/api/projects/${encodeURIComponent(projectId)}/asset-manifest`, { signal: controller.signal }),
      fetch("/api/settings/agent", { signal: controller.signal }),
    ]).then(async ([manifestResponse, settingsResponse]) => {
      if (!manifestResponse.ok) throw new Error(text("素材配置读取失败", "Unable to load asset settings"));
      const manifestPayload = await manifestResponse.json() as AssetManifestSettingPayload;
      const settingsPayload = settingsResponse.ok
        ? await settingsResponse.json() as { settings?: InstanceAgentSettings }
        : {};
      if (controller.signal.aborted) return;
      setManifestAvailable(manifestPayload.manifest !== null);
      setAutoGenerateEnabled(manifestPayload.manifest?.autoGenerateEnabled ?? false);
      setImageGenerationReady(settingsPayload.settings?.imageGenerationReady === true);
      setAgentRuntime(settingsPayload.settings?.agentRuntime ?? null);
    }).catch(reason => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : text("素材配置读取失败", "Unable to load asset settings"));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [projectId, text]);

  const toggleAutoGenerate = async () => {
    if (!manifestAvailable || saving || readOnly) return;
    const enabled = !autoGenerateEnabled;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/asset-manifest/auto-generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) {
        throw new Error(errorText(payload.message, "自动生成配置保存失败", "Unable to save automatic generation settings"));
      }
      setAutoGenerateEnabled(enabled);
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("自动生成配置保存失败", "Unable to save automatic generation settings"));
    } finally {
      setSaving(false);
    }
  };

  const cannotEnable = !autoGenerateEnabled && !imageGenerationReady;
  const disabled = loading || saving || readOnly || !manifestAvailable || cannotEnable;

  return (
    <section aria-label={text("图片素材配置", "Image asset settings")} className="project-delivery-asset-settings">
      <header>
        <span className="eyebrow">IMAGE ASSETS</span>
        <h3>{text("图片素材生成", "IMAGE ASSET GENERATION")}</h3>
      </header>
      <div className="project-delivery-asset-setting-row">
        <label className={`project-delivery-asset-toggle${disabled ? " is-disabled" : ""}`}>
          <input
            checked={autoGenerateEnabled}
            disabled={disabled}
            onChange={() => void toggleAutoGenerate()}
            type="checkbox"
          />
          <span aria-hidden="true" className="project-delivery-asset-switch"><span /></span>
          <span className="project-delivery-asset-toggle-copy">
            <b>{text("自动生成图片素材", "GENERATE IMAGE ASSETS AUTOMATICALLY")}</b>
            <small>{text(
              "Agent 完成素材规划后，由当前运行时的图片后端自动生成并作为构建门禁。",
              "After the Agent plans the assets, the selected runtime generates them before the build can continue.",
            )}</small>
          </span>
        </label>
        <span className={`project-delivery-asset-setting-status ${autoGenerateEnabled ? "is-enabled" : ""}`}>
          {loading
            ? text("读取中", "LOADING")
            : autoGenerateEnabled
              ? text("已开启", "ENABLED")
              : text("已关闭", "DISABLED")}
        </span>
      </div>
      {!loading && !manifestAvailable ? (
        <p className="project-delivery-asset-setting-note">{text(
          "Agent 生成素材清单后即可配置自动生成；现在仍可继续开发。",
          "Automatic generation becomes configurable after the Agent creates an asset manifest.",
        )}</p>
      ) : null}
      {!loading && manifestAvailable && cannotEnable ? (
        <p className="project-delivery-asset-setting-note is-warning">
          {agentRuntime === "CODEX_CLI" ? text(
            "请先在设置中保存已完成官方登录的 Codex CLI 连接，图片将由内置 ImageGen 生成。",
            "Save a Codex CLI connection with an active official sign-in first. Images will be generated by built-in ImageGen.",
          ) : <>{text("请先在", "Configure an explicit image model in ")}<Link href="/settings">{text("设置", "Settings")}</Link>{text("的 Agent 连接中配置图片模型。", " under the selected Agent connection first.")}</>}
        </p>
      ) : null}
      {readOnly ? <p className="project-delivery-asset-setting-note">{text("历史轮次中的项目配置只读。", "Project settings are read-only for historical iterations.")}</p> : null}
      {error ? <p className="project-delivery-asset-setting-error" role="alert">{error}</p> : null}
    </section>
  );
}
