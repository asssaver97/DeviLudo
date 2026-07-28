"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ShellCapability } from "@/lib/auth/shell-capabilities";
import { AppShell } from "./AppShell";
import { ArrowIcon, LinkIcon, ShieldIcon, SparkIcon } from "./Icons";

type SettingsSession = { capabilities: readonly ShellCapability[] };

const entries = [
  { href: "/settings/connections", title: "账号与连接", description: "管理 GitHub App 授权和 Steam Guard 发布会话。", icon: LinkIcon, capabilities: ["connections:manage"] },
  { href: "/settings/agents", title: "开发 Agent", description: "管理租户 Provider、模型、BYOK 凭据和默认 Profile。", icon: SparkIcon, capabilities: ["tenant-agents:manage", "tenant-agents:view"] },
  { href: "/admin/invitations", title: "成员邀请", description: "邀请成员加入当前租户并管理访问权限。", icon: ShieldIcon, capabilities: ["invitations:manage"] },
  { href: "/admin/agents", title: "平台 Agent", description: "安装、更新、灰度和审计 Claude Code 与 Codex CLI。", icon: ShieldIcon, capabilities: ["platform-agents:manage", "platform-agents:view"] },
] as const;

export function SettingsHub() {
  const [session, setSession] = useState<SettingsSession | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/session", { headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (response) => response.ok ? (await response.json() as { data: SettingsSession }).data : null)
      .then(setSession)
      .catch(() => { if (!controller.signal.aborted) setSession(null); });
    return () => controller.abort();
  }, []);

  const visibleEntries = session
    ? entries.filter((entry) => entry.capabilities.some((capability) => session.capabilities.includes(capability)))
    : [];

  return (
    <AppShell>
      <section className="page-heading settings-hub-heading">
        <div><span className="eyebrow">WORKSPACE SETTINGS · 集中管理</span><h1>设置</h1><p>连接、Agent 与管理功能统一收在这里，不占用日常项目导航。</p></div>
      </section>
      <section className="settings-hub-grid" aria-label="可用设置">
        {visibleEntries.map(({ href, title, description, icon: Icon }) => (
          <Link className="settings-hub-card" href={href} key={href}>
            <span><Icon /></span>
            <div><h2>{title}</h2><p>{description}</p></div>
            <ArrowIcon />
          </Link>
        ))}
        {!session ? <div className="settings-hub-loading">正在读取当前账号可用设置…</div> : null}
      </section>
    </AppShell>
  );
}
