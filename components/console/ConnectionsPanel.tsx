"use client";

import { useState } from "react";
import { AppShell } from "./AppShell";
import { CheckIcon, GithubIcon, ShieldIcon, SteamIcon } from "./Icons";

export function ConnectionsPanel() {
  const [githubConnected] = useState(false);
  const [githubBusy, setGithubBusy] = useState(false);
  const [steamState, setSteamState] = useState<"unconfigured" | "ready" | "waiting">("unconfigured");
  const [notice, setNotice] = useState("");

  async function connectGithub() {
    setGithubBusy(true);
    try {
      const response = await fetch("/api/connections/github", { method: "POST" });
      const payload = await response.json() as { data?: { authorizeUrl?: string }; error?: { message?: string } };
      if (!response.ok || !payload.data?.authorizeUrl) {
        setNotice(payload.error?.message ?? "GitHub App 安装服务尚未配置。");
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
    setSteamState("waiting");
    try {
      const response = await fetch("/api/connections/steam", { method: "POST" });
      const payload = await response.json() as { data?: { state?: string }; error?: { message?: string } };
      if (!response.ok) {
        setSteamState("unconfigured");
        setNotice(payload.error?.message ?? "Steam Guard 登记服务尚未配置。");
        return;
      }
      setSteamState(payload.data?.state === "READY" ? "ready" : "waiting");
      setNotice("Steam Guard 登记已开始；主密码不会发送到 DeviLudo Web 控制面。");
    } catch {
      setSteamState("unconfigured");
      setNotice("无法连接隔离的 Steam Guard 登记服务。");
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
              <div className="connection-title"><div><h2>GitHub App</h2><p>仓库身份、分支与 Draft PR</p></div><span className={githubConnected ? "connected" : "not-connected"}><i />{githubConnected ? "已连接" : "未连接"}</span></div>
              {githubConnected ? (
                <div className="connection-details">
                  <div><span>组织</span><b>north-dock-studio</b></div>
                  <div><span>授权仓库</span><b>2 个选定仓库</b></div>
                  <div><span>权限</span><b>Contents / Pull requests</b></div>
                  <div><span>上次验证</span><b>今天 09:41</b></div>
                </div>
              ) : <p className="connection-empty">连接后，代码修改只会进入工作分支和 Draft PR。</p>}
              <div className="connection-actions">
                <button className="button button-secondary" disabled={githubBusy} onClick={connectGithub} type="button">{githubBusy ? "正在创建授权…" : githubConnected ? "重新授权" : "使用 GitHub 授权"}</button>
                {githubConnected ? <button className="quiet-button" onClick={() => setNotice("仓库范围选择器将在 GitHub App 安装页打开。") } type="button">管理仓库范围</button> : null}
              </div>
            </div>
          </article>

          <article className="connection-card">
            <div className="connection-logo steam"><SteamIcon /></div>
            <div className="connection-summary">
              <div className="connection-title"><div><h2>Steamworks</h2><p>私有 Beta 上传、激活与回装测试</p></div><span className={steamState === "ready" ? "connected" : steamState === "waiting" ? "waiting" : "not-connected"}><i />{steamState === "ready" ? "会话可用" : steamState === "waiting" ? "等待 Guard" : "未配置"}</span></div>
              <div className="connection-details">
                <div><span>发布身份</span><b>{steamState === "ready" ? "已验证 Build Account" : "尚未绑定"}</b></div>
                <div><span>权限</span><b>{steamState === "ready" ? "固定 App · Build only" : "待最小权限验证"}</b></div>
                <div><span>会话形式</span><b>加密 config.vdf</b></div>
                <div><span>到期时间</span><b>{steamState === "ready" ? "已登记" : "尚未建立"}</b></div>
              </div>
              <div className="connection-actions">
                <button className="button button-secondary" disabled={steamState === "waiting"} onClick={beginSteamLogin} type="button">{steamState === "ready" ? "刷新 Steam Guard 会话" : steamState === "waiting" ? "等待登记服务…" : "登记 Steam Guard 会话"}</button>
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
