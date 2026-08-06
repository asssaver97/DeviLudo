"use client";

import { ServerPoolDashboard } from "@/components/ServerPoolDashboard";
import { useLanguage } from "@/components/i18n/LanguageProvider";

export default function ServerPoolsPage() {
  const { text } = useLanguage();
  return (
      <section className="adminPage">
        <header className="page-heading">
          <div>
            <span className="eyebrow">{text("PLATFORM CAPACITY · 后台诊断", "PLATFORM CAPACITY · OPERATIONS")}</span>
            <h1>{text("固定服务器池", "FIXED SERVER POOLS")}</h1>
            <p>{text("此页面只用于运维诊断，不是 DeviLudo 产品入口。系统只接受五种池类型。", "Operational diagnostics only. The system accepts exactly five server-pool kinds.")}</p>
          </div>
        </header>
        <ServerPoolDashboard />
      </section>
  );
}
