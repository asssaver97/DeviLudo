"use client";

import { ServerPoolDashboard } from "@/components/ServerPoolDashboard";
import { useLanguage } from "@/components/i18n/LanguageProvider";

export default function ServerPoolsPage() {
  const { text } = useLanguage();
  return (
      <section className="adminPage">
        <header className="page-heading">
          <div>
            <h1>{text("固定服务器池", "FIXED SERVER POOLS")}</h1>
          </div>
        </header>
        <ServerPoolDashboard />
      </section>
  );
}
