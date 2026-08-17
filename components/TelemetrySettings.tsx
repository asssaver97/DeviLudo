"use client";

import { useEffect, useState } from "react";
import type { TelemetrySettings } from "@/lib/product/contracts";
import { useLanguage } from "./i18n/LanguageProvider";

export function TelemetrySettingsPanel() {
  const { errorText, locale, text } = useLanguage();
  const [settings, setSettings] = useState<TelemetrySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/telemetry", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const payload = await response.json() as { settings?: TelemetrySettings; message?: string };
        if (!response.ok || !payload.settings) throw new Error(errorText(payload.message, "遥测设置不可用", "Telemetry settings unavailable"));
        if (!controller.signal.aborted) setSettings(payload.settings);
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [errorText]);

  async function setEnabled(enabled: boolean) {
    if (!settings || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/settings/telemetry", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const payload = await response.json() as { settings?: TelemetrySettings; message?: string };
      if (!response.ok || !payload.settings) throw new Error(errorText(payload.message, "遥测设置保存失败", "Unable to save telemetry settings"));
      setSettings(payload.settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("遥测设置保存失败", "Unable to save telemetry settings"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card settings-section telemetry-settings">
      <div className="settings-card-title"><div><h2>{text("匿名使用统计", "ANONYMOUS USAGE STATISTICS")}</h2></div><span>OPT IN</span></div>
      <p className="settings-description">{text(
        "可选上报随机安装标识、活跃日期、版本、系统和架构；不发送项目、源码、提示词、模型或凭证。",
        "Optionally reports a random installation ID, active day, version, OS, and architecture—never projects, source, prompts, models, or credentials.",
      )}</p>
      <label className="telemetry-toggle">
        <input checked={settings?.enabled ?? false} disabled={!settings || busy} onChange={event => void setEnabled(event.target.checked)} type="checkbox" />
        <span><b>{text("允许匿名使用统计", "ALLOW ANONYMOUS USAGE STATISTICS")}</b><small>{settings?.endpointConfigured
          ? text(`接收端已配置 · ${settings.installationIdMask}`, `Collector configured · ${settings.installationIdMask}`)
          : text("未配置接收端，数据不会离开本机", "No collector configured; data stays on this machine")}</small></span>
      </label>
      <p className="telemetry-last-report">{settings?.lastReportedAt
        ? text(`最近上报：${new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(settings.lastReportedAt))}`, `Last report: ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(settings.lastReportedAt))}`)
        : text("尚未上报", "Nothing reported yet")}</p>
      {error ? <div className="inline-notice danger">{error}</div> : null}
    </section>
  );
}
