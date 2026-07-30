"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ProductSession, WorkspaceSummary } from "@/lib/product/contracts";
import { LanguageSwitcher, useLanguage } from "./i18n/LanguageProvider";
import {
  BellIcon,
  GamepadIcon,
  GridIcon,
  HomeIcon,
  PlusIcon,
  ServerIcon,
  SettingsIcon,
} from "./console/Icons";

type HealthState = "checking" | "ok" | "degraded";

export function ProductShell({ children }: { children: ReactNode }) {
  const { text } = useLanguage();
  const pathname = usePathname();
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const [session, setSession] = useState<ProductSession>({
    user: null,
    authenticated: false,
    setupRequired: false,
    selectedWorkspace: null,
  });
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [health, setHealth] = useState<HealthState>("checking");
  const [adding, setAdding] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [savingWorkspace, setSavingWorkspace] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/session", { cache: "no-store", signal: controller.signal }),
      fetch("/api/workspaces", { cache: "no-store", signal: controller.signal }),
    ]).then(async ([sessionResponse, workspacesResponse]) => {
      if (sessionResponse.ok) {
        const body = await sessionResponse.json() as { session: ProductSession };
        if (!controller.signal.aborted) {
          setSession(body.session);
          setSessionLoaded(true);
        }
      }
      if (workspacesResponse.ok) {
        const body = await workspacesResponse.json() as { workspaces: readonly WorkspaceSummary[] };
        if (!controller.signal.aborted) setWorkspaces(body.workspaces);
      }
    }).catch(() => { if (!controller.signal.aborted) setSessionLoaded(true); });
    void fetch("/api/health/live", { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setHealth(response.ok ? "ok" : "degraded"); })
      .catch(() => { if (!controller.signal.aborted) setHealth("degraded"); });
    const onWorkspaceChanged = (event: Event) => {
      const workspace = (event as CustomEvent<WorkspaceSummary>).detail;
      if (!workspace) return;
      setSession(current => ({ ...current, selectedWorkspace: workspace }));
      setWorkspaces(current => current.some(item => item.id === workspace.id) ? current : Object.freeze([...current, workspace]));
    };
    window.addEventListener("deviludo:workspace-changed", onWorkspaceChanged);
    return () => {
      controller.abort();
      window.removeEventListener("deviludo:workspace-changed", onWorkspaceChanged);
    };
  }, []);

  async function selectWorkspace(workspaceId: string) {
    setWorkspaceError("");
    const response = await fetch("/api/session/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    const body = await response.json() as { selectedWorkspace?: WorkspaceSummary; message?: string };
    if (!response.ok || !body.selectedWorkspace) {
      setWorkspaceError(body.message ?? text("无法选择工作区", "Unable to select workspace"));
      return;
    }
    setSession(current => ({ ...current, selectedWorkspace: body.selectedWorkspace! }));
    menuRef.current?.removeAttribute("open");
    window.location.assign("/");
  }

  async function clearWorkspace() {
    const response = await fetch("/api/session/workspace", { method: "DELETE" });
    if (!response.ok) {
      setWorkspaceError(text("无法退出当前工作区", "Unable to leave the current workspace"));
      return;
    }
    setSession(current => ({ ...current, selectedWorkspace: null }));
    menuRef.current?.removeAttribute("open");
    window.location.assign("/");
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = workspaceName.trim();
    if (!name || savingWorkspace) return;
    setSavingWorkspace(true);
    setWorkspaceError("");
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await response.json() as { workspace?: WorkspaceSummary; message?: string };
      if (!response.ok || !body.workspace) throw new Error(body.message ?? text("无法创建工作区", "Unable to create workspace"));
      setWorkspaces(current => Object.freeze([...current, body.workspace!]));
      setSession(current => ({ ...current, selectedWorkspace: body.workspace! }));
      setWorkspaceName("");
      setAdding(false);
      menuRef.current?.removeAttribute("open");
      window.location.assign("/");
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : text("无法创建工作区", "Unable to create workspace"));
    } finally {
      setSavingWorkspace(false);
    }
  }

  if (!sessionLoaded) return <div className="auth-screen"><LanguageSwitcher /><span className="eyebrow">DEVILUDO CORE</span><h1>{text("正在连接…", "CONNECTING…")}</h1></div>;
  if (session.setupRequired) return <InstanceSetupPanel />;
  if (!session.authenticated || !session.user) return <AuthenticationPanel />;

  const selected = session.selectedWorkspace;
  const healthLabel = health === "ok" ? "SYSTEM ONLINE" : health === "degraded" ? "SYSTEM LIMITED" : "SYSTEM SYNCING";
  return (
    <div className="app-shell">
      <aside className="shell-sidebar">
        <Link aria-label={text("DeviLudo 首页", "DeviLudo home")} className="brand" href="/">
          <span className="brand-mark"><Image alt="" height={36} priority src="/deviludo-brand-mark.png" width={36} /></span>
          <span className="brand-copy"><b>DeviLudo</b><small>GAMEFORGE OS</small></span>
        </Link>

        <details className="workspace-menu" ref={menuRef}>
          <summary aria-label={text("选择工作区", "Select workspace")} className="workspace-switcher">
            <span aria-hidden="true" className={`workspace-avatar ${selected ? "" : "workspace-avatar-empty"}`}>
              {selected ? workspaceMonogram(selected.name) : <GridIcon />}
            </span>
            <span><b>{selected?.name ?? text("未选择工作区", "No workspace selected")}</b><small>{selected ? text("当前工作区", "Current workspace") : text("选择或新建工作区", "Select or create a workspace")}</small></span>
            <span aria-hidden="true" className="workspace-chevron">⌄</span>
          </summary>
          <div aria-label={text("工作区菜单", "Workspace menu")} className="workspace-dropdown" role="menu">
            {workspaces.map(workspace => (
              <button className={`workspace-option ${workspace.id === selected?.id ? "is-selected" : ""}`} key={workspace.id} onClick={() => void selectWorkspace(workspace.id)} role="menuitem" type="button">
                <span className="workspace-add-icon">{workspaceMonogram(workspace.name)}</span>
                <span><b>{workspace.name}</b><small>{workspace.id === selected?.id ? text("当前工作区", "Current workspace") : text("切换到此工作区", "Switch to this workspace")}</small></span>
              </button>
            ))}
            <button className="workspace-add-option" onClick={() => setAdding(true)} role="menuitem" type="button">
              <span className="workspace-add-icon"><PlusIcon /></span>
              <b>{text("添加工作区", "Add workspace")}</b>
            </button>
            {selected ? <button className="workspace-clear-option" onClick={() => void clearWorkspace()} role="menuitem" type="button">{text("退出当前工作区", "Leave current workspace")}</button> : null}
            {workspaceError ? <p className="workspace-menu-error" role="alert">{workspaceError}</p> : null}
          </div>
        </details>

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
          <div className="topbar-context"><span className="topbar-mode">COMMAND CENTER</span><span>{selected?.name ?? text("未选择工作区", "No workspace selected")}</span></div>
          <div className="topbar-actions">
            <LanguageSwitcher compact />
            <span aria-live="polite" className={`system-pill is-${health}`}><i /> {healthLabel}</span>
            <button aria-label={text("通知", "Notifications")} className="icon-button" type="button"><BellIcon /></button>
          </div>
        </header>
        <main className="shell-content">{children}</main>
      </div>

      {adding ? (
        <div className="workspace-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setAdding(false); }}>
          <section aria-labelledby="workspace-dialog-title" aria-modal="true" className="workspace-dialog" role="dialog">
            <span className="eyebrow">NEW WORKSPACE</span>
            <h2 id="workspace-dialog-title">{text("新建工作区", "CREATE WORKSPACE")}</h2>
            <form onSubmit={createWorkspace}>
              <label>{text("工作区名称", "Workspace name")}<input autoFocus maxLength={200} onChange={event => setWorkspaceName(event.target.value)} placeholder={text("输入工作区名称", "Enter workspace name")} value={workspaceName} /></label>
              <div><button className="button button-secondary" onClick={() => setAdding(false)} type="button">{text("取消", "Cancel")}</button><button className="button button-acid" disabled={!workspaceName.trim() || savingWorkspace} type="submit">{savingWorkspace ? text("正在创建…", "CREATING…") : text("创建工作区", "CREATE WORKSPACE")}</button></div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function AuthenticationPanel() {
  const { text } = useLanguage();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = new FormData(event.currentTarget);
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: data.get("username"), password: data.get("password") }),
      });
      const body = await response.json().catch(() => ({})) as { code?: string; message?: string };
      if (!response.ok) {
        setError(body.message ?? failureMessage(body.code, response.status, text));
        return;
      }
      window.location.assign("/");
    } catch {
      setError(text("无法连接到 Core，请检查本地服务状态", "Unable to reach Core. Check the local services."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthenticationCard description={text("进入本实例的工作区。", "Access this instance and its workspaces.")} eyebrow="DEVILUDO · SECURE ACCESS" title={text("登录", "SIGN IN")}>
      <form onSubmit={submit}>
        <label>{text("用户名", "Username")}<input autoComplete="username" name="username" required /></label>
        <label>{text("密码", "Password")}<input autoComplete="current-password" name="password" required type="password" /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="button button-acid" disabled={busy} type="submit">{busy ? text("处理中…", "PROCESSING…") : text("登录", "SIGN IN")}</button>
      </form>
    </AuthenticationCard>
  );
}

function InstanceSetupPanel() {
  const { text } = useLanguage();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const data = new FormData(event.currentTarget);
      const password = String(data.get("password") ?? "");
      const passwordConfirmation = String(data.get("passwordConfirmation") ?? "");
      if (password !== passwordConfirmation) {
        setError(text("两次输入的密码不一致", "The passwords do not match"));
        return;
      }
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: data.get("username"), password, passwordConfirmation }),
      });
      const body = await response.json().catch(() => ({})) as { code?: string; message?: string };
      if (!response.ok) {
        setError(body.message ?? failureMessage(body.code, response.status, text));
        return;
      }
      window.location.assign("/");
    } catch {
      setError(text("无法连接到 Core，请检查本地服务状态", "Unable to reach Core. Check the local services."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthenticationCard description={text("首次使用，请创建本实例的管理员账号。", "Create the administrator account for this instance.")} eyebrow="DEVILUDO · INITIAL SETUP" title={text("设置管理员", "SET UP ADMIN")}>
      <form onSubmit={submit}>
        <label>{text("管理员用户名", "Admin username")}<input autoComplete="username" autoFocus maxLength={64} minLength={3} name="username" required /></label>
        <label>{text("管理员密码", "Admin password")}<input autoComplete="new-password" minLength={9} name="password" required type="password" /></label>
        <label>{text("确认密码", "Confirm password")}<input autoComplete="new-password" minLength={9} name="passwordConfirmation" required type="password" /></label>
        <p className="auth-password-rule">{text("至少 9 个字符，并包含数字、大写字母、小写字母、符号四类中的任意三类。", "Use at least 9 characters and any three of: numbers, uppercase letters, lowercase letters, and symbols.")}</p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="button button-acid" disabled={busy} type="submit">{busy ? text("正在创建…", "CREATING…") : text("创建管理员并进入", "CREATE ADMIN")}</button>
      </form>
    </AuthenticationCard>
  );
}

function AuthenticationCard({ children, description, eyebrow, title }: Readonly<{
  children: ReactNode;
  description: string;
  eyebrow: string;
  title: string;
}>) {
  return (
    <div className="auth-screen">
      <LanguageSwitcher />
      <section className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-mark"><Image alt="" height={42} priority src="/deviludo-brand-mark.png" width={42} /></span>
          <span><b>DEVILUDO</b><small>GAMEFORGE OS</small></span>
        </div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
        {children}
      </section>
    </div>
  );
}

function failureMessage(code: string | undefined, status: number, text: (chinese: string, english: string) => string): string {
  if (code === "ORIGIN_REJECTED") return text("请求来源校验失败，请刷新页面后重试", "Origin validation failed. Refresh and try again.");
  if (code === "CORE_UNAVAILABLE") return text("Core 暂时不可用", "Core is temporarily unavailable");
  if (code === "INSTANCE_ALREADY_CONFIGURED") return text("管理员已经设置，请刷新后登录", "The administrator is already configured. Refresh and sign in.");
  return text(`请求失败（${status}）`, `Request failed (${status})`);
}

function workspaceMonogram(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join("").toUpperCase() || "--";
}
