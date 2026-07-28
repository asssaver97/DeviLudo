"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { ShellCapability } from "@/lib/auth/shell-capabilities";
import {
  BellIcon,
  GamepadIcon,
  PlusIcon,
  ShieldIcon,
  SparkIcon,
} from "./Icons";

type NavigationItem = { href: string; label: string; icon: typeof GamepadIcon };
type SettingsItem = NavigationItem & { capabilities: readonly ShellCapability[] };
type ShellAccount = {
  tenantName: string;
  displayName: string;
  githubLogin: string;
  role: string;
  authMode: "github-invite" | "trusted-admin" | "local-fixture" | "account-platform" | "account-platform-admin";
  canSignOut: boolean;
  capabilities: readonly ShellCapability[];
  configurationOwnership?: "workspace" | "platform";
};
type HealthState = "checking" | "ok" | "degraded";

const navigation: readonly NavigationItem[] = [
  { href: "/projects", label: "项目", icon: GamepadIcon },
];

const settings: readonly SettingsItem[] = [
  { href: "/settings", label: "设置", icon: ShieldIcon, capabilities: ["connections:manage", "tenant-agents:manage", "tenant-agents:view", "invitations:manage", "platform-agents:manage", "platform-agents:view"] },
];

function NavItem({ href, label, icon: Icon }: NavigationItem) {
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
  const [account, setAccount] = useState<ShellAccount | null | undefined>(undefined);
  const [health, setHealth] = useState<HealthState>("checking");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/session", { headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (response) => response.ok ? (await response.json() as { data: ShellAccount }).data : null)
      .then(setAccount)
      .catch(() => { if (!controller.signal.aborted) setAccount(null); });
    fetch("/api/health", { headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { status?: string };
        if (!controller.signal.aborted) setHealth(response.ok && payload.status === "ok" ? "ok" : "degraded");
      })
      .catch(() => { if (!controller.signal.aborted) setHealth("degraded"); });
    return () => controller.abort();
  }, []);

  const tenantName = account?.tenantName ?? (account === undefined ? "正在验证…" : "未登录");
  const tenantInitials = account ? initialsFor(account.tenantName) : "—";
  const initials = account ? account.displayName.slice(0, 2).toUpperCase() : "—";
  const visibleSettings = account ? settings.filter((item) => item.capabilities.some((capability) => account.capabilities.includes(capability))) : [];
  const healthLabel = health === "ok" ? "SYSTEM ONLINE" : health === "degraded" ? "SYSTEM LIMITED" : "SYSTEM SYNCING";

  async function signOut() {
    if (!account?.canSignOut) return;
    await fetch("/api/auth/session", { method: "DELETE" }).catch(() => undefined);
    window.location.assign("/login");
  }

  return (
    <div className="app-shell">
      <aside className="shell-sidebar">
        <Link aria-label="DeviLudo 项目" className="brand" href="/projects">
          <span className="brand-mark"><SparkIcon /></span>
          <span className="brand-copy"><b>DeviLudo</b><small>GAMEFORGE OS</small></span>
        </Link>

        <div className="workspace-switcher">
          <span className="workspace-avatar">{tenantInitials}</span>
          <span><b>{tenantName}</b><small>PLAYER STUDIO · BETA</small></span>
          <span className="workspace-chevron">⌄</span>
        </div>

        <nav aria-label="主要导航" className="shell-nav">
          <Link className="shell-new-project" href="/projects/new"><PlusIcon /><span>开始新游戏</span></Link>
          <p>WORKSPACE / 工作区</p>
          {navigation.map((item) => <NavItem key={item.href} {...item} />)}
          <p>ACCOUNT / 账户</p>
          {visibleSettings.map((item) => <NavItem key={item.href} {...item} />)}
        </nav>

        <div className="shell-security-note">
          <ShieldIcon />
          <span><b>SANDBOX LOCKED</b><small>凭据由安全网关托管</small></span>
        </div>
      </aside>

      <div className="shell-main">
        <header className="shell-topbar">
          <div className="topbar-context">
            <span className="topbar-mode">COMMAND CENTER</span>
            <span>{account ? `${account.tenantName} Studio` : "DeviLudo"}</span>
            <span className="crumb">{"//"}</span>
            <strong>PRODUCTION SLOT 01</strong>
          </div>
          <div className="topbar-actions">
            <span aria-live="polite" className={`system-pill is-${health}`}><i /> {healthLabel}</span>
            <button aria-label="通知" className="icon-button" type="button"><BellIcon /></button>
            {account?.canSignOut ? (
              <button aria-label="退出当前账号" className="profile-button" onClick={signOut} title={`@${account.githubLogin} · ${account.role}`} type="button">
                <span>{initials}</span><b>{account.displayName}</b><small>退出</small>
              </button>
            ) : account ? (
              <div aria-label={`当前会话 ${account.displayName} ${account.role}`} className="profile-button profile-session" title={`${account.authMode} · ${account.role}`}>
                <span>{initials}</span><b>{account.displayName}</b><small>{account.role}</small>
              </div>
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

function initialsFor(value: string) {
  const words = value.trim().split(/[\s_-]+/).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join("") : value.slice(0, 2)).toUpperCase();
}
