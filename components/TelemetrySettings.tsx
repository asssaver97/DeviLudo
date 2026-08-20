"use client";

import { useEffect, useState } from "react";
import type { TelemetryStatus } from "@/lib/product/contracts";
import { useLanguage } from "./i18n/LanguageProvider";

export function TelemetryStatusPanel() {
  const { errorText, locale, text } = useLanguage();
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/telemetry", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const payload = await response.json() as { status?: TelemetryStatus; message?: string };
        if (!response.ok || !payload.status) throw new Error(errorText(payload.message, "上报状态不可用", "Reporting status unavailable"));
        if (!controller.signal.aborted) setStatus(payload.status);
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [errorText]);

  return (
    <section className="settings-card settings-section telemetry-settings">
      <div className="settings-card-title"><div><h2>{text("匿名使用统计", "ANONYMOUS USAGE STATISTICS")}</h2></div><span>AUTOMATIC</span></div>
      <p className="settings-description">{text(
        "自动向官方接收端上报随机安装标识、活跃日期、版本、系统和架构；不发送项目、源码、提示词、模型或凭证。",
        "Automatically reports a random installation ID, active day, version, OS, and architecture to the official collector—never projects, source, prompts, models, or credentials.",
      )}</p>
      <div className="telemetry-status">
        <b>{status?.endpointConfigured ? text("自动上报运行中", "AUTOMATIC REPORTING ACTIVE") : text("上报接收端不可用", "REPORTING ENDPOINT UNAVAILABLE")}</b>
        <small>{status?.endpointConfigured
          ? text(`安装标识 · ${status.installationIdMask}`, `Installation ID · ${status.installationIdMask}`)
          : text("当前不会发送请求", "No request is currently sent")}</small>
      </div>
      <p className="telemetry-last-report">{status?.lastReportedAt
        ? text(`最近上报：${new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(status.lastReportedAt))}`, `Last report: ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(status.lastReportedAt))}`)
        : text("尚未上报", "Nothing reported yet")}</p>
      {error ? <div className="inline-notice danger">{error}</div> : null}
    </section>
  );
}
