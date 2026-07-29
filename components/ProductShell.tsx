"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ProductSession, WorkspaceSummary } from "@/lib/product/contracts";
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
  const pathname = usePathname();
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const [session, setSession] = useState<ProductSession>({ selectedWorkspace: null });
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
        if (!controller.signal.aborted) setSession(body.session);
      }
      if (workspacesResponse.ok) {
        const body = await workspacesResponse.json() as { workspaces: readonly WorkspaceSummary[] };
        if (!controller.signal.aborted) setWorkspaces(body.workspaces);
      }
    }).catch(() => undefined);
    void fetch("/api/health/live", { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setHealth(response.ok ? "ok" : "degraded"); })
      .catch(() => { if (!controller.signal.aborted) setHealth("degraded"); });
    const onWorkspaceChanged = (event: Event) => {
      const workspace = (event as CustomEvent<WorkspaceSummary>).detail;
      if (!workspace) return;
      setSession({ selectedWorkspace: workspace });
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
      setWorkspaceError(body.message ?? "无法选择工作区");
      return;
    }
    setSession({ selectedWorkspace: body.selectedWorkspace });
    menuRef.current?.removeAttribute("open");
    window.location.assign("/");
  }

  async function clearWorkspace() {
    const response = await fetch("/api/session/workspace", { method: "DELETE" });
    if (!response.ok) {
      setWorkspaceError("无法退出当前工作区");
      return;
    }
    setSession({ selectedWorkspace: null });
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
      if (!response.ok || !body.workspace) throw new Error(body.message ?? "无法创建工作区");
      setWorkspaces(current => Object.freeze([...current, body.workspace!]));
      setSession({ selectedWorkspace: body.workspace });
      setWorkspaceName("");
      setAdding(false);
      menuRef.current?.removeAttribute("open");
      window.location.assign("/");
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "无法创建工作区");
    } finally {
      setSavingWorkspace(false);
    }
  }

  const selected = session.selectedWorkspace;
  const healthLabel = health === "ok" ? "SYSTEM ONLINE" : health === "degraded" ? "SYSTEM LIMITED" : "SYSTEM SYNCING";
  return (
    <div className="app-shell">
      <aside className="shell-sidebar">
        <Link aria-label="DeviLudo 首页" className="brand" href="/">
          <span className="brand-mark"><Image alt="" height={36} priority src="/deviludo-brand-mark.png" width={36} /></span>
          <span className="brand-copy"><b>DeviLudo</b><small>GAMEFORGE OS</small></span>
        </Link>

        <details className="workspace-menu" ref={menuRef}>
          <summary aria-label="选择工作区" className="workspace-switcher">
            <span aria-hidden="true" className={`workspace-avatar ${selected ? "" : "workspace-avatar-empty"}`}>
              {selected ? workspaceMonogram(selected.name) : <GridIcon />}
            </span>
            <span><b>{selected?.name ?? "未选择工作区"}</b><small>{selected ? "当前工作区" : "选择或新建工作区"}</small></span>
            <span aria-hidden="true" className="workspace-chevron">⌄</span>
          </summary>
          <div aria-label="工作区菜单" className="workspace-dropdown" role="menu">
            {workspaces.map(workspace => (
              <button className={`workspace-option ${workspace.id === selected?.id ? "is-selected" : ""}`} key={workspace.id} onClick={() => void selectWorkspace(workspace.id)} role="menuitem" type="button">
                <span className="workspace-add-icon">{workspaceMonogram(workspace.name)}</span>
                <span><b>{workspace.name}</b><small>{workspace.id === selected?.id ? "当前工作区" : "切换到此工作区"}</small></span>
              </button>
            ))}
            <button className="workspace-add-option" onClick={() => setAdding(true)} role="menuitem" type="button">
              <span className="workspace-add-icon"><PlusIcon /></span>
              <b>添加工作区</b>
            </button>
            {selected ? <button className="workspace-clear-option" onClick={() => void clearWorkspace()} role="menuitem" type="button">退出当前工作区</button> : null}
            {workspaceError ? <p className="workspace-menu-error" role="alert">{workspaceError}</p> : null}
          </div>
        </details>

        <nav aria-label="主要导航" className="shell-nav">
          <Link className={`shell-nav-item shell-home-entry ${pathname === "/" ? "is-active" : ""}`} href="/">
            <HomeIcon /><span>首页</span>{pathname === "/" ? <i aria-hidden="true" /> : null}
          </Link>
          <Link className={`shell-nav-item ${pathname.startsWith("/projects") ? "is-active" : ""}`} href="/projects">
            <GamepadIcon /><span>项目</span>{pathname.startsWith("/projects") ? <i aria-hidden="true" /> : null}
          </Link>
          <p>CONFIG / 配置</p>
          <Link className={`shell-nav-item ${pathname.startsWith("/settings") ? "is-active" : ""}`} href="/settings">
            <SettingsIcon /><span>设置</span>{pathname.startsWith("/settings") ? <i aria-hidden="true" /> : null}
          </Link>
          <Link className={`shell-nav-item ${pathname.startsWith("/admin/server-pools") ? "is-active" : ""}`} href="/admin/server-pools">
            <ServerIcon /><span>运行状态</span>{pathname.startsWith("/admin/server-pools") ? <i aria-hidden="true" /> : null}
          </Link>
        </nav>
      </aside>

      <div className="shell-main">
        <header className="shell-topbar">
          <div className="topbar-context"><span className="topbar-mode">COMMAND CENTER</span><span>{selected?.name ?? "未选择工作区"}</span></div>
          <div className="topbar-actions">
            <span aria-live="polite" className={`system-pill is-${health}`}><i /> {healthLabel}</span>
            <button aria-label="通知" className="icon-button" type="button"><BellIcon /></button>
          </div>
        </header>
        <main className="shell-content">{children}</main>
      </div>

      {adding ? (
        <div className="workspace-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setAdding(false); }}>
          <section aria-labelledby="workspace-dialog-title" aria-modal="true" className="workspace-dialog" role="dialog">
            <span className="eyebrow">NEW WORKSPACE</span>
            <h2 id="workspace-dialog-title">新建工作区</h2>
            <form onSubmit={createWorkspace}>
              <label>工作区名称<input autoFocus maxLength={200} onChange={event => setWorkspaceName(event.target.value)} placeholder="输入工作区名称" value={workspaceName} /></label>
              <div><button className="button button-secondary" onClick={() => setAdding(false)} type="button">取消</button><button className="button button-acid" disabled={!workspaceName.trim() || savingWorkspace} type="submit">{savingWorkspace ? "正在创建…" : "创建工作区"}</button></div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function workspaceMonogram(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join("").toUpperCase() || "--";
}
