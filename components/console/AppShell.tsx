"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  BellIcon,
  FileIcon,
  GamepadIcon,
  GridIcon,
  LinkIcon,
  ServerIcon,
  ShieldIcon,
  SparkIcon,
} from "./Icons";

const navigation = [
  { href: "/", label: "工作台", icon: GridIcon },
  { href: "/projects/ember-archipelago", label: "游戏项目", icon: GamepadIcon },
  { href: "/runners", label: "运行节点", icon: ServerIcon },
  { href: "/evidence", label: "证据中心", icon: FileIcon },
];

const settings = [
  { href: "/settings/connections", label: "账号连接", icon: LinkIcon },
  { href: "/admin/agents", label: "Agent 管理", icon: ShieldIcon },
];

function NavItem({ href, label, icon: Icon }: (typeof navigation)[number]) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === href : pathname.startsWith(href);

  return (
    <Link className={`shell-nav-item ${active ? "is-active" : ""}`} href={href}>
      <Icon />
      <span>{label}</span>
      {active ? <i aria-hidden="true" /> : null}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<{
    tenantName: string; displayName: string; githubLogin: string; role: string; local?: boolean;
  } | null | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/session", { headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (response) => response.ok ? (await response.json() as { data: NonNullable<typeof account> }).data : null)
      .then(setAccount)
      .catch(() => { if (!controller.signal.aborted) setAccount(null); });
    return () => controller.abort();
  }, []);

  const tenantName = account?.tenantName ?? (account === undefined ? "正在验证…" : "未登录");
  const initials = account ? account.displayName.slice(0, 2).toUpperCase() : "—";

  async function signOut() {
    await fetch("/api/auth/session", { method: "DELETE" }).catch(() => undefined);
    window.location.assign("/login");
  }

  return (
    <div className="app-shell">
      <aside className="shell-sidebar">
        <Link aria-label="DeviLudo 工作台" className="brand" href="/">
          <span className="brand-mark"><SparkIcon /></span>
          <span>DeviLudo</span>
        </Link>

        <div className="workspace-switcher">
          <span className="workspace-avatar">ND</span>
          <span><b>{tenantName}</b><small>受邀 Beta</small></span>
          <span className="workspace-chevron">⌄</span>
        </div>

        <nav aria-label="主要导航" className="shell-nav">
          <p>构建</p>
          {navigation.map((item) => <NavItem key={item.href} {...item} />)}
          <p>设置</p>
          {settings.map((item) => <NavItem key={item.href} {...item} />)}
        </nav>

        <div className="shell-security-note">
          <ShieldIcon />
          <span><b>隔离运行</b><small>凭据由网关托管</small></span>
        </div>
      </aside>

      <div className="shell-main">
        <header className="shell-topbar">
          <div className="topbar-context">
            <span>{account ? `${account.tenantName} Studio` : "DeviLudo"}</span>
            <span className="crumb">/</span>
            <strong>生产空间</strong>
          </div>
          <div className="topbar-actions">
            <span className="system-pill"><i /> 系统正常</span>
            <button aria-label="通知" className="icon-button" type="button"><BellIcon /></button>
            {account ? (
              <button aria-label="退出当前账号" className="profile-button" onClick={signOut} title={`@${account.githubLogin} · ${account.role}`} type="button">
                <span>{initials}</span><b>{account.displayName}</b><small>退出</small>
              </button>
            ) : account === null ? (
              <Link className="profile-login" href="/login">受邀登录</Link>
            ) : <span className="profile-loading">验证会话…</span>}
          </div>
        </header>
        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
