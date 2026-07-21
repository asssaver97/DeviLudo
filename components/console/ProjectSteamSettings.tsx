"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SteamProjectConfigurationStatus } from "@/lib/connections/steam-broker";
import { AppShell } from "./AppShell";
import { CheckIcon, ShieldIcon, SteamIcon } from "./Icons";

const EMPTY: SteamProjectConfigurationStatus = Object.freeze({ state: "UNCONFIGURED", projectId: "", configurationUrl: null,
  intentExpiresAt: null, revision: null, steamAppId: null, betaBranch: null, platformDepots: Object.freeze({}),
  accountName: null, sessionExpiresAt: null });

export function ProjectSteamSettings({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<SteamProjectConfigurationStatus>({ ...EMPTY, projectId });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [brokerAvailable, setBrokerAvailable] = useState(true);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/steam-settings`, { cache: "no-store" });
    const payload = await response.json() as { data?: SteamProjectConfigurationStatus; error?: { code?: string; message?: string } };
    if (!response.ok || !payload.data) {
      if (payload.error?.code === "STEAM_PROJECT_CONFIGURATION_BROKER_REQUIRED") setBrokerAvailable(false);
      throw new Error(payload.error?.message ?? "无法读取 Steam 发布配置");
    }
    setStatus(payload.data); setBrokerAvailable(true);
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => {
      void refresh().catch((error) => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "读取配置失败"); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => { window.clearTimeout(initial); controller.abort(); };
  }, [refresh]);

  async function configure() {
    if (status.state === "CONFIGURING" && status.configurationUrl) return openSecure(status.configurationUrl);
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/steam-settings`, {
        method: "POST", headers: { "idempotency-key": `steam-project-${crypto.randomUUID()}` },
      });
      const payload = await response.json() as { data?: { state?: "CONFIGURING" | "READY"; configurationUrl?: string | null }; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "无法开始 Steam 发布配置");
      if (payload.data.state === "CONFIGURING" && payload.data.configurationUrl) return openSecure(payload.data.configurationUrl);
      await refresh(); setNotice("Steam 发布配置已经生效。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Steam 发布配置失败"); }
    finally { setBusy(false); }
  }

  function openSecure(value: string) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || !url.pathname.includes(`/projects/${projectId}/steam-configuration/`)) throw new Error("隔离配置地址未通过安全校验");
    window.location.assign(url.href);
  }

  const ready = status.state === "READY";
  const stale = status.state === "STALE_SESSION";
  const platforms = Object.entries(status.platformDepots);
  return <AppShell>
    {notice ? <div className="toast" role="status"><CheckIcon /><span>{notice}</span><button onClick={() => setNotice("")} type="button">×</button></div> : null}
    <section className="page-heading settings-heading agent-settings-heading"><div><span className="eyebrow">项目发布 · {projectId}</span><h1>Steam 私有 Beta 设置</h1><p>冻结 App、平台 Depot 和密码保护分支；分支密码只通过隔离 Secure UI 写入 Vault。</p></div><span className="scope-badge"><SteamIcon />ProjectOwner</span></section>
    <section className="agent-settings-summary steam-settings-summary">
      <article><span><SteamIcon /></span><div><small>发布配置</small><strong>{loading ? "验证中" : ready ? `Revision ${status.revision}` : stale ? "会话已过期" : status.state === "CONFIGURING" ? "等待安全提交" : "尚未配置"}</strong><p>{ready ? "已满足 Steam 私有 Beta 发布前置条件。" : stale ? "重新登记 Steam Guard 会话并创建新 revision。" : "配置不会经过开发 Agent 或项目工作区。"}</p></div></article>
      <article><span><ShieldIcon /></span><div><small>Build Account</small><strong>{status.accountName ?? "未绑定"}</strong><p>{status.sessionExpiresAt ? `会话到期 ${format(status.sessionExpiresAt)}` : "先在账号连接页验证最小权限账号。"}</p></div></article>
      <article><span><CheckIcon /></span><div><small>目标矩阵</small><strong>{platforms.length ? platforms.map(([name]) => label(name)).join(" / ") : "等待配置"}</strong><p>{platforms.length ? platforms.map(([name, id]) => `${label(name)} ${id}`).join(" · ") : "每个选择的平台必须绑定唯一 Depot。"}</p></div></article>
    </section>
    <div className="project-agent-layout steam-settings-layout">
      <section className="settings-card">
        <div className="settings-card-title"><div><span className="step-number">A</span><h2>冻结配置</h2></div><span>{status.state}</span></div>
        <dl className="scope-chain"><div><dt>1</dt><dd><b>Steam App ID</b><small>{status.steamAppId ?? "隔离页面填写"}</small></dd></div><div><dt>2</dt><dd><b>密码保护 Beta</b><small>{status.betaBranch ?? "禁止 default / public"}</small></dd></div><div><dt>3</dt><dd><b>SecretRef</b><small>仅发布服务可兑换</small></dd></div></dl>
        <button className="button button-primary project-profile-save" disabled={busy || loading || !brokerAvailable} onClick={() => void configure()} type="button">{busy ? "正在建立安全会话…" : status.state === "CONFIGURING" ? "继续隔离配置" : ready ? "创建新配置 Revision" : "进入隔离配置页面"}</button>
      </section>
      <section className="settings-card"><div className="settings-card-title"><div><span className="step-number">B</span><h2>安全边界</h2></div><span>Fail closed</span></div>
        <ul className="steam-security-list"><li><CheckIcon /><span><b>主站不接收密码</b><small>浏览器直接提交到独立 Steam Secure UI。</small></span></li><li><CheckIcon /><span><b>权限与 App ID 复核</b><small>配置意图锁定已验证 Build Account，会话失效即拒绝。</small></span></li><li><CheckIcon /><span><b>Revision 不可变</b><small>新配置只 supersede 旧版本，不修改运行中任务。</small></span></li></ul>
        <Link className="button button-secondary project-profile-save" href="/settings/connections">管理 Steam Guard 会话</Link>
      </section>
      <aside className="project-agent-note"><ShieldIcon /><div><b>本地测试保持安全</b><p>{brokerAvailable ? "只有隔离 Broker 可用时才开放真实配置。" : "当前本地站点未接入隔离 Broker，因此按钮保持禁用，也不会用 Fixture 假装保存 Steam 密钥。"}</p><Link href={`/projects/${encodeURIComponent(projectId)}`}>返回项目工作区 →</Link></div></aside>
    </div>
  </AppShell>;
}

function label(platform: string): string { return platform === "windows" ? "Windows" : platform === "linux" ? "Linux" : "macOS"; }
function format(value: string): string { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
