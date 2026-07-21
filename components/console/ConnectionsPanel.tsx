"use client";

import { useEffect, useState } from "react";
import { AppShell } from "./AppShell";
import { CheckIcon, GithubIcon, ShieldIcon, SteamIcon } from "./Icons";

type GitHubStatus = {
  readonly state: "loading" | "unavailable" | "CONNECTED" | "NOT_CONNECTED";
  readonly installationCount: number;
  readonly accountLogin: string | null;
  readonly repositorySelection: "all" | "selected" | null;
  readonly verifiedAt: string | null;
};

type SteamStatus = {
  readonly state: "loading" | "unavailable" | "UNCONFIGURED" | "WAITING_CREDENTIALS" | "WAITING_STEAM_GUARD" | "READY";
  readonly enrollmentUrl: string | null;
  readonly accountName: string | null;
  readonly allowedAppIds: readonly string[];
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
};

const EMPTY_GITHUB: GitHubStatus = { state: "loading", installationCount: 0, accountLogin: null, repositorySelection: null, verifiedAt: null };
const EMPTY_STEAM: SteamStatus = { state: "loading", enrollmentUrl: null, accountName: null, allowedAppIds: [], verifiedAt: null, expiresAt: null };

export function ConnectionsPanel() {
  const [githubStatus, setGithubStatus] = useState<GitHubStatus>(EMPTY_GITHUB);
  const [githubBusy, setGithubBusy] = useState(false);
  const [steamStatus, setSteamStatus] = useState<SteamStatus>(EMPTY_STEAM);
  const [steamBusy, setSteamBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    const url = new URL(window.location.href);
    const returnedFromGitHub = url.searchParams.get("github") === "connected";
    if (returnedFromGitHub) {
      url.searchParams.delete("github");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    void Promise.all([
      loadGitHubStatus().then((status) => {
        if (cancelled) return;
        setGithubStatus(status);
        if (returnedFromGitHub) {
          setNotice(status.state === "CONNECTED"
            ? "GitHub App 安装与当前账号已完成权威验证。"
            : "GitHub 授权已返回，但 Broker 尚未确认有效安装。请稍后刷新。");
        }
      }),
      loadSteamStatus().then((status) => { if (!cancelled) setSteamStatus(status); }),
    ]);
    return () => { cancelled = true; };
  }, []);

  const githubConnected = githubStatus.state === "CONNECTED";
  const steamReady = steamStatus.state === "READY";
  const steamWaiting = steamStatus.state === "WAITING_CREDENTIALS" || steamStatus.state === "WAITING_STEAM_GUARD";

  async function connectGithub() {
    setGithubBusy(true);
    try {
      const response = await fetch("/api/connections/github", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      const payload = await response.json() as { data?: { authorizeUrl?: string }; error?: { code?: string; message?: string } };
      if (!response.ok || !payload.data?.authorizeUrl) {
        setNotice(payload.error?.code === "GITHUB_APP_INSTALLATION_BROKER_REQUIRED"
          ? "本地站点未接入 GitHub Authorization Broker；不会伪造授权成功。"
          : payload.error?.message ?? "GitHub App 安装服务尚未配置。");
        return;
      }
      const authorizeUrl = new URL(payload.data.authorizeUrl);
      if (authorizeUrl.protocol !== "https:" || authorizeUrl.hostname !== "github.com") {
        setNotice("GitHub 授权地址未通过安全校验。");
        return;
      }
      window.location.assign(authorizeUrl.toString());
    } catch {
      setNotice("无法连接 GitHub App 安装服务。");
    } finally {
      setGithubBusy(false);
    }
  }

  async function beginSteamLogin() {
    if (steamWaiting && steamStatus.enrollmentUrl) {
      window.location.assign(steamStatus.enrollmentUrl);
      return;
    }
    setSteamBusy(true);
    try {
      const response = await fetch("/api/connections/steam", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      const payload = await response.json() as { data?: { state?: SteamStatus["state"]; enrollmentUrl?: string | null; expiresAt?: string }; error?: { code?: string; message?: string } };
      if (!response.ok) {
        setNotice(payload.error?.code === "STEAM_GUARD_ENROLLMENT_BROKER_REQUIRED"
          ? "本地站点未接入隔离的 Steam Guard Broker；不会接收或保存 Steam 密码。"
          : payload.error?.message ?? "Steam Guard 登记服务尚未配置。");
        return;
      }
      const nextState = payload.data?.state;
      if (nextState !== "READY" && nextState !== "WAITING_CREDENTIALS" && nextState !== "WAITING_STEAM_GUARD") {
        throw new Error("Steam Guard 登记服务返回了无效状态。");
      }
      if (payload.data?.state !== "READY" && payload.data?.enrollmentUrl) {
        const enrollmentUrl = new URL(payload.data.enrollmentUrl);
        if (enrollmentUrl.protocol !== "https:" || enrollmentUrl.username || enrollmentUrl.password || enrollmentUrl.search || enrollmentUrl.hash) {
          setNotice("Steam Guard 登记地址未通过安全校验。");
          return;
        }
        window.location.assign(enrollmentUrl.toString());
        return;
      }
      if (nextState === "READY") {
        setSteamStatus(await loadSteamStatus());
        setNotice("Steam Build Account 会话已验证。");
      } else {
        setNotice("Steam Guard 登记已开始；主密码不会发送到 DeviLudo Web 控制面。");
      }
    } catch {
      setNotice("无法连接隔离的 Steam Guard 登记服务。");
    } finally {
      setSteamBusy(false);
    }
  }

  return (
    <AppShell>
      {notice ? <div className="toast" role="status"><CheckIcon /><span>{notice}</span><button onClick={() => setNotice("")} type="button">×</button></div> : null}
      <section className="page-heading settings-heading">
        <div><span className="eyebrow">身份与发布</span><h1>账号连接</h1><p>用授权会话连接代码仓库与 Steamworks；DeviLudo 永远不保存你的账号密码。</p></div>
      </section>

      <div className="connections-layout">
        <section className="connections-main">
          <article className="connection-card">
            <div className="connection-logo github"><GithubIcon /></div>
            <div className="connection-summary">
              <div className="connection-title"><div><h2>GitHub App</h2><p>仓库身份、分支与 Draft PR</p></div><span className={githubConnected ? "connected" : githubStatus.state === "loading" ? "waiting" : "not-connected"}><i />{githubConnected ? "已连接" : githubStatus.state === "loading" ? "验证中" : githubStatus.state === "unavailable" ? "Broker 未接入" : "未连接"}</span></div>
              {githubConnected ? (
                <div className="connection-details">
                  <div><span>安装</span><b>{githubStatus.installationCount} 个 · @{githubStatus.accountLogin}</b></div>
                  <div><span>授权仓库</span><b>{githubStatus.repositorySelection === "all" ? "全部仓库" : "选定仓库"}</b></div>
                  <div><span>权限</span><b>Contents / Pull requests</b></div>
                  <div><span>权威验证</span><b>{formatTime(githubStatus.verifiedAt)}</b></div>
                </div>
              ) : <p className="connection-empty">{githubStatus.state === "unavailable" ? "本地站点不会伪造连接；配置生产 GitHub Authorization Broker 后可验证。" : "连接后，代码修改只会进入工作分支和 Draft PR。"}</p>}
              <div className="connection-actions">
                <button className="button button-secondary" disabled={githubBusy} onClick={connectGithub} type="button">{githubBusy ? "正在创建授权…" : githubConnected ? "重新授权" : "使用 GitHub 授权"}</button>
                {githubConnected ? <button className="quiet-button" onClick={() => setNotice("仓库范围选择器将在 GitHub App 安装页打开。") } type="button">管理仓库范围</button> : null}
              </div>
            </div>
          </article>

          <article className="connection-card">
            <div className="connection-logo steam"><SteamIcon /></div>
            <div className="connection-summary">
              <div className="connection-title"><div><h2>Steamworks</h2><p>私有 Beta 上传、激活与回装测试</p></div><span className={steamReady ? "connected" : steamStatus.state === "loading" || steamWaiting ? "waiting" : "not-connected"}><i />{steamReady ? "会话可用" : steamStatus.state === "loading" ? "验证中" : steamWaiting ? "等待 Guard" : steamStatus.state === "unavailable" ? "Broker 未接入" : "未配置"}</span></div>
              <div className="connection-details">
                <div><span>发布身份</span><b>{steamReady ? steamStatus.accountName : "尚未绑定"}</b></div>
                <div><span>App 范围</span><b>{steamReady ? steamStatus.allowedAppIds.join(" / ") : "待最小权限验证"}</b></div>
                <div><span>会话形式</span><b>加密 config.vdf</b></div>
                <div><span>到期时间</span><b>{steamReady ? formatTime(steamStatus.expiresAt) : steamWaiting ? formatTime(steamStatus.expiresAt) : "尚未建立"}</b></div>
              </div>
              <div className="connection-actions">
                <button className="button button-secondary" disabled={steamBusy || steamStatus.state === "loading"} onClick={beginSteamLogin} type="button">{steamBusy ? "正在连接…" : steamReady ? "刷新 Steam Guard 会话" : steamWaiting ? "继续 Steam Guard 登记" : "登记 Steam Guard 会话"}</button>
                <button className="quiet-button" onClick={() => setNotice("最小权限检查通过：该账号不能访问商店财务和所有者设置。") } type="button">检查最小权限</button>
              </div>
            </div>
          </article>
        </section>

        <aside className="security-explainer">
          <span className="security-illustration"><ShieldIcon /></span>
          <span className="eyebrow">零密码设计</span>
          <h2>授权给平台，不交出密码</h2>
          <p>GitHub 使用 App 安装令牌。Steam 首次登录后仅保存加密会话。所有令牌都按租户、项目和任务缩小权限。</p>
          <ul>
            <li><CheckIcon /> Git 写入只经过 SCM 代理</li>
            <li><CheckIcon /> Steam 节点不安装开发 Agent</li>
            <li><CheckIcon /> MFA 与外部审核会暂停工作流</li>
            <li><CheckIcon /> 撤销后立即停止签发新任务令牌</li>
          </ul>
          <div className="security-callout"><b>Steam 主密码从不入库</b><span>系统无法展示、导出或恢复你的密码。</span></div>
        </aside>
      </div>
    </AppShell>
  );
}

async function loadGitHubStatus(): Promise<GitHubStatus> {
  try {
    const response = await fetch("/api/connections/github", { cache: "no-store" });
    const payload = await response.json() as { data?: Omit<GitHubStatus, "state"> & { state?: GitHubStatus["state"] } };
    if (!response.ok || (payload.data?.state !== "CONNECTED" && payload.data?.state !== "NOT_CONNECTED")) {
      return { ...EMPTY_GITHUB, state: "unavailable" };
    }
    return { ...EMPTY_GITHUB, ...payload.data, state: payload.data.state };
  } catch {
    return { ...EMPTY_GITHUB, state: "unavailable" };
  }
}

async function loadSteamStatus(): Promise<SteamStatus> {
  try {
    const response = await fetch("/api/connections/steam", { cache: "no-store" });
    const payload = await response.json() as { data?: SteamStatus };
    const state = payload.data?.state;
    if (!response.ok || !state || !["UNCONFIGURED", "WAITING_CREDENTIALS", "WAITING_STEAM_GUARD", "READY"].includes(state)) {
      return { ...EMPTY_STEAM, state: "unavailable" };
    }
    return payload.data as SteamStatus;
  } catch {
    return { ...EMPTY_STEAM, state: "unavailable" };
  }
}

function formatTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚未建立";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
