"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProductSession } from "@/lib/product/contracts";
import { ShieldIcon } from "./console/Icons";
import { useLanguage } from "./i18n/LanguageProvider";

export function AccessSettings() {
  const { text } = useLanguage();
  const [session, setSession] = useState<ProductSession | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/session", { cache: "no-store", signal: controller.signal })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("SESSION_UNAVAILABLE")))
      .then((body: { session: ProductSession }) => { if (!controller.signal.aborted) setSession(body.session); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return (
    <section className="access-settings panel-card">
      <header className="section-heading"><span className="step-badge">02</span><div><h2>{text("访问模式", "ACCESS MODE")}</h2></div><ShieldIcon /></header>
      {session?.authMode === "STANDALONE" ? (
        <div className="access-user-row">
          <div><small>STANDALONE</small><b>{text("本地匿名访问", "LOCAL ANONYMOUS ACCESS")}</b><p>{text("任何能访问此站点的人都可以执行产品和实例管理操作。账号、组织和 GitHub 功能未在 Core 中启用。", "Anyone who can reach this site can use product and instance administration. Accounts, organizations, and GitHub are not enabled in Core.")}</p></div>
        </div>
      ) : (
        <div className="access-user-row">
          <div><small>PLATFORM</small><b>{session?.user.username ?? text("由 Platform 管理", "Managed by Platform")}</b><p>{text("账号、组织成员关系及 GitHub 授权均由 DeviLudo Platform 管理。", "Accounts, organization membership, and GitHub authorization are managed by DeviLudo Platform.")}</p></div>
          <Link className="button button-secondary" href="/account">{text("打开账号设置", "OPEN ACCOUNT SETTINGS")}</Link>
        </div>
      )}
    </section>
  );
}
