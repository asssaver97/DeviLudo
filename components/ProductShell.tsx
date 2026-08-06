"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ProductSession } from "@/lib/product/contracts";
import { cachedValue, clientCacheKeys, loadCached } from "@/lib/product/client-cache";
import { LanguageSwitcher, useLanguage } from "./i18n/LanguageProvider";
import { BellIcon, GamepadIcon, HomeIcon, ServerIcon, SettingsIcon } from "./console/Icons";

type HealthState = "checking" | "ok" | "degraded";
const ProductSessionContext = createContext<ProductSession | undefined>(undefined);

export function ProductShell({ children }: { children: ReactNode }) {
  const { text } = useLanguage();
  const pathname = usePathname();
  const cachedSession = cachedValue<ProductSession>(clientCacheKeys.session);
  const [session, setSession] = useState<ProductSession | null>(cachedSession ?? null);
  const [sessionLoaded, setSessionLoaded] = useState(Boolean(cachedSession));
  const [health, setHealth] = useState<HealthState>(cachedValue<HealthState>(clientCacheKeys.health) ?? "checking");

  useEffect(() => {
    const controller = new AbortController();
    void loadCached(clientCacheKeys.session, 30_000, async () => {
      const response = await fetch("/api/session", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
      return (await response.json() as { session: ProductSession }).session;
    })
      .then(value => { if (!controller.signal.aborted) setSession(value); })
      .catch(() => undefined)
      .finally(() => { if (!controller.signal.aborted) setSessionLoaded(true); });
    void loadCached<HealthState>(clientCacheKeys.health, 30_000, async () => {
      const response = await fetch("/api/health/live", { signal: controller.signal });
      return response.ok ? "ok" : "degraded";
    })
      .then(value => { if (!controller.signal.aborted) setHealth(value); })
      .catch(() => { if (!controller.signal.aborted) setHealth("degraded"); });
    return () => controller.abort();
  }, []);

  if (!sessionLoaded) {
    return <div className="auth-screen"><LanguageSwitcher /><span className="eyebrow">DEVILUDO CORE</span><h1>{text("正在连接…", "CONNECTING…")}</h1></div>;
  }
  if (!session) {
    return <div className="auth-screen"><LanguageSwitcher /><span className="eyebrow">DEVILUDO CORE</span><h1>{text("访问不可用", "ACCESS UNAVAILABLE")}</h1><p>{text("Platform 会话无效或账号服务暂时不可用。", "The Platform session is invalid or the account service is unavailable.")}</p></div>;
  }

  const workspace = session.selectedWorkspace;
  const healthLabel = health === "ok" ? "SYSTEM ONLINE" : health === "degraded" ? "SYSTEM LIMITED" : "SYSTEM SYNCING";
  return (
    <div className="app-shell">
      <aside className="shell-sidebar">
        <Link aria-label={text("DeviLudo 首页", "DeviLudo home")} className="brand" href="/">
          <span className="brand-mark"><Image alt="" height={36} priority src="/deviludo-brand-mark.png" unoptimized width={36} /></span>
          <span className="brand-copy"><b>DeviLudo</b><small>GAMEFORGE OS</small></span>
        </Link>

        <div className="workspace-switcher" aria-label={text("当前工作区", "Current workspace")}>
          <span aria-hidden="true" className="workspace-avatar">{workspaceMonogram(workspace.name)}</span>
          <span><b>{workspace.name}</b><small>{session.authMode === "STANDALONE" ? text("本地独立模式", "Local standalone mode") : text("由 Platform 管理", "Managed by Platform")}</small></span>
        </div>

        <nav aria-label={text("主要导航", "Main navigation")} className="shell-nav">
          <Link className={`shell-nav-item shell-home-entry ${pathname === "/" ? "is-active" : ""}`} href="/">
            <HomeIcon /><span>{text("首页", "Home")}</span>{pathname === "/" ? <i aria-hidden="true" /> : null}
          </Link>
          <Link className={`shell-nav-item ${pathname.startsWith("/projects") ? "is-active" : ""}`} href="/projects">
            <GamepadIcon /><span>{text("项目", "Projects")}</span>{pathname.startsWith("/projects") ? <i aria-hidden="true" /> : null}
          </Link>
          <p>CONFIG / {text("配置", "SYSTEM")}</p>
          <Link className={`shell-nav-item ${pathname.startsWith("/settings") ? "is-active" : ""}`} href="/settings">
            <SettingsIcon /><span>{text("设置", "Settings")}</span>{pathname.startsWith("/settings") ? <i aria-hidden="true" /> : null}
          </Link>
          <Link className={`shell-nav-item ${pathname.startsWith("/admin/server-pools") ? "is-active" : ""}`} href="/admin/server-pools">
            <ServerIcon /><span>{text("运行状态", "Runtime")}</span>{pathname.startsWith("/admin/server-pools") ? <i aria-hidden="true" /> : null}
          </Link>
        </nav>
      </aside>

      <div className="shell-main">
        <header className="shell-topbar">
          <div className="topbar-context"><span className="topbar-mode">COMMAND CENTER</span><span>{workspace.name}</span></div>
          <div className="topbar-actions">
            <LanguageSwitcher compact />
            <span aria-live="polite" className={`system-pill is-${health}`}><i /> {healthLabel}</span>
            <button aria-label={text("通知", "Notifications")} className="icon-button" type="button"><BellIcon /></button>
          </div>
        </header>
        <main className="shell-content"><ProductSessionContext.Provider value={session}>{children}</ProductSessionContext.Provider></main>
      </div>
    </div>
  );
}

export function useProductSession(): ProductSession {
  const session = useContext(ProductSessionContext);
  if (!session) throw new Error("ProductSessionContext is missing");
  return session;
}

function workspaceMonogram(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join("").toUpperCase() || "--";
}
