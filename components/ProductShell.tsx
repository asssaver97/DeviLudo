"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { ProductSession } from "@/lib/product/contracts";
import { BellIcon, GamepadIcon, HomeIcon, PlusIcon, ServerIcon, ShieldIcon, SparkIcon } from "./console/Icons";

type HealthState = "checking" | "ok" | "degraded";

export function ProductShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [session, setSession] = useState<ProductSession | null>(null);
  const [health, setHealth] = useState<HealthState>("checking");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/session", { signal: controller.signal })
      .then(async response => response.ok ? (await response.json() as { session: ProductSession }).session : null)
      .then(value => { if (!controller.signal.aborted) setSession(value); })
      .catch(() => undefined);
    void fetch("/api/health/live", { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setHealth(response.ok ? "ok" : "degraded"); })
      .catch(() => { if (!controller.signal.aborted) setHealth("degraded"); });
    return () => controller.abort();
  }, []);

  const tenantName = session?.tenantName ?? "正在连接…";
  const initials = tenantName.slice(0, 2).toUpperCase();
  const healthLabel = health === "ok" ? "SYSTEM ONLINE" : health === "degraded" ? "SYSTEM LIMITED" : "SYSTEM SYNCING";
  return (
    <div className="app-shell">
      <aside className="shell-sidebar">
        <Link aria-label="DeviLudo 首页" className="brand" href="/">
          <span className="brand-mark"><SparkIcon /></span>
          <span className="brand-copy"><b>DeviLudo</b><small>GAMEFORGE OS</small></span>
        </Link>

        <div className="workspace-switcher">
          <span className="workspace-avatar">{initials}</span>
          <span><b>{tenantName}</b><small>PLAYER STUDIO · BETA</small></span>
          <span className="workspace-chevron">⌄</span>
        </div>

        <nav aria-label="主要导航" className="shell-nav">
          <Link className="shell-new-project" href="/projects/new"><PlusIcon /><span>开始新游戏</span></Link>
          <p>WORKSPACE / 工作区</p>
          <Link className={`shell-nav-item ${pathname === "/" ? "is-active" : ""}`} href="/">
            <HomeIcon /><span>首页</span>{pathname === "/" ? <i aria-hidden="true" /> : null}
          </Link>
          <Link className={`shell-nav-item ${pathname.startsWith("/projects") ? "is-active" : ""}`} href="/projects">
            <GamepadIcon /><span>项目</span>{pathname.startsWith("/projects") ? <i aria-hidden="true" /> : null}
          </Link>
          <p>ACCOUNT / 账户</p>
          <Link className={`shell-nav-item ${pathname.startsWith("/admin/server-pools") ? "is-active" : ""}`} href="/admin/server-pools">
            <ServerIcon /><span>运行状态</span>{pathname.startsWith("/admin/server-pools") ? <i aria-hidden="true" /> : null}
          </Link>
        </nav>

        <div className="shell-security-note"><ShieldIcon /><span><b>SANDBOX LOCKED</b><small>凭据由安全网关托管</small></span></div>
      </aside>

      <div className="shell-main">
        <header className="shell-topbar">
          <div className="topbar-context"><span className="topbar-mode">COMMAND CENTER</span><span>{tenantName} Studio</span><span className="crumb">{"//"}</span><strong>PRODUCTION SLOT 01</strong></div>
          <div className="topbar-actions">
            <span aria-live="polite" className={`system-pill is-${health}`}><i /> {healthLabel}</span>
            <button aria-label="通知" className="icon-button" type="button"><BellIcon /></button>
            <div className="profile-button profile-session"><span>本地</span><b>{session?.displayName ?? "本地开发者"}</b><small>{session?.role ?? "TenantAdmin"}</small></div>
          </div>
        </header>
        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
