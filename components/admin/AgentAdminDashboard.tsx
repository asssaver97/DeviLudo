"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { LocalAgentReadiness, LocalHealth } from "@/components/console/useLocalPlatform";
import { agentAdminCapabilities } from "@/lib/admin/agent-permissions";
import {
  builtInAgentUi,
  rolePermissions,
  trustedAgentVersionUrl,
  type AdminRole,
  type AgentCatalogItem,
  type AgentKind,
  type AgentVersionRow,
  type AuditEvent,
} from "@/lib/admin/agent-ui";
import { isAdapterVersionAttested } from "@/lib/agent/adapter-registry";
import { AdminIcon, type AdminIconName } from "./AdminIcons";
import styles from "./admin.module.css";

type TabId = "overview" | "versions" | "deployments" | "providers" | "inheritance" | "audit";
type Toast = { message: string; tone: "success" | "warning" | "neutral" } | null;
type AgentInstallation = {
  id: string;
  agent: AgentKind;
  version: string;
  workerPool: string;
  adapterVersion: string;
  imageDigest: string | null;
  buildReceiptId: string | null;
  runtimeBinding: {
    backend: "firecracker-jailer";
    launcherReleaseId: string;
    guestReleaseId: string;
    workerBindingDigest: string;
  } | null;
  fleetHealth: {
    registeredWorkers: number;
    readyWorkers: number;
    observedAt: string;
  } | null;
  state: string;
  health: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  rolloutPercent: number;
  rollbackInstallationId?: string | null;
  createdAt?: string;
  activatedAt?: string | null;
  drainingAt?: string | null;
  retiredAt?: string | null;
  failure?: {
    failureCode: string;
    evidenceDigest: string;
    failureReceiptId: string;
    failureReceiptDigest: string;
    failedAt: string;
  };
};
type AdminState = {
  catalog: AgentCatalogItem[];
  defaultAgent: AgentKind;
  versions: AgentVersionRow[];
  installations: AgentInstallation[];
  rollouts: Record<string, { percent: number; state: string; previous: number }>;
  profiles: Array<{
    id: string;
    revision: number | null;
    agent: AgentKind;
    scope: string;
    scopeId: string;
    state: string;
    installationId: string;
    providerRevisionId: string;
    fallbackProfileRevisionId: string | null;
    budget: { maxUsd: number | null; maxTurns: number | null; timeoutSeconds: number | null };
  }>;
  providers: Array<{
    id: string;
    agent: AgentKind;
    protocol: string;
    baseUrl: string;
    primaryModel: string;
    models: { primaryModel: string; planningModel: string; smallFastModel: string; subagentModel: string };
    pricing: { inputUsdPerMillionTokens: number | null; outputUsdPerMillionTokens: number | null };
    governance: { dataRegion: string | null; retentionPolicy: string | null; trainingPolicy: string | null; confirmedBy: string | null; confirmedAt: string | null };
    credentialVersionId: string;
    state: string;
  }>;
  credentials: Array<{
    id: string;
    label: string;
    maskedFingerprint: string;
    version: number | null;
    state: string;
    createdAt: string | null;
    rotatedAt: string | null;
    lastUsedAt: string | null;
  }>;
  defaults: Record<string, string>;
};
type AgentHealth = {
  status: "HEALTHY" | "DEGRADED";
  usage: {
    available: boolean;
    source: "inference_usage_events";
    windowStartedAt: string;
    totals: { requests: number; inputTokens: number; outputTokens: number; costUsd: number };
    records: Array<{
      requestId: string;
      tenantId: string;
      projectId: string;
      runId: string;
      providerRevisionId: string;
      credentialVersionId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      recordedAt: string;
    }>;
  };
  configurationDiffs: Array<{
    id: string;
    action: string;
    resource: string;
    actorId: string;
    at: string;
    changes: Array<{ field: string; before: unknown; after: unknown }>;
  }>;
  alerts: Array<{
    id: string;
    severity: "WARNING" | "CRITICAL";
    code: string;
    resource: string;
    message: string;
  }>;
  checkedAt: string;
};

async function adminRequest<T>(
  path: string,
  options: { method?: "POST" | "PUT"; role?: AdminRole; body?: Record<string, unknown> } = {},
): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, {
    method: options.method ?? "GET",
    cache: "no-store",
    headers: options.method ? {
      "content-type": "application/json",
      "idempotency-key": `admin-ui-${crypto.randomUUID()}`,
      ...(isLoopbackBrowser() ? { "x-deviludo-role": options.role ?? "Auditor" } : {}),
    } : undefined,
    body: options.method ? JSON.stringify(options.body ?? {}) : undefined,
  });
  const payload = await response.json() as { data?: T; meta?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? `管理 API 返回 ${response.status}`);
  return (payload.data ?? payload.meta) as T;
}

const tabs: { id: TabId; label: string }[] = [
  { id: "overview", label: "总览" },
  { id: "versions", label: "版本" },
  { id: "deployments", label: "安装部署" },
  { id: "providers", label: "Provider" },
  { id: "inheritance", label: "选择与继承" },
  { id: "audit", label: "健康与审计" },
];

const navGroups: { label: string; items: { label: string; icon: AdminIconName; active?: boolean; badge?: string }[] }[] = [
  {
    label: "工作空间",
    items: [
      { label: "运行概览", icon: "activity" },
      { label: "项目", icon: "projects" },
      { label: "构建与测试", icon: "runners" },
      { label: "发行", icon: "releases" },
    ],
  },
  {
    label: "平台治理",
    items: [
      { label: "Agents", icon: "agents", active: true },
      { label: "凭据与策略", icon: "shield" },
      { label: "审计日志", icon: "audit" },
      { label: "平台设置", icon: "settings" },
    ],
  },
];

const roleOptions = Object.keys(rolePermissions) as AdminRole[];
type AdminAuthMode = "loading" | "local-fixture" | "trusted-control-plane";
const EXACT_AGENT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function AgentMark({ kind, small = false }: { kind: AgentKind; small?: boolean }) {
  return (
    <span className={`${styles.agentMark} ${kind === "claude-code" ? styles.claudeMark : styles.codexMark} ${small ? styles.agentMarkSmall : ""}`}>
      {kind === "claude-code" ? "C" : "⌁"}
    </span>
  );
}

function StatusPill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "success" | "warning" | "danger" | "neutral" | "info" }) {
  return <span className={`${styles.statusPill} ${styles[`status_${tone}`]}`}>{children}</span>;
}

function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className={styles.sectionHeading}>
      <div>
        {eyebrow && <div className={styles.eyebrow}>{eyebrow}</div>}
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}

export default function AgentAdminDashboard() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [role, setRole] = useState<AdminRole>("PlatformAgentAdmin");
  const [defaultAgent, setDefaultAgent] = useState<AgentKind>("claude-code");
  const [catalog, setCatalog] = useState<AgentCatalogItem[]>([]);
  const [versions, setVersions] = useState<AgentVersionRow[]>([]);
  const [installations, setInstallations] = useState<AgentInstallation[]>([]);
  const [profiles, setProfiles] = useState<AdminState["profiles"]>([]);
  const [providers, setProviders] = useState<AdminState["providers"]>([]);
  const [credentials, setCredentials] = useState<AdminState["credentials"]>([]);
  const [defaults, setDefaults] = useState<AdminState["defaults"]>({});
  const [authMode, setAuthMode] = useState<AdminAuthMode>("loading");
  const [adminLoading, setAdminLoading] = useState(true);
  const [adminError, setAdminError] = useState("");
  const [discoveryAgent, setDiscoveryAgent] = useState<AgentKind>("claude-code");
  const [discoveryVersion, setDiscoveryVersion] = useState("");
  const [toast, setToast] = useState<Toast>(null);
  const [auditFilter, setAuditFilter] = useState("全部事件");
  const [auditRecords, setAuditRecords] = useState<AuditEvent[]>([]);
  const [localHealth, setLocalHealth] = useState<LocalHealth | null>(null);
  const [agentHealth, setAgentHealth] = useState<AgentHealth | null>(null);
  const [newProviderRequest, setNewProviderRequest] = useState("");
  const [providerEditorKey, setProviderEditorKey] = useState("provider-editor");

  const refreshAdminState = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/agents", { cache: "no-store" });
      const payload = await response.json() as Record<string, unknown> & { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "读取 Agent 管理状态失败");
      const state = normalizeAdminState(payload);
      setCatalog(state.catalog);
      setDefaultAgent(state.defaultAgent);
      setVersions(state.versions);
      setProfiles(state.profiles);
      setProviders(state.providers);
      setCredentials(state.credentials);
      setDefaults(state.defaults);
      setInstallations(state.installations.map((installation) => {
        const rollout = state.rollouts[installation.id];
        return rollout ? { ...installation, rolloutPercent: rollout.percent, state: rollout.state } : installation;
      }));
      const mode = response.headers.get("x-deviludo-admin-auth-mode");
      if (mode === "local-fixture" || mode === "trusted-control-plane") setAuthMode(mode);
      const effectiveRole = response.headers.get("x-deviludo-effective-role");
      if (mode === "trusted-control-plane" && isAdminRole(effectiveRole)) setRole(effectiveRole);
      setAdminError("");
    } catch (reason) {
      setAdminError(reason instanceof Error ? reason.message : "读取 Agent 管理状态失败");
      throw reason;
    } finally {
      setAdminLoading(false);
    }
  }, []);

  const refreshAudit = useCallback(async () => {
    const response = await fetch("/api/admin/audit", { cache: "no-store" });
    const payload = await response.json() as { data?: unknown } | unknown[];
    const records = Array.isArray(payload) ? payload : payload.data;
    if (!response.ok || !Array.isArray(records)) return;
    const live = records.map((value) => value as { id: string; action: string; resource: string; actor?: string; actorId?: string; actorRole?: string; at: string; metadata: Record<string, unknown> }).map<AuditEvent>((entry) => ({
      id: entry.id,
      at: new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false }),
      actor: entry.actor ?? entry.actorId ?? "trusted/session",
      role: entry.actorRole ?? entry.actor ?? "Auditor",
      action: entry.action,
      target: entry.resource,
      detail: Object.entries(entry.metadata).map(([key, value]) => `${key}=${String(value)}`).join(" · ") || "不可变管理事件",
      tone: /BLOCK|ROLLBACK|REVOKE|FAIL/i.test(entry.action) ? "warning" : /APPROVE|ACTIVE|CREATED|UPDATED/i.test(entry.action) ? "success" : "neutral",
    }));
    setAuditRecords(live);
  }, []);

  const refreshAgentHealth = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/admin/agent-health", { cache: "no-store", signal });
      const payload = await response.json() as { data?: unknown } | AgentHealth;
      if (!response.ok) return;
      const value = "data" in payload && payload.data ? payload.data : payload;
      setAgentHealth(normalizeAgentHealth(value));
    } catch {
      // The last authoritative projection remains visible during a transient poll failure.
    }
  }, []);

  const refreshLocalHealth = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/health", { cache: "no-store", signal });
      if (!response.ok) return;
      setLocalHealth(await response.json() as LocalHealth);
    } catch {
      // The page remains usable when the optional localhost probes are offline.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => {
      void refreshLocalHealth(controller.signal);
      void refreshAgentHealth(controller.signal);
    }, 0);
    const timer = window.setInterval(() => {
      void refreshLocalHealth(controller.signal);
      void refreshAgentHealth(controller.signal);
    }, 4_000);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refreshAgentHealth, refreshLocalHealth]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refreshAdminState().catch(() => undefined);
      void refreshAudit();
    }, 0);
    return () => window.clearTimeout(initial);
  }, [refreshAdminState, refreshAudit]);

  const localAgents = localHealth?.dependencies?.localAgents ?? [];
  const executionReady = localHealth?.dependencies?.developmentWorker === "READY";

  const notify = (message: string, tone: NonNullable<Toast>["tone"] = "success") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 3400);
  };

  const effectivePermissionRole: AdminRole = authMode === "loading" ? "Auditor" : role;
  const permissions = agentAdminCapabilities(effectivePermissionRole);
  const canOperateVersions = permissions.manageVersions && !adminLoading && !adminError;
  const consumeNewProviderRequest = useCallback((requestId: string) => {
    setNewProviderRequest((current) => current === requestId ? "" : current);
  }, []);

  const updateVersion = async (id: string, status: AgentVersionRow["status"]) => {
    if (!canOperateVersions) {
      notify("当前角色没有版本治理权限", "warning");
      return;
    }
    const row = versions.find((item) => item.id === id);
    if (!row) return;
    try {
      const action = status === "APPROVED" ? "approve" : status === "DEPRECATED" ? "deprecate" : "block";
      await adminRequest(`agent-versions/${action}`, {
        method: "POST",
        role,
        body: { id: `${row.agent}@${row.version}` },
      });
      await refreshAdminState();
      await refreshAudit();
      notify(status === "APPROVED" ? "版本已批准，可用于构建 WorkerImage"
        : status === "DEPRECATED" ? "版本已弃用；现有安装与运行任务不受影响，新镜像构建已禁止"
          : "版本已阻止并写入本地审计");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "版本治理失败", "warning");
    }
  };

  const installVersion = async (id: string) => {
    if (!permissions.manageInstallations) {
      notify("当前角色不能构建 Agent WorkerImage", "warning");
      return;
    }
    const row = versions.find((item) => item.id === id);
    const registry = row ? catalog.find((item) => item.id === row.agent) : undefined;
    if (!row || !registry) return;
    try {
      await adminRequest("agent-installations", {
        method: "POST",
        role,
        body: {
          agent: row.agent,
          version: row.version,
          workerPool: row.agent === "claude-code" ? "dev-linux-a" : "dev-linux-b",
          adapterVersion: registry.adapterVersion,
        },
      });
      await refreshAdminState();
      await refreshAudit();
      setActiveTab("deployments");
      notify("供应链 Broker 已生成不可变 WorkerImage；等待 5% canary");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "WorkerImage 构建失败", "warning");
    }
  };

  const advanceRollout = async (installationId: string) => {
    if (!canOperateVersions) {
      notify("切换为 PlatformAgentAdmin 后可推进灰度", "warning");
      return;
    }
    try {
      const result = await adminRequest<{ percent?: number; installation?: { rolloutPercent: number } }>(`agent-rollouts/${installationId}/advance`, { method: "POST", role });
      await refreshAdminState();
      await refreshAudit();
      const percent = result.percent ?? result.installation?.rolloutPercent;
      notify(percent === 100 ? "新版本已切换至 100%，仅影响新任务" : `灰度已推进至 ${percent ?? "下一阶段"}%`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "推进灰度失败", "warning");
    }
  };

  const rollback = async (installationId: string) => {
    if (!canOperateVersions) {
      notify("当前角色不能执行回滚", "warning");
      return;
    }
    try {
      await adminRequest(`agent-rollouts/${installationId}/rollback`, { method: "POST", role });
      await refreshAdminState();
      await refreshAudit();
      notify("已停止扩散；运行中任务继续使用原锁定版本", "warning");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "回滚失败", "warning");
    }
  };

  const transitionInstallation = async (installationId: string, action: "drain" | "retire") => {
    if (!canOperateVersions) {
      notify("当前角色不能变更 Installation 生命周期", "warning");
      return;
    }
    try {
      await adminRequest(`agent-installations/${installationId}/${action}`, { method: "POST", role });
      await refreshAdminState();
      await refreshAudit();
      notify(action === "drain"
        ? "已停止分配新任务；运行中任务继续使用锁定镜像"
        : "Installation 已退役并保留为不可变历史记录", action === "drain" ? "warning" : "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : action === "drain" ? "排空失败" : "退役失败", "warning");
    }
  };

  const rebindInstallationProfile = async (installationId: string) => {
    if (!permissions.manageInstallations) {
      notify("需要 PlatformAgentAdmin 为升级安装生成新 Profile", "warning");
      return;
    }
    const installation = installations.find((item) => item.id === installationId);
    const candidates = profiles.filter((profile) => profile.agent === installation?.agent
      && profile.scope === "platform" && profile.scopeId === "global" && profile.state === "ACTIVE"
      && profile.installationId !== installationId);
    const source = candidates.find((profile) => defaults.platform === profile.id) ?? candidates[0];
    if (!source) {
      notify("没有可复用的 ACTIVE 平台 Profile；请先配置并激活 Provider", "warning");
      return;
    }
    try {
      await adminRequest(`agent-profiles/${encodeURIComponent(source.id)}/rebind-installation`, {
        method: "POST",
        role,
        body: { installationId },
      });
      await refreshAdminState();
      await refreshAudit();
      notify("升级 Profile 已生成并锁定新镜像；等待 SecurityAdmin 激活", "neutral");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "升级 Profile 生成失败", "warning");
    }
  };

  const activateInstallationProfile = async (profileId: string) => {
    if (!permissions.activatePlatformProvider) {
      notify("升级 Profile 激活需要 SecurityAdmin", "warning");
      return;
    }
    try {
      await adminRequest(`agent-profiles/${encodeURIComponent(profileId)}/activate`, { method: "POST", role });
      await refreshAdminState();
      await refreshAudit();
      notify("升级 Profile 已激活；默认选择尚未改变", "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "升级 Profile 激活失败", "warning");
    }
  };

  const selectPlatformProfile = async (profileId: string) => {
    if (!permissions.changePlatformDefault) {
      notify("切换平台默认需要 PlatformAgentAdmin", "warning");
      return;
    }
    try {
      await adminRequest("agent-defaults/platform", { method: "PUT", role, body: { profileRevisionId: profileId } });
      await refreshAdminState();
      await refreshAudit();
      notify("平台默认已精确切换到升级 Profile，仅影响新任务");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "平台默认切换失败", "warning");
    }
  };

  const changeDefaultAgent = async (agent: AgentKind) => {
    if (!canOperateVersions) {
      notify("仅 PlatformAgentAdmin 可修改全局默认", "warning");
      return;
    }
    const profileRevisionId = profiles.find((profile) => profile.agent === agent && profile.scope === "platform"
      && profile.scopeId === "global" && profile.state === "ACTIVE")?.id;
    if (!profileRevisionId) { notify("该 Agent 尚无可设为默认的 ACTIVE 平台 Profile", "warning"); return; }
    try {
      await adminRequest("agent-defaults/platform", { method: "PUT", role, body: { profileRevisionId } });
      await refreshAdminState();
      await refreshAudit();
      notify(`${agent === "claude-code" ? "Claude Code" : "Codex CLI"} 已设为平台默认，仅影响新任务`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "默认 Agent 更新失败", "warning");
    }
  };

  const discoverVersions = async (agent: AgentKind) => {
    if (!canOperateVersions) {
      notify("仅 PlatformAgentAdmin 可发现版本", "warning");
      return;
    }
    const observedVersion = localAgents.find((item) => item.agent === agent)?.observedVersion ?? "";
    const requestedVersion = discoveryVersion.trim() || (authMode === "local-fixture" ? observedVersion : "");
    if (requestedVersion && (!EXACT_AGENT_VERSION.test(requestedVersion) || /latest|stable|default/i.test(requestedVersion))) {
      notify("请输入精确版本号，例如 2.1.201 或 0.145.0-alpha.18", "warning");
      return;
    }
    try {
      await adminRequest("agent-versions/discover", {
        method: "POST",
        role,
        body: { agent, ...(requestedVersion ? { version: requestedVersion } : {}) },
      });
      await refreshAdminState();
      await refreshAudit();
      setActiveTab("versions");
      if (requestedVersion) setDiscoveryVersion(requestedVersion);
      notify(`${agent === "claude-code" ? "Claude Code" : "Codex CLI"} ${requestedVersion || "官方最新候选"}已写入版本目录；不会自动激活`, "neutral");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "版本发现失败", "warning");
    }
  };

  return (
    <div className={styles.appShell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.brandGlyph} aria-hidden="true"><span /><span /><span /><span /></div>
          <div><strong>DeviLudo</strong><small>CONTROL PLANE</small></div>
        </div>

        <nav className={styles.nav} aria-label="管理后台导航">
          {navGroups.map((group) => (
            <div className={styles.navGroup} key={group.label}>
              <div className={styles.navLabel}>{group.label}</div>
              {group.items.map((item) => (
                <button className={`${styles.navItem} ${item.active ? styles.navItemActive : ""}`} key={item.label} type="button">
                  <AdminIcon name={item.icon} />
                  <span>{item.label}</span>
                  {item.badge && <em>{item.badge}</em>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.systemHealth}><span className={executionReady ? "" : styles.healthDotWarning} />{executionReady ? "本地 Agent Worker 就绪" : "本地 Agent 执行受门禁保护"}</div>
          <div className={styles.userBlock}>
            <div className={styles.avatar}>{authMode === "local-fixture" ? "LT" : "TA"}</div>
            <div><strong>{authMode === "local-fixture" ? "本地测试会话" : "可信管理员会话"}</strong><small>{authMode === "loading" ? "验证中" : role}</small></div>
            <AdminIcon name="more" />
          </div>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}><span>平台</span><AdminIcon name="chevron" /><span>管理</span><AdminIcon name="chevron" /><strong>Agents</strong></div>
          <div className={styles.topActions}>
            <div className={styles.environment}><span />{authMode === "trusted-control-plane" ? "生产控制面" : authMode === "local-fixture" ? "本地测试环境" : "正在验证管理入口"}</div>
            <button className={styles.iconButton} type="button" aria-label="搜索"><AdminIcon name="search" /></button>
            <button className={`${styles.iconButton} ${styles.bellButton}`} type="button" aria-label="通知"><AdminIcon name="bell" /><span /></button>
            {authMode !== "local-fixture" ? <div className={styles.roleSelect}><span>{authMode === "loading" ? "身份" : "可信角色"}</span><strong>{authMode === "loading" ? "验证中" : role}</strong></div> : <label className={styles.roleSelect}>
              <span>模拟角色</span>
              <select value={role} onChange={(event) => setRole(event.target.value as AdminRole)} aria-label="切换管理角色">
                {roleOptions.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>}
          </div>
        </header>

        <div className={styles.pageHeader}>
          <div>
            <div className={styles.titleRow}><h1>Agent 运维台</h1><StatusPill tone={executionReady ? "success" : "warning"}>{executionReady ? "本机可执行" : "本机执行已阻止"}</StatusPill></div>
            <p>治理开发 Agent 的版本、部署、Provider 与配置继承。运行时锁定配置，不受后续变更影响。</p>
          </div>
          <div className={styles.headerActions}>
            <label className={styles.discoveryControl}><span>官方目录</span><select aria-label="选择要发现版本的 Agent" value={discoveryAgent} onChange={(event) => { setDiscoveryAgent(event.target.value as AgentKind); setDiscoveryVersion(""); }}><option value="claude-code">Claude Code</option><option value="codex-cli">Codex CLI</option></select></label>
            <label className={styles.discoveryControl}><span>精确版本（可选）</span><input aria-label="要发现的精确 Agent 版本" value={discoveryVersion} onChange={(event) => setDiscoveryVersion(event.target.value)} placeholder={localAgents.find((item) => item.agent === discoveryAgent)?.observedVersion ?? "留空发现官方最新"} autoComplete="off" maxLength={120} /></label>
            <button className={styles.secondaryButton} type="button" onClick={() => void discoverVersions(discoveryAgent)} disabled={!permissions.manageVersions || adminLoading || Boolean(adminError)} title={permissions.manageVersions ? undefined : "需要 PlatformAgentAdmin 权限"}><AdminIcon name="refresh" />发现版本</button>
            <button className={styles.primaryButton} type="button" onClick={() => {
              const requestId = crypto.randomUUID();
              setProviderEditorKey(requestId);
              setNewProviderRequest(requestId);
              setActiveTab("providers");
              notify("已创建空白 Provider 草稿", "neutral");
            }} disabled={!permissions.editPlatformProvider} title={permissions.editPlatformProvider ? undefined : "当前角色不能编辑平台级 Provider"}>新建 Provider</button>
          </div>
        </div>

        <div className={styles.securityStrip}>
          <AdminIcon name="shield" />
          <div><strong>隔离策略已启用</strong><span>Agent 仅部署到一次性 Linux 开发 Worker；E2E Runner 与 Steam 发布节点不安装自主 Agent。</span></div>
          <button type="button" onClick={() => setActiveTab("inheritance")}>查看策略 <AdminIcon name="chevron" /></button>
        </div>

        {adminLoading ? <div className={styles.adminStateNotice}><AdminIcon name="refresh" />正在读取权威 Agent 目录、版本与安装投影…</div> : null}
        {adminError ? <div className={`${styles.adminStateNotice} ${styles.adminStateError}`} role="alert"><AdminIcon name="alert" /><span>{adminError}。页面不会以演示版本或扫描结果回退。</span><button type="button" onClick={() => { setAdminLoading(true); void refreshAdminState().catch(() => undefined); }}>重试</button></div> : null}

        <div className={styles.tabs} role="tablist" aria-label="Agent 管理分区">
          {tabs.map((tab) => {
            const count = tab.id === "versions" ? String(versions.length) : tab.id === "deployments" ? String(installations.length)
              : tab.id === "providers" ? String(providers.length) : undefined;
            return <button key={tab.id} className={activeTab === tab.id ? styles.tabActive : ""} onClick={() => setActiveTab(tab.id)} type="button" role="tab" aria-selected={activeTab === tab.id}>
              {tab.label}{count && <span>{count}</span>}
            </button>;
          })}
        </div>

        <div className={styles.content}>
          {activeTab === "overview" && <OverviewTab catalog={catalog} versions={versions} installations={installations} defaultAgent={defaultAgent} localAgents={localAgents} localHealth={localHealth} canChangeDefault={permissions.changePlatformDefault && !adminLoading && !adminError} onDefaultChange={(agent) => void changeDefaultAgent(agent)} onNavigate={setActiveTab} />}
          {activeTab === "versions" && <VersionsTab rows={versions} installations={installations} canOperate={canOperateVersions} onUpdate={updateVersion} onInstall={installVersion} />}
          {activeTab === "deployments" && <DeploymentsTab installations={installations} profiles={profiles} defaults={defaults}
            localFixture={authMode === "local-fixture"}
            canOperate={permissions.manageInstallations && !adminLoading && !adminError}
            canActivateProfile={permissions.activatePlatformProvider && !adminLoading && !adminError}
            canChangeDefault={permissions.changePlatformDefault && !adminLoading && !adminError}
            onAdvance={advanceRollout} onRollback={rollback} onLifecycle={transitionInstallation}
            onRebindProfile={rebindInstallationProfile} onActivateProfile={activateInstallationProfile}
            onSelectDefault={selectPlatformProfile} />}
          {activeTab === "providers" && <ProvidersTab key={providerEditorKey} role={effectivePermissionRole} localHealth={localHealth} installations={installations} profiles={profiles}
            providers={providers} credentials={credentials}
            production={authMode === "trusted-control-plane"} notify={notify} onChanged={() => { void refreshAdminState(); void refreshAudit(); }}
            newDraftRequest={newProviderRequest} onNewDraftConsumed={consumeNewProviderRequest} />}
          {activeTab === "inheritance" && <InheritanceTab defaults={defaults} installations={installations}
            profiles={profiles} providers={providers} notify={notify} />}
          {activeTab === "audit" && <AuditTab events={auditRecords} filter={auditFilter} localHealth={localHealth} agentHealth={agentHealth} setFilter={setAuditFilter} />}
        </div>
      </main>

      {toast && (
        <div className={`${styles.toast} ${styles[`toast_${toast.tone}`]}`} role="status">
          <span>{toast.tone === "warning" ? "!" : "✓"}</span>{toast.message}
          <button type="button" onClick={() => setToast(null)} aria-label="关闭提示"><AdminIcon name="close" /></button>
        </div>
      )}
    </div>
  );
}

function OverviewTab({ catalog, versions, installations, defaultAgent, localAgents, localHealth, canChangeDefault, onDefaultChange, onNavigate }: {
  catalog: AgentCatalogItem[];
  versions: AgentVersionRow[];
  installations: AgentInstallation[];
  defaultAgent: AgentKind;
  localAgents: LocalAgentReadiness[];
  localHealth: LocalHealth | null;
  canChangeDefault: boolean;
  onDefaultChange: (agent: AgentKind) => void;
  onNavigate: (tab: TabId) => void;
}) {
  const exactMatches = localAgents.filter((agent) => agent.state === "READY").length;
  const workerReady = localHealth?.dependencies?.developmentWorker === "READY";
  return (
    <>
      <div className={styles.metricRail}>
        <div><span>本机 Agent 发现</span><strong>{localAgents.length} / 2</strong><small>只读版本探针</small></div>
        <div><span>精确版本匹配</span><strong>{exactMatches} / 2</strong><small>{exactMatches === 2 ? "均匹配锁定版本" : "不匹配时禁止启动"}</small></div>
        <div><span>Inference Gateway</span><strong>{localHealth?.dependencies?.inferenceGateway === "CONFIGURED" ? "已配置" : "未配置"}</strong><small>长期 Key 不下发 Worker</small></div>
        <div><span>开发 Worker</span><strong>{workerReady ? "READY" : "BLOCKED"}</strong><small>{workerReady ? "镜像与执行门禁已满足" : localHealth?.dependencies?.workerIdentityMode === "LOCAL_DETERMINISTIC" ? "本机安装可校验，等待 Provider 与执行授权" : "等待版本、镜像与 Gateway"}</small></div>
      </div>
      {localHealth?.dependencies?.agentCatalogVerified === false ? <div className={styles.permissionNotice}><AdminIcon name="shield" />生效默认 Profile 与版本、安装或 Provider 证据不一致；开发 Worker 已阻断。</div> : null}

      <section className={styles.section}>
        <SectionHeading title="Agent 目录" description="首版仅支持经平台签名的两种内置 Agent；每个 WorkerImage 只包含一种 Agent。" action={<button className={styles.textButton} type="button" onClick={() => onNavigate("versions")}>管理版本 <AdminIcon name="chevron" /></button>} />
        <div className={styles.agentCatalog}>
          {catalog.map((agent) => {
            const approvedVersions = versions.filter((version) => version.agent === agent.id && version.status === "APPROVED").map((version) => version.version);
            const installation = installations.find((item) => item.agent === agent.id && item.state === "ACTIVE")
              ?? installations.find((item) => item.agent === agent.id && item.state === "READY");
            return (
            <article className={`${styles.agentRow} ${defaultAgent === agent.id ? styles.agentRowDefault : ""}`} key={agent.id}>
              <AgentMark kind={agent.id} />
              <div className={styles.agentIdentity}>
                <div><h3>{agent.name}</h3><span>{agent.vendor}</span>{defaultAgent === agent.id && <StatusPill tone="info">平台默认</StatusPill>}</div>
                <p>{agent.description}</p>
                <a href={agent.officialSource} target="_blank" rel="noreferrer">{new URL(agent.officialSource).host}<AdminIcon name="external" /></a>
              </div>
              <div className={styles.agentMeta}>
                <span>已批准版本</span><strong>{approvedVersions.join(" · ") || "尚无"}</strong><small>{installation ? `adapter ${installation.adapterVersion}` : "等待可信安装"}</small>
                <small>{agent.adapterId}@{agent.adapterVersion} · {agent.providerProtocol}</small>
              </div>
              <div className={styles.capabilities}>
                {agent.capabilities.map((capability) => <span key={capability}>{capability}</span>)}
                <small>{agent.supportedWorkers.join(" · ")}</small>
              </div>
              <div className={styles.agentActions}>
                {defaultAgent === agent.id ? <button className={styles.selectedButton} type="button" disabled><AdminIcon name="check" />已选择</button> : <button className={styles.secondaryButton} type="button" onClick={() => onDefaultChange(agent.id)} disabled={!canChangeDefault} title={canChangeDefault ? undefined : "需要 PlatformAgentAdmin 权限"}>设为默认</button>}
                <button className={styles.moreButton} type="button" aria-label={`${agent.name} 更多操作`}><AdminIcon name="more" /></button>
              </div>
            </article>
            );
          })}
          {catalog.length === 0 ? <div className={styles.emptyState}>正在读取权威 Agent Registry；不会展示预置版本或安装状态。</div> : null}
        </div>
      </section>

      <div className={styles.twoColumn}>
        <section className={styles.section}>
          <SectionHeading eyebrow="LIVE" title="Worker 池健康" action={<button className={styles.textButton} type="button" onClick={() => onNavigate("deployments")}>查看部署 <AdminIcon name="chevron" /></button>} />
          <div className={styles.healthList}>
            {localAgents.map((agent) => (
              <div key={agent.agent}>
                <span className={agent.state === "READY" ? styles.healthDotGood : styles.healthDotWarning} />
                <strong>{agent.agent === "claude-code" ? "Claude Code" : "Codex CLI"}</strong>
                <span>{agent.observedVersion ?? "未安装"}</span>
                <em>{agent.state === "READY" ? "匹配生效 Profile 的精确版本" : `${agent.state} · 期望 ${(agent.expectedVersions ?? [agent.expectedVersion]).join(" / ")}`}</em>
              </div>
            ))}
            {localAgents.length === 0 && <div><span className={styles.healthDotMuted} /><strong>local-probe</strong><span>未连接</span><em>等待 127.0.0.1:4312</em></div>}
            <div><span className={styles.healthDotMuted} /><strong>e2e-runners</strong><span>无 Agent</span><em>策略隔离</em></div>
          </div>
        </section>
        <section className={styles.section}>
          <SectionHeading eyebrow="POLICY" title="当前运行约束" action={<StatusPill tone="success">已执行</StatusPill>} />
          <dl className={styles.policyList}>
            <div><dt>CLI 自更新</dt><dd>已禁用</dd></div>
            <div><dt>危险权限参数</dt><dd>已阻止</dd></div>
            <div><dt>任务配置锁定</dt><dd>Profile Revision</dd></div>
            <div><dt>Provider 故障</dt><dd>WAITING_PROVIDER</dd></div>
          </dl>
        </section>
      </div>
    </>
  );
}

function VersionsTab({ rows, installations, canOperate, onUpdate, onInstall }: {
  rows: AgentVersionRow[];
  installations: AgentInstallation[];
  canOperate: boolean;
  onUpdate: (id: string, status: AgentVersionRow["status"]) => void;
  onInstall: (id: string) => void;
}) {
  return (
    <section className={styles.section}>
      <SectionHeading title="版本目录" description="候选版本来自官方源。批准前必须完成签名、完整性、SBOM、漏洞与合成任务验证。" action={<StatusPill tone="neutral">自动发现 · 手动激活</StatusPill>} />
      {!canOperate && <div className={styles.permissionNotice}><AdminIcon name="shield" />当前角色为只读视图。切换至 PlatformAgentAdmin 批准或阻止版本。</div>}
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead><tr><th>Agent / 版本与来源</th><th>发现时间</th><th>完整性</th><th>Adapter 契约</th><th>SBOM</th><th>漏洞</th><th>状态</th><th><span className={styles.srOnly}>操作</span></th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td><div className={styles.tableAgent}><AgentMark kind={row.agent} small /><div><strong>{row.agent === "claude-code" ? "Claude Code" : "Codex CLI"}</strong><code>{row.version}</code><span className={styles.versionLinks}><a href={row.sourceUrl} target="_blank" rel="noreferrer noopener" aria-label={`打开 ${row.agent} ${row.version} 官方包来源`}>官方包</a><a href={row.releaseNotesUrl} target="_blank" rel="noreferrer noopener" aria-label={`打开 ${row.agent} ${row.version} 发行说明`}>发行说明</a></span></div></div></td>
                <td>{row.discoveredAt}</td><td><span className={row.integrity.includes("待") ? styles.pendingText : ""}>{row.integrity}</span></td>
                <td><span className={row.adapterAttested ? styles.goodText : styles.dangerText}>{row.adapterBinding}</span></td><td>{row.sbom}</td>
                <td><span className={row.vulnerabilities.includes("1 高危") ? styles.dangerText : styles.goodText}>{row.vulnerabilities}</span></td>
                <td><StatusPill tone={row.status === "APPROVED" ? "success" : row.status === "BLOCKED" || row.status === "REJECTED" ? "danger" : "warning"}>{row.status}</StatusPill></td>
                <td>
                  {row.status === "DISCOVERED" ? <div className={styles.inlineActions}><button type="button" onClick={() => onUpdate(row.id, "APPROVED")} disabled={!canOperate}>批准</button><button type="button" onClick={() => onUpdate(row.id, "BLOCKED")} disabled={!canOperate}>阻止</button></div> : row.status === "APPROVED" ? <div className={styles.inlineActions}><button type="button" onClick={() => onInstall(row.id)} disabled={!canOperate || !row.adapterAttested || installations.some((item) => item.agent === row.agent && item.version === row.version)}>{installations.some((item) => item.agent === row.agent && item.version === row.version) ? "已构建" : row.adapterAttested ? "构建镜像" : "需重新验证"}</button><button type="button" onClick={() => onUpdate(row.id, "DEPRECATED")} disabled={!canOperate}>弃用</button></div> : row.status === "DEPRECATED" ? <button type="button" onClick={() => onUpdate(row.id, "BLOCKED")} disabled={!canOperate}>阻止</button> : <button className={styles.moreButton} type="button"><AdminIcon name="more" /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.tableFooter}><span>显示 {rows.length} 个精确版本 · 无浮动通道</span><span>动态信息来自当前控制面投影</span></div>
    </section>
  );
}

function DeploymentsTab({ installations, profiles, defaults, canOperate, canActivateProfile, canChangeDefault,
  localFixture, onAdvance, onRollback, onLifecycle, onRebindProfile, onActivateProfile, onSelectDefault }: {
  installations: AgentInstallation[];
  profiles: AdminState["profiles"];
  defaults: AdminState["defaults"];
  localFixture: boolean;
  canOperate: boolean;
  canActivateProfile: boolean;
  canChangeDefault: boolean;
  onAdvance: (installationId: string) => void;
  onRollback: (installationId: string) => void;
  onLifecycle: (installationId: string, action: "drain" | "retire") => void;
  onRebindProfile: (installationId: string) => void;
  onActivateProfile: (profileId: string) => void;
  onSelectDefault: (profileId: string) => void;
}) {
  const trustedImageAvailable = installations.some((installation) => Boolean(installation.imageDigest && installation.buildReceiptId
      && (localFixture || installation.runtimeBinding && installation.fleetHealth && installation.fleetHealth.readyWorkers > 0))
    && installation.health === "HEALTHY" && ["READY", "CANARY", "ACTIVE"].includes(installation.state));
  return (
    <>
      <section className={styles.section}>
        <SectionHeading title="开发 Worker 安装" description="不可变镜像以 digest 部署；灰度只分配新任务，已运行任务继续使用锁定版本。" />
        {!canOperate && <div className={styles.permissionNotice}><AdminIcon name="shield" />当前角色只能查看部署。灰度、回滚与排空需要 PlatformAgentAdmin。</div>}
        {installations.map((installation) => {
          const percent = installation.rolloutPercent;
          const next = percent < 5 ? "5%" : percent < 25 ? "25%" : "100%";
          const platformProfiles = profiles.filter((profile) => profile.agent === installation.agent
            && profile.scope === "platform" && profile.scopeId === "global" && profile.installationId === installation.id);
          const readyProfile = platformProfiles.find((profile) => profile.state === "READY");
          const activeProfile = platformProfiles.find((profile) => profile.state === "ACTIVE");
          const hasSourceProfile = profiles.some((profile) => profile.agent === installation.agent
            && profile.scope === "platform" && profile.scopeId === "global" && profile.state === "ACTIVE"
            && profile.installationId !== installation.id);
          const runtimeReady = localFixture || Boolean(installation.runtimeBinding && installation.fleetHealth
            && installation.fleetHealth.readyWorkers > 0);
          const canCreateUpgradeProfile = installation.state === "ACTIVE" && installation.health === "HEALTHY"
            && percent === 100 && Boolean(installation.imageDigest && installation.buildReceiptId)
            && runtimeReady && hasSourceProfile && !readyProfile && !activeProfile;
          return (
            <div className={styles.installationRow} key={installation.id}>
              <AgentMark kind={installation.agent} />
              <div className={styles.installationIdentity}>
                <h3>{installation.agent === "claude-code" ? "Claude Code" : "Codex CLI"} {installation.version}</h3>
                <code>{installation.imageDigest ? `${installation.imageDigest.slice(0, 22)}…${installation.imageDigest.slice(-8)}` : "镜像未生成"}</code>
                <span>{installation.workerPool} · {installation.health} · adapter {installation.adapterVersion}</span>
                {installation.runtimeBinding && installation.fleetHealth ? (
                  <span>Firecracker microVM · Worker {installation.fleetHealth.readyWorkers}/{installation.fleetHealth.registeredWorkers} 就绪 · Launcher {installation.runtimeBinding.launcherReleaseId.slice(0, 8)} · Guest {installation.runtimeBinding.guestReleaseId.slice(0, 8)}</span>
                ) : localFixture
                  ? <span>LOCAL_DETERMINISTIC · 仅 loopback 本地测试，不作为生产 microVM 证明</span>
                  : <span>microVM 运行时证明未投影 · 禁止激活与分流</span>}
                <span>创建 {formatLifecycleTime(installation.createdAt)} · 激活 {formatLifecycleTime(installation.activatedAt)}</span>
                {(installation.drainingAt || installation.retiredAt) && <span>排空 {formatLifecycleTime(installation.drainingAt)} · 退役 {formatLifecycleTime(installation.retiredAt)}</span>}
                {installation.failure && (
                  <div className={styles.failureEvidence}>
                    <strong>{installation.failure.failureCode}</strong>
                    <span>证据 {installation.failure.evidenceDigest.slice(0, 12)}… · 回执 {installation.failure.failureReceiptId}</span>
                    <span>{installation.rollbackInstallationId ? `默认 Profile 已回退至 ${installation.rollbackInstallationId}` : "无可用回退安装；新任务保持停发"}</span>
                  </div>
                )}
              </div>
              <div className={styles.rolloutBlock}>
                <div><span>新任务流量</span><strong>{percent}%</strong><StatusPill tone={installation.state === "ACTIVE" ? "success" : installation.state === "QUARANTINED" || installation.state === "FAILED" ? "danger" : installation.state === "DRAINING" ? "warning" : "info"}>{installation.state}</StatusPill></div>
                <div className={styles.progressTrack}><span style={{ width: `${percent}%` }} /></div>
                <div className={styles.rolloutTicks}><span>5%</span><span>25%</span><span>100%</span></div>
              </div>
              <div className={styles.verticalActions}>
                <button className={styles.primaryButton} type="button" onClick={() => onAdvance(installation.id)} disabled={!canOperate || !["READY", "CANARY"].includes(installation.state) || percent === 100 || !installation.imageDigest || !runtimeReady}>推进至 {next}</button>
                <button className={styles.secondaryButton} type="button" onClick={() => onRollback(installation.id)} disabled={!canOperate || !["CANARY", "ACTIVE"].includes(installation.state) || percent === 0}>回滚</button>
                {installation.state === "ACTIVE" && <button className={styles.secondaryButton} type="button" onClick={() => onLifecycle(installation.id, "drain")} disabled={!canOperate}>排空</button>}
                {installation.state === "DRAINING" && <button className={styles.secondaryButton} type="button" onClick={() => onLifecycle(installation.id, "retire")} disabled={!canOperate}>确认退役</button>}
                {canCreateUpgradeProfile && <button className={styles.secondaryButton} type="button" onClick={() => onRebindProfile(installation.id)} disabled={!canOperate} title="复用已批准 Provider，不复制或暴露 API Key">生成升级 Profile</button>}
                {readyProfile && <button className={styles.primaryButton} type="button" onClick={() => onActivateProfile(readyProfile.id)} disabled={!canActivateProfile} title={canActivateProfile ? "激活后仍不会自动切换默认" : "需要 SecurityAdmin"}>激活升级 Profile</button>}
                {activeProfile && defaults.platform !== activeProfile.id && <button className={styles.primaryButton} type="button" onClick={() => onSelectDefault(activeProfile.id)} disabled={!canChangeDefault} title={canChangeDefault ? "仅影响新任务" : "需要 PlatformAgentAdmin"}>设为平台默认</button>}
                {activeProfile && defaults.platform === activeProfile.id && <StatusPill tone="success">当前默认 Profile</StatusPill>}
              </div>
            </div>
          );
        })}
        {installations.length === 0 && <div className={styles.emptyState}>尚无可信 WorkerImage。请先在版本目录批准并构建镜像。</div>}
      </section>
      <section className={styles.section}>
        <SectionHeading eyebrow="GATE" title="镜像晋级检查" description="所有检查均绑定精确 CLI、适配器与基础镜像 digest。" />
        <div className={styles.checkGrid}>
          {["官方签名与哈希", "SBOM 与许可证", "恶意软件扫描", "漏洞策略", "CLI / Adapter Contract", "沙箱逃逸测试", "合成代码任务", "无租户数据验证"].map((item) => <div key={item}><span className={trustedImageAvailable ? styles.checkDone : styles.checkRunning}>{trustedImageAvailable ? "✓" : "—"}</span><strong>{item}</strong><small>{trustedImageAvailable ? "供应链回执已绑定" : "等待可信 WorkerImage"}</small></div>)}
        </div>
      </section>
    </>
  );
}

function formatLifecycleTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "—";
}

function ProvidersTab({ role, localHealth, installations, profiles, providers, credentials, production, notify, onChanged,
  newDraftRequest, onNewDraftConsumed }: {
  role: AdminRole;
  localHealth: LocalHealth | null;
  installations: AgentInstallation[];
  profiles: AdminState["profiles"];
  providers: AdminState["providers"];
  credentials: AdminState["credentials"];
  production: boolean;
  notify: (message: string, tone?: "success" | "warning" | "neutral") => void;
  onChanged: () => void;
  newDraftRequest: string;
  onNewDraftConsumed: (requestId: string) => void;
}) {
  const initialProfile = profiles.find((item) => item.agent === "claude-code" && item.scope === "platform"
    && item.scopeId === "global" && item.state === "ACTIVE");
  const initialProvider = providers.find((item) => item.id === initialProfile?.providerRevisionId);
  const creatingProvider = Boolean(newDraftRequest);
  const [agent, setAgent] = useState<AgentKind>("claude-code");
  const [baseUrl, setBaseUrl] = useState(creatingProvider ? "" : initialProvider?.baseUrl ?? "https://gateway.example.com");
  const [primaryModel, setPrimaryModel] = useState(creatingProvider ? "" : initialProvider?.primaryModel ?? "claude-sonnet-4-5-20250929");
  const [planningModel, setPlanningModel] = useState(creatingProvider ? "" : initialProvider?.models.planningModel ?? "");
  const [fastModel, setFastModel] = useState(creatingProvider ? "" : initialProvider?.models.smallFastModel ?? "");
  const [subagentModel, setSubagentModel] = useState(creatingProvider ? "" : initialProvider?.models.subagentModel ?? "");
  const [authentication, setAuthentication] = useState<"bearer" | "x-api-key" | "authorization-bearer">("x-api-key");
  const [inputPrice, setInputPrice] = useState(creatingProvider ? "" : String(initialProvider?.pricing.inputUsdPerMillionTokens ?? 3));
  const [outputPrice, setOutputPrice] = useState(creatingProvider ? "" : String(initialProvider?.pricing.outputUsdPerMillionTokens ?? 15));
  const [apiKey, setApiKey] = useState("");
  const [dataRegion, setDataRegion] = useState(creatingProvider ? "" : initialProvider?.governance.dataRegion ?? "新加坡");
  const [retentionPolicy, setRetentionPolicy] = useState(creatingProvider ? "" : initialProvider?.governance.retentionPolicy ?? "最长保留 30 天，按供应商企业协议删除");
  const [trainingPolicy, setTrainingPolicy] = useState(creatingProvider ? "" : initialProvider?.governance.trainingPolicy ?? "源码与提示词不用于模型训练");
  const [maxBudgetUsd, setMaxBudgetUsd] = useState(String(initialProfile?.budget.maxUsd ?? 25));
  const [maxTurns, setMaxTurns] = useState(String(initialProfile?.budget.maxTurns ?? 100));
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(initialProfile?.budget.timeoutSeconds ?? 7_200));
  const [regionAcknowledged, setRegionAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [writtenCredentialMasks, setWrittenCredentialMasks] = useState<Partial<Record<AgentKind, string>>>({});
  const [draftProfileId, setDraftProfileId] = useState("");
  const [editorMode, setEditorMode] = useState<"existing" | "new">(creatingProvider ? "new" : "existing");
  const permissions = agentAdminCapabilities(role);
  const activeProviders = (["claude-code", "codex-cli"] as const).map((kind) => {
    const profile = profiles.find((item) => item.agent === kind && item.scope === "platform" && item.scopeId === "global" && item.state === "ACTIVE");
    return { kind, provider: providers.find((item) => item.id === profile?.providerRevisionId) ?? null };
  });
  const selectedActiveProvider = activeProviders.find((item) => item.kind === agent)?.provider ?? null;
  const matchingCredential = credentials.find((credential) => credential.state === "ACTIVE"
    && credential.id === selectedActiveProvider?.credentialVersionId)
    ?? credentials.find((credential) => credential.state === "ACTIVE" && credentialMatchesAgent(credential.label, agent));
  const agentCredentialIds = new Set(providers.filter((provider) => provider.agent === agent)
    .map((provider) => provider.credentialVersionId));
  const agentCredentials = credentials.filter((credential) => agentCredentialIds.has(credential.id)
    || credentialMatchesAgent(credential.label, agent));
  const credentialMask = writtenCredentialMasks[agent] ?? matchingCredential?.maskedFingerprint ?? "未绑定 ACTIVE 凭据";

  const protocol = agent === "claude-code" ? "Anthropic Messages / Gateway" : "OpenAI Responses";
  useEffect(() => {
    if (!newDraftRequest) return;
    onNewDraftConsumed(newDraftRequest);
  }, [newDraftRequest, onNewDraftConsumed]);

  const chooseAgent = (kind: AgentKind, loadExisting = true) => {
    const current = loadExisting ? activeProviders.find((item) => item.kind === kind)?.provider : null;
    setAgent(kind);
    setBaseUrl(current?.baseUrl ?? (loadExisting ? "https://gateway.example.com" : ""));
    setPrimaryModel(current?.primaryModel ?? (loadExisting
      ? kind === "claude-code" ? "claude-sonnet-4-5-20250929" : "gpt-5.2-codex-2026-02-01"
      : ""));
    setPlanningModel(loadExisting ? current?.models.planningModel ?? "" : "");
    setFastModel(loadExisting ? current?.models.smallFastModel ?? "" : "");
    setSubagentModel(loadExisting ? current?.models.subagentModel ?? "" : "");
    setAuthentication(kind === "claude-code" ? "x-api-key" : "bearer");
    setInputPrice(loadExisting ? String(current?.pricing.inputUsdPerMillionTokens ?? (kind === "claude-code" ? 3 : 2.5)) : "");
    setOutputPrice(loadExisting ? String(current?.pricing.outputUsdPerMillionTokens ?? (kind === "claude-code" ? 15 : 10)) : "");
    setApiKey("");
    setDataRegion(loadExisting ? current?.governance.dataRegion ?? "新加坡" : "");
    setRetentionPolicy(loadExisting ? current?.governance.retentionPolicy ?? "最长保留 30 天，按供应商企业协议删除" : "");
    setTrainingPolicy(loadExisting ? current?.governance.trainingPolicy ?? "源码与提示词不用于模型训练" : "");
    const currentProfile = profiles.find((item) => item.providerRevisionId === current?.id && item.state === "ACTIVE");
    setMaxBudgetUsd(String(currentProfile?.budget.maxUsd ?? 25));
    setMaxTurns(String(currentProfile?.budget.maxTurns ?? 100));
    setTimeoutSeconds(String(currentProfile?.budget.timeoutSeconds ?? 7_200));
    setRegionAcknowledged(false);
    setError("");
    setDraftProfileId("");
    setEditorMode(loadExisting ? "existing" : "new");
  };

  const validate = () => {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:") return "Base URL 仅允许 HTTPS";
      if (url.username || url.password || url.search || url.hash) return "URL 不得包含凭据、query 或 fragment";
      if (url.port && url.port !== "443") return "平台默认仅允许 443；私有 Connector 端口须由 SecurityAdmin 在隔离部署中批准";
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "127.0.0.1" || /^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "端点不能指向 loopback、私网或 link-local 地址";
    } catch {
      return "请输入有效的 HTTPS URL";
    }
    if (!primaryModel.trim()) return "Primary Model 必填";
    if (/^(latest|default|sonnet|opus|haiku)$/i.test(primaryModel.trim())) return "Active Profile 禁止使用浮动模型别名";
    if ((agent === "codex-cli" && authentication !== "bearer")
      || (agent === "claude-code" && authentication !== "x-api-key" && authentication !== "authorization-bearer")) return "认证方式与 Agent 协议不兼容";
    for (const [label, value] of [["输入", inputPrice], ["输出", outputPrice]] as const) {
      const parsed = Number(value);
      if (!value.trim() || !Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) return `${label} Token 单价必须是非负数`;
    }
    const budget = Number(maxBudgetUsd); const turns = Number(maxTurns); const timeout = Number(timeoutSeconds);
    if (!Number.isFinite(budget) || budget <= 0 || budget > 100) return "任务预算必须大于 0 且不超过 100 USD";
    if (!Number.isInteger(turns) || turns < 1 || turns > 200) return "最大 turns 必须是 1–200 的整数";
    if (!Number.isInteger(timeout) || timeout < 60 || timeout > 14_400) return "超时必须是 60–14400 秒的整数";
    if (apiKey && apiKey.length < 12) return "凭据格式过短；请使用测试凭据或留空沿用当前版本";
    if (!dataRegion.trim() || !retentionPolicy.trim() || !trainingPolicy.trim()) return "数据地域、保留和训练政策均为必填";
    if (!regionAcknowledged) return "请确认第三方端点的数据处理信息";
    return "";
  };

  const persistDraft = async () => {
    if (!permissions.editPlatformProvider) throw new Error("当前角色不能编辑平台级 Provider");
    let credentialId = matchingCredential?.id ?? "";
    if (apiKey) {
      if (!permissions.manageGlobalCredentials) throw new Error("替换平台凭据需要 SecurityAdmin 权限");
      const credential = await adminRequest<{ id: string; fingerprint?: string; maskedFingerprint?: string }>("credentials", {
        method: "POST",
        role,
        body: { label: `platform-${agent}-provider`, apiKey },
      });
      credentialId = credential.id;
      setWrittenCredentialMasks((current) => ({ ...current,
        [agent]: credential.maskedFingerprint ?? credential.fingerprint ?? "已写入 Vault" }));
    }
    if (!credentialId) throw new Error(`当前没有 ${agent} 的 ACTIVE 平台凭据；请由 SecurityAdmin 写入 API Key`);
    const installationId = installations.find((installation) => installation.agent === agent
      && ["READY", "CANARY", "ACTIVE"].includes(installation.state) && installation.imageDigest)?.id;
    if (!installationId) throw new Error(`当前没有 ${agent} 的 READY/CANARY/ACTIVE WorkerImage`);
    const created = await adminRequest<{ profile: { id: string } }>("agent-profiles", {
      method: "POST",
      role,
      body: {
        agent,
        baseUrl,
        primaryModel,
        planningModel,
        smallFastModel: fastModel,
        subagentModel,
        authentication,
        inputUsdPerMillionTokens: Number(inputPrice),
        outputUsdPerMillionTokens: Number(outputPrice),
        installationId,
        credentialVersionId: credentialId,
        scope: "platform",
        scopeId: "global",
        dataRegion: dataRegion.trim(),
        retentionPolicy: retentionPolicy.trim(),
        trainingPolicy: trainingPolicy.trim(),
        maxBudgetUsd: Number(maxBudgetUsd),
        maxTurns: Number(maxTurns),
        timeoutSeconds: Number(timeoutSeconds),
      },
    });
    setDraftProfileId(created.profile.id);
    setApiKey("");
    onChanged();
    return created.profile.id;
  };

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!permissions.editPlatformProvider) { setError("当前角色不能编辑平台级 Provider"); return; }
    const message = validate();
    if (message) { setError(message); return; }
    setError("");
    setTesting(true);
    try {
      await persistDraft();
      notify(`Provider 草稿已写入${production ? "生产" : "本地"}控制面；当前生效配置未改变`, "neutral");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider 草稿保存失败");
    } finally {
      setTesting(false);
    }
  };

  const testAndActivate = async () => {
    if (!permissions.activatePlatformProvider) { setError("第三方端点激活需要 SecurityAdmin 权限"); return; }
    const message = validate();
    if (message) { setError(message); return; }
    setError("");
    setTesting(true);
    try {
      const profileId = draftProfileId || await persistDraft();
      await adminRequest(`agent-profiles/${profileId}/validate`, { method: "POST", role });
      await adminRequest(`agent-profiles/${profileId}/activate`, { method: "POST", role });
      onChanged();
      notify("Provider 探针通过并已激活，仅用于新任务");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider 测试激活失败");
      notify("Provider 未激活；当前生效配置保持不变", "warning");
    } finally {
      setTesting(false);
    }
  };

  const rotateCredential = async () => {
    if (!permissions.manageGlobalCredentials) { setError("轮换平台凭据需要 SecurityAdmin 权限"); return; }
    if (!matchingCredential) { setError(`当前没有 ${agent} 的 ACTIVE 平台凭据可轮换`); return; }
    if (apiKey.length < 12) { setError("请先在“替换 API Key”中输入至少 12 个字符的新凭据"); return; }
    setError("");
    setTesting(true);
    try {
      await adminRequest(`credentials/${encodeURIComponent(matchingCredential.id)}/rotate`, {
        method: "POST", role, body: { apiKey },
      });
      onChanged();
      notify("凭据已安全轮换；Provider/Profile 后继和默认项已在完整探针通过后原子切换", "success");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "凭据轮换失败");
      notify("凭据未轮换；当前 Provider 与默认 Profile 保持不变", "warning");
    } finally {
      setApiKey("");
      setTesting(false);
    }
  };

  const restoreLocalBinding = async () => {
    if (production) { setError("生产凭据由 Vault/KMS 持久保存，不使用本机绑定恢复"); return; }
    if (!permissions.manageGlobalCredentials) { setError("恢复平台凭据绑定需要 SecurityAdmin 权限"); return; }
    if (!matchingCredential) { setError(`当前没有 ${agent} 的 ACTIVE 平台凭据可恢复`); return; }
    if (apiKey.length < 8) { setError("请输入该活动凭据版本原来的完整 API Key"); return; }
    setError("");
    setTesting(true);
    try {
      await adminRequest(`credentials/${encodeURIComponent(matchingCredential.id)}/restore-local-binding`, {
        method: "POST", role, body: { apiKey },
      });
      onChanged();
      notify("本机 Key 与活动版本指纹一致；所有关联 Provider/Profile 绑定已重新探针并激活", "success");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本机 Provider 绑定恢复失败");
      notify("本机绑定未完全恢复；D1 中的活动凭据、Provider 和默认项保持不变", "warning");
    } finally {
      setApiKey("");
      setTesting(false);
    }
  };

  const revokeCredential = async (credential: AdminState["credentials"][number] | undefined = matchingCredential) => {
    if (!permissions.manageGlobalCredentials) { setError("撤销平台凭据需要 SecurityAdmin 权限"); return; }
    if (!credential) { setError(`当前没有 ${agent} 的凭据版本可撤销`); return; }
    if (!window.confirm(`立即撤销 ${credential.label}（${credential.id}）？撤销后不会再签发新的短期租约。`)) return;
    setError("");
    setTesting(true);
    try {
      await adminRequest(`credentials/${encodeURIComponent(credential.id)}/revoke`, {
        method: "POST", role, body: {},
      });
      onChanged();
      notify("凭据版本已撤销；新的 Agent 任务将保持 Provider 等待状态", "warning");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "凭据撤销失败");
    } finally {
      setApiKey("");
      setTesting(false);
    }
  };

  return (
    <div className={styles.providerLayout}>
      <section className={styles.section}>
        <SectionHeading title="生效 Provider" description="每种 Agent 使用独立协议 Schema，不执行静默跨 Agent 切换。" />
        {localHealth?.dependencies?.providerBindingProbe !== "CONFIGURED" ? <div className={styles.permissionNotice}><AdminIcon name="shield" />下列为控制面配置快照；本机没有受信 Provider 绑定探针，不能用于 Agent 执行。</div> : null}
        {localHealth?.dependencies?.providerBindingProbe === "CONFIGURED" && localHealth.dependencies.activeProviderBinding !== "VERIFIED" ? <div className={styles.permissionNotice}><AdminIcon name="shield" />安全连接器已就绪，但没有与生效 Profile、精确模型和凭据版本一致的 ACTIVE Provider 绑定；开发 Worker 保持阻断。</div> : null}
        {!permissions.editPlatformProvider ? <div className={styles.permissionNotice}><AdminIcon name="shield" />当前角色只能查看平台 Provider。租户和项目覆盖应在对应作用域页面配置。</div> : null}
        <div className={styles.providerRows}>
          {activeProviders.map(({ kind, provider }) => <button type="button" key={kind}
            className={`${styles.providerRow} ${agent === kind && editorMode === "existing" ? styles.providerRowSelected : ""}`} onClick={() => chooseAgent(kind)}>
            <AgentMark kind={kind} small /><div><strong>{kind === "claude-code" ? "Anthropic Messages" : "OpenAI Responses"} · {provider ? providerHost(provider.baseUrl) : "未配置"}</strong>
              <span>{provider ? `${provider.protocol} · ${provider.primaryModel}` : "尚无 ACTIVE 平台 Provider"}</span></div>
            <StatusPill tone={provider?.state === "ACTIVE" ? "success" : "warning"}>{provider?.state ?? "NOT CONFIGURED"}</StatusPill><AdminIcon name="chevron" />
          </button>)}
        </div>
        <div className={styles.credentialPanel}>
          <div className={styles.credentialIcon}><AdminIcon name="key" /></div>
          <div><span>当前 CredentialBinding</span><strong>{credentialMask}</strong><small>v{matchingCredential?.version ?? "?"} · 轮换 {formatLifecycleTime(matchingCredential?.rotatedAt ?? null)} · 最后使用 {formatLifecycleTime(matchingCredential?.lastUsedAt ?? null)}</small></div>
          <div className={styles.credentialActions}>
            <button type="button" disabled={testing || !permissions.manageGlobalCredentials || !matchingCredential} title={permissions.manageGlobalCredentials ? "使用下方输入的新 Key 创建不可变版本" : "需要 SecurityAdmin 权限"} onClick={() => void rotateCredential()}>轮换</button>
            {!production ? <button type="button" disabled={testing || !permissions.manageGlobalCredentials || !matchingCredential}
              title="sidecar 重启后，用该活动版本原来的 Key 重新探针并激活绑定" onClick={() => void restoreLocalBinding()}>恢复本机绑定</button> : null}
            <button type="button" disabled={testing || !permissions.manageGlobalCredentials || !matchingCredential} title={permissions.manageGlobalCredentials ? "立即停止该版本签发新租约" : "需要 SecurityAdmin 权限"} onClick={() => void revokeCredential()}>撤销当前</button>
          </div>
        </div>
        {agentCredentials.length ? <div className={styles.credentialHistory}>
          {agentCredentials.map((credential) => <div key={credential.id}>
            <span><strong>{credential.label}</strong><small>{credential.id} · v{credential.version ?? "?"} · {credential.state} · 创建 {formatLifecycleTime(credential.createdAt)} · 轮换 {formatLifecycleTime(credential.rotatedAt)} · 最后使用 {formatLifecycleTime(credential.lastUsedAt)}</small></span>
            <code>{credential.maskedFingerprint}</code>
            {credential.state !== "REVOKED" ? <button type="button" disabled={testing || !permissions.manageGlobalCredentials}
              onClick={() => void revokeCredential(credential)}>撤销此版本</button> : <StatusPill tone="danger">REVOKED</StatusPill>}
          </div>)}
        </div> : null}
        <div className={styles.gatewayDiagram}>
          <div><span>Agent Worker</span><small>短期 run token</small></div><i>→</i><div className={styles.gatewayCore}><span>Inference Gateway</span><small>白名单 · 配额 · 审计</small></div><i>→</i><div><span>第三方端点</span><small>上游 Key 仅在 Gateway</small></div>
        </div>
      </section>

      <form className={`${styles.section} ${styles.providerForm}`} onSubmit={saveDraft} noValidate>
        <SectionHeading eyebrow="DRAFT" title={editorMode === "new" ? "新建 Provider" : "编辑 Provider"} description="保存草稿与测试激活分离；本地站仅通过受认证 Agent sidecar 执行上游探针。" />
        <div className={styles.formGroup}>
          <label>Agent</label>
          <div className={styles.segmented}>
            <button className={agent === "claude-code" ? styles.segmentActive : ""} type="button" disabled={!permissions.editPlatformProvider} onClick={() => chooseAgent("claude-code", editorMode === "existing")}>Claude Code</button>
            <button className={agent === "codex-cli" ? styles.segmentActive : ""} type="button" disabled={!permissions.editPlatformProvider} onClick={() => chooseAgent("codex-cli", editorMode === "existing")}>Codex CLI</button>
          </div>
        </div>
        <div className={styles.formGroup}><label htmlFor="protocol">协议</label><input id="protocol" value={protocol} disabled /><small>协议由 Agent Adapter 固定，不可混用。</small></div>
        <div className={styles.formGroup}><label htmlFor="baseUrl">Base URL</label><input id="baseUrl" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck="false" disabled={!permissions.editPlatformProvider} /><small>仅 HTTPS；DNS 与每次 redirect 都会重新执行 SSRF 校验。</small></div>
        <div className={styles.formGroup}><label htmlFor="authentication">上游认证</label><select id="authentication" value={authentication} onChange={(event) => setAuthentication(event.target.value as typeof authentication)} disabled={!permissions.editPlatformProvider}><option value={agent === "codex-cli" ? "bearer" : "x-api-key"}>{agent === "codex-cli" ? "Authorization: Bearer" : "x-api-key"}</option>{agent === "claude-code" ? <option value="authorization-bearer">Authorization: Bearer</option> : null}</select><small>认证方式固定进入 Provider revision，并由探针按同一方式验证。</small></div>
        <div className={styles.formGroup}><label htmlFor="primaryModel">Primary Model <em>必填</em></label><input id="primaryModel" value={primaryModel} onChange={(event) => setPrimaryModel(event.target.value)} spellCheck="false" disabled={!permissions.editPlatformProvider} /><small>必须是精确模型 ID，禁止 latest / default / sonnet 等浮动别名。</small></div>
        <div className={styles.fieldPair}>
          <div className={styles.formGroup}><label htmlFor="planningModel">Planning Model</label><input id="planningModel" value={planningModel} onChange={(event) => setPlanningModel(event.target.value)} placeholder="留空则固定到 Primary" disabled={!permissions.editPlatformProvider} /></div>
          <div className={styles.formGroup}><label htmlFor="fastModel">Small / Fast Model</label><input id="fastModel" value={fastModel} onChange={(event) => setFastModel(event.target.value)} placeholder="留空则固定到 Primary" disabled={!permissions.editPlatformProvider} /></div>
        </div>
        <div className={styles.formGroup}><label htmlFor="subagentModel">Subagent Model</label><input id="subagentModel" value={subagentModel} onChange={(event) => setSubagentModel(event.target.value)} placeholder="留空则固定到 Primary" disabled={!permissions.editPlatformProvider} /><small>规划、快速与子 Agent 模型都会解析为精确 ID 并随 Profile revision 冻结。</small></div>
        <div className={styles.formGroup}><label htmlFor="dataRegion">数据地域</label><input id="dataRegion" value={dataRegion} onChange={(event) => setDataRegion(event.target.value)} disabled={!permissions.editPlatformProvider} /></div>
        <div className={styles.formGroup}><label htmlFor="retentionPolicy">保留政策</label><input id="retentionPolicy" value={retentionPolicy} onChange={(event) => setRetentionPolicy(event.target.value)} disabled={!permissions.editPlatformProvider} /></div>
        <div className={styles.formGroup}><label htmlFor="trainingPolicy">训练政策</label><input id="trainingPolicy" value={trainingPolicy} onChange={(event) => setTrainingPolicy(event.target.value)} disabled={!permissions.editPlatformProvider} /></div>
        <div className={styles.fieldPair}>
          <div className={styles.formGroup}><label htmlFor="inputPrice">输入单价（USD / 1M Token）</label><input id="inputPrice" type="number" min="0" step="0.000001" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} disabled={!permissions.editPlatformProvider} /></div>
          <div className={styles.formGroup}><label htmlFor="outputPrice">输出单价（USD / 1M Token）</label><input id="outputPrice" type="number" min="0" step="0.000001" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} disabled={!permissions.editPlatformProvider} /></div>
        </div>
        <div className={styles.fieldPair}>
          <div className={styles.formGroup}><label htmlFor="maxBudgetUsd">单任务预算（USD）</label><input id="maxBudgetUsd" type="number" min="0.01" max="100" step="0.01" value={maxBudgetUsd} onChange={(event) => setMaxBudgetUsd(event.target.value)} disabled={!permissions.editPlatformProvider} /></div>
          <div className={styles.formGroup}><label htmlFor="maxTurns">最大 Turns</label><input id="maxTurns" type="number" min="1" max="200" step="1" value={maxTurns} onChange={(event) => setMaxTurns(event.target.value)} disabled={!permissions.editPlatformProvider} /></div>
        </div>
        <div className={styles.formGroup}><label htmlFor="timeoutSeconds">任务超时（秒）</label><input id="timeoutSeconds" type="number" min="60" max="14400" step="60" value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} disabled={!permissions.editPlatformProvider} /></div>
        <div className={styles.formGroup}><label htmlFor="apiKey">API Key（新版本或本机恢复）</label><div className={styles.keyInput}><AdminIcon name="key" /><input id="apiKey" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="轮换填新 Key；恢复填该版本原 Key" autoComplete="new-password" disabled={!permissions.manageGlobalCredentials} /></div><small>写入或复验后立即清空；数据库仅保存 SecretRef、掩码与不可逆指纹。平台凭据仅由 SecurityAdmin 操作。</small></div>
        <label className={styles.checkLabel}><input type="checkbox" checked={regionAcknowledged} onChange={(event) => setRegionAcknowledged(event.target.checked)} disabled={!permissions.editPlatformProvider} /><span>已确认该端点的数据地域、保留期限、训练政策及源码处理范围。</span></label>
        {error && <div className={styles.formError}><AdminIcon name="alert" />{error}</div>}
        <div className={styles.probeList}><span>激活探针</span><div>{["认证", "模型", "流式", "工具", "取消", "Usage", "超时", "无工具", "DNS 固定", "跳转重验"].map((probe) => <em key={probe}>{probe}</em>)}</div></div>
        <div className={styles.formActions}><button className={styles.secondaryButton} type="submit" disabled={testing || !permissions.editPlatformProvider}>保存草稿</button><button className={styles.primaryButton} type="button" disabled={testing || !permissions.activatePlatformProvider} title={permissions.activatePlatformProvider ? undefined : "需要 SecurityAdmin 权限"} onClick={testAndActivate}>{testing ? "正在校验门禁…" : "测试并激活"}</button></div>
      </form>
    </div>
  );
}

function InheritanceTab({ defaults, installations, profiles, providers, notify }: {
  defaults: AdminState["defaults"];
  installations: AgentInstallation[];
  profiles: AdminState["profiles"];
  providers: AdminState["providers"];
  notify: (message: string, tone?: "success" | "warning" | "neutral") => void;
}) {
  const selections = useMemo(() => {
    const rank = (key: string) => key === "platform" ? 0 : key.startsWith("tenant:") ? 1 : 2;
    const entries = Object.entries(defaults)
      .filter(([key, profileId]) => (key === "platform" || /^(tenant|project):[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(key)) && Boolean(profileId))
      .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right));
    if (!entries.some(([key]) => key === "platform")) entries.unshift(["platform", "built-in:claude-code"]);
    return entries.map(([scopeKey, profileId]) => ({ scopeKey, profileId, profile: profiles.find((item) => item.id === profileId) ?? null }));
  }, [defaults, profiles]);
  const [scopeKey, setScopeKey] = useState("platform");
  const selected = selections.find((item) => item.scopeKey === scopeKey) ?? selections[0] ?? null;
  const profile = selected?.profile ?? null;
  const installation = installations.find((item) => item.id === profile?.installationId) ?? null;
  const provider = providers.find((item) => item.id === profile?.providerRevisionId) ?? null;
  const fallback = profiles.find((item) => item.id === profile?.fallbackProfileRevisionId) ?? null;
  const resolvedAgent = profile?.agent ?? (selected?.profileId === "built-in:claude-code" ? "claude-code" : null);
  const selectedLabel = scopeLabel(selected?.scopeKey ?? "platform");
  const resolutionSummary = JSON.stringify({
    scope: selected?.scopeKey ?? "platform",
    source: selected?.profileId === "built-in:claude-code" ? "built-in:claude-code" : selected?.scopeKey,
    profileRevisionId: profile?.id ?? selected?.profileId ?? null,
    profileRevision: profile?.revision ?? null,
    agent: resolvedAgent,
    installationId: installation?.id ?? null,
    imageDigest: installation?.imageDigest ?? null,
    providerRevisionId: provider?.id ?? null,
    models: provider?.models ?? null,
    fallbackProfileRevisionId: fallback?.id ?? null,
    budget: profile?.budget ?? null,
  }, null, 2);
  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(resolutionSummary);
      notify("已复制当前有效配置摘要", "neutral");
    } catch {
      notify("浏览器未授予剪贴板权限", "warning");
    }
  };
  return (
    <>
      <section className={styles.section}>
        <SectionHeading title="有效配置解析" description="以下内容直接来自当前控制面 revision：项目覆盖 → 租户覆盖 → 平台默认；不使用演示名称或推测值。" action={<select aria-label="选择配置作用域" className={styles.projectSelect} value={selected?.scopeKey ?? "platform"} onChange={(event) => setScopeKey(event.target.value)}>{selections.map((item) => <option key={item.scopeKey} value={item.scopeKey}>{scopeLabel(item.scopeKey)}</option>)}</select>} />
        <div className={styles.tableWrap}>
          <table className={styles.dataTable}>
            <thead><tr><th>作用域</th><th>配置来源</th><th>有效 Agent</th><th>Profile revision</th><th>状态</th></tr></thead>
            <tbody>{selections.map((item) => {
              const builtIn = item.profileId === "built-in:claude-code";
              const broken = !builtIn && !item.profile;
              const agent = item.profile?.agent ?? (builtIn ? "claude-code" : null);
              return <tr key={item.scopeKey}>
                <td><button className={styles.textButton} type="button" onClick={() => setScopeKey(item.scopeKey)}>{scopeLabel(item.scopeKey)}</button></td>
                <td>{builtIn ? "内置安全默认" : item.scopeKey === "platform" ? "平台显式默认" : `${item.scopeKey.split(":", 1)[0] === "tenant" ? "租户" : "项目"}显式覆盖`}</td>
                <td>{agent ? <div className={styles.tableAgent}><AgentMark kind={agent} small /><strong>{agent === "claude-code" ? "Claude Code" : "Codex CLI"}</strong></div> : "不可解析"}</td>
                <td><code>{item.profile?.id ?? item.profileId}</code>{item.profile?.revision !== null && item.profile?.revision !== undefined ? ` · rev ${item.profile.revision}` : ""}</td>
                <td><StatusPill tone={broken ? "danger" : item.profile?.state === "ACTIVE" || builtIn ? "success" : "warning"}>{broken ? "BROKEN_REFERENCE" : item.profile?.state ?? "ACTIVE"}</StatusPill></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        {selected && selected.profileId !== "built-in:claude-code" && !profile ? <div className={styles.formError}><AdminIcon name="alert" />{selectedLabel} 默认指向不存在的 Profile：{selected.profileId}。该作用域必须停止接收新任务。</div> : null}
        <div className={styles.resolutionTable}>
          <div><span>Installation</span><strong>{installation ? `${installation.agent} ${installation.version}` : profile ? "未找到锁定 Installation" : "内置默认尚未锁定"}</strong><small>{installation ? `${installation.workerPool} · ${installation.imageDigest ? `${installation.imageDigest.slice(0, 18)}…` : "无镜像 digest"}` : `来源：${selectedLabel}`}</small></div>
          <div><span>Provider / Model Roles</span><strong>{provider ? `${provider.protocol} · ${providerHost(provider.baseUrl)}` : profile ? "未找到锁定 Provider" : "等待项目入队解析"}</strong><small>{provider ? `primary ${provider.models.primaryModel} · planning ${provider.models.planningModel} · fast ${provider.models.smallFastModel} · subagent ${provider.models.subagentModel}` : "无已锁定模型"}</small></div>
          <div><span>Profile / Fallback</span><strong>{profile ? `${profile.id}${profile.revision === null ? "" : ` · rev ${profile.revision}`}` : selected?.profileId ?? "—"}</strong><small>{fallback ? `显式同 Agent fallback：${fallback.id}` : "无显式 fallback；Provider 故障进入 WAITING_PROVIDER"}</small></div>
          <div><span>任务预算 / 超时</span><strong>{profile?.budget.maxUsd === null || profile?.budget.maxUsd === undefined ? "未锁定" : `$${profile.budget.maxUsd}`}{profile?.budget.maxTurns === null || profile?.budget.maxTurns === undefined ? "" : ` · ${profile.budget.maxTurns} turns`}</strong><small>{profile?.budget.timeoutSeconds === null || profile?.budget.timeoutSeconds === undefined ? "入队时由有效 Profile 固定" : `${profile.budget.timeoutSeconds} 秒`}</small></div>
        </div>
        <div className={styles.lockNotice}><AdminIcon name="layers" /><div><strong>入队快照</strong><span>每个 AgentRun 永久记录 profile revision、installation、image digest、adapter、精确模型与 credential version。后台变更不会漂移已排队或运行中的任务。</span></div><button type="button" onClick={() => void copySummary()}>复制摘要</button></div>
      </section>

      <section className={styles.section}>
        <SectionHeading eyebrow="RBAC" title="角色与权限边界" />
        <div className={styles.roleGrid}>
          {Object.entries(rolePermissions).map(([name, permission]) => <div key={name}><span>{name.slice(0, 2).toUpperCase()}</span><div><strong>{name}</strong><small>{permission}</small></div></div>)}
        </div>
      </section>
    </>
  );
}

function normalizeAgentHealth(value: unknown): AgentHealth {
  const root = object(value);
  const usage = object(root?.usage);
  const totals = object(usage?.totals);
  if (!root || (root.status !== "HEALTHY" && root.status !== "DEGRADED") || !usage || !totals) {
    throw new Error("Agent 健康投影响应无效");
  }
  const usageRecords = records(usage.records).map((record) => ({
    requestId: requiredText(record.requestId, "usage request"),
    tenantId: requiredText(record.tenantId, "usage tenant"),
    projectId: requiredText(record.projectId, "usage project"),
    runId: requiredText(record.runId, "usage run"),
    providerRevisionId: requiredText(record.providerRevisionId, "usage provider"),
    credentialVersionId: requiredText(record.credentialVersionId, "usage credential"),
    model: requiredText(record.model, "usage model"),
    inputTokens: requiredNumber(record.inputTokens, "usage input tokens"),
    outputTokens: requiredNumber(record.outputTokens, "usage output tokens"),
    costUsd: requiredNumber(record.costUsd, "usage cost"),
    recordedAt: requiredText(record.recordedAt, "usage timestamp"),
  }));
  const diffs = records(root.configurationDiffs).map((record) => ({
    id: requiredText(record.id, "configuration diff"),
    action: requiredText(record.action, "configuration action"),
    resource: requiredText(record.resource, "configuration resource"),
    actorId: requiredText(record.actorId, "configuration actor"),
    at: requiredText(record.at, "configuration timestamp"),
    changes: records(record.changes).map((change) => ({
      field: requiredText(change.field, "configuration field"),
      before: change.before,
      after: change.after,
    })),
  }));
  const alerts = records(root.alerts).map((record) => {
    if (record.severity !== "WARNING" && record.severity !== "CRITICAL") throw new Error("Agent 告警级别无效");
    const severity: "WARNING" | "CRITICAL" = record.severity;
    return {
      id: requiredText(record.id, "alert"),
      severity,
      code: requiredText(record.code, "alert code"),
      resource: requiredText(record.resource, "alert resource"),
      message: requiredText(record.message, "alert message"),
    };
  });
  return {
    status: root.status,
    usage: {
      available: usage.available === true,
      source: "inference_usage_events",
      windowStartedAt: requiredText(usage.windowStartedAt, "usage window"),
      totals: {
        requests: requiredNumber(totals.requests, "usage requests"),
        inputTokens: requiredNumber(totals.inputTokens, "usage input total"),
        outputTokens: requiredNumber(totals.outputTokens, "usage output total"),
        costUsd: requiredNumber(totals.costUsd, "usage cost total"),
      },
      records: usageRecords,
    },
    configurationDiffs: diffs,
    alerts,
    checkedAt: requiredText(root.checkedAt, "health timestamp"),
  };
}

function requiredText(value: unknown, label: string): string {
  const parsed = text(value);
  if (!parsed) throw new Error(`${label} 响应无效`);
  return parsed;
}

function requiredNumber(value: unknown, label: string): number {
  const parsed = number(value);
  if (parsed === null || parsed < 0) throw new Error(`${label} 响应无效`);
  return parsed;
}

function normalizeAdminState(payload: Record<string, unknown>): AdminState {
  const local = object(payload.meta);
  if (local) {
    const catalog = catalogRows(payload.data);
    const versions = records(local.versions).map(versionRow);
    const installations = records(local.installations).map((value) => installationRow(value));
    return {
      catalog,
      defaultAgent: agentKind(local.defaultAgent) ?? "claude-code",
      versions,
      installations,
      rollouts: rolloutRows(local.rollouts, installations),
      profiles: records(local.profiles).map(profileRow).filter((value): value is AdminState["profiles"][number] => Boolean(value)),
      providers: records(local.providers).map(providerRow).filter((value): value is AdminState["providers"][number] => Boolean(value)),
      credentials: records(local.credentials).map(credentialRow).filter((value): value is AdminState["credentials"][number] => Boolean(value)),
      defaults: defaultRows(local.defaults),
    };
  }
  const data = object(payload.data);
  if (!data) throw new Error("Agent 管理状态响应无效");
  const catalog = records(data.catalog);
  const parsedCatalog = catalogRows(catalog);
  const versions = catalog.flatMap((entry) => records(entry.versions).map(versionRow));
  const installations = catalog.flatMap((entry) => records(entry.installations).map((value) => installationRow(value, agentKind(entry.id) ?? undefined)));
  return {
    catalog: parsedCatalog,
    defaultAgent: agentKind(data.effectivePlatformDefaultAgent) ?? "claude-code",
    versions,
    installations,
    rollouts: rolloutRows(undefined, installations),
    profiles: records(data.profiles).map(profileRow).filter((value): value is AdminState["profiles"][number] => Boolean(value)),
    providers: records(data.providers).map(providerRow).filter((value): value is AdminState["providers"][number] => Boolean(value)),
    credentials: records(data.credentials).map(credentialRow).filter((value): value is AdminState["credentials"][number] => Boolean(value)),
    defaults: defaultRows(data.defaults),
  };
}

function versionRow(value: Record<string, unknown>): AgentVersionRow {
  const agent = agentKind(value.agent);
  const version = text(value.version);
  const status = versionStatus(value.state);
  if (!agent || !version || !status) throw new Error("Agent 版本目录响应无效");
  const discoveredAt = text(value.discoveredAt);
  const sourceDigest = text(value.sourceDigest);
  const validationDigest = text(value.validationReceiptDigest);
  const builtIn = builtInAgentUi.find((item) => item.id === agent)!;
  const validatedAdapterVersion = text(value.validatedAdapterVersion);
  const compatibility = object(value.adapterCompatibility);
  const adapterAttested = !!validatedAdapterVersion && !!compatibility
    && typeof compatibility.min === "string" && typeof compatibility.maxExclusive === "string"
    && isAdapterVersionAttested(builtIn.adapterVersion, validatedAdapterVersion, {
      min: compatibility.min, maxExclusive: compatibility.maxExclusive,
    });
  const sourceUrl = trustedAgentVersionUrl(agent, version, "source", text(value.source) ?? builtIn.officialSource);
  const releaseNotesUrl = trustedAgentVersionUrl(agent, version, "release-notes", text(value.releaseNotesUrl) ?? (agent === "claude-code"
    ? "https://github.com/anthropics/claude-code/releases"
    : "https://github.com/openai/codex/releases"));
  return {
    id: text(value.id) ?? `${agent}@${version}`,
    agent,
    version,
    discoveredAt: discoveredAt && Number.isFinite(Date.parse(discoveredAt))
      ? new Date(discoveredAt).toLocaleString("zh-CN", { hour12: false }) : "时间未投影",
    sourceUrl,
    releaseNotesUrl,
    integrity: value.signatureVerified === true && text(value.integrity)
      ? text(value.integrity)!
      : validationDigest ? `验证回执 ${shortDigest(validationDigest)}` : sourceDigest ? `待验证 · 来源 ${shortDigest(sourceDigest)}` : "等待供应链回执",
    sbom: text(value.sbomRef) ?? "SBOM 未投影",
    vulnerabilities: value.scan === "PASS" ? "扫描通过" : value.scan === "FAIL" ? "扫描失败" : "扫描状态未投影",
    adapterBinding: adapterAttested
      ? `${validatedAdapterVersion} · [${compatibility!.min}, ${compatibility!.maxExclusive})`
      : "未证明 / 需重新验证",
    adapterAttested,
    status,
  };
}

function installationRow(value: Record<string, unknown>, catalogAgent?: AgentKind): AgentInstallation {
  const agent = agentKind(value.agent) ?? catalogAgent;
  const id = text(value.id);
  const version = text(value.version) ?? text(value.agentVersionId)?.split("@").at(-1);
  const workerPool = text(value.workerPool);
  const adapterVersion = text(value.adapterVersion);
  const health = value.health === "HEALTHY" || value.health === "DEGRADED" || value.health === "UNHEALTHY" ? value.health : null;
  if (!agent || !id || !version || !workerPool || !adapterVersion || !health) throw new Error("Agent Installation 响应无效");
  const runtime = object(value.runtimeBinding);
  const fleet = object(value.fleetHealth);
  if (Boolean(runtime) !== Boolean(fleet)) throw new Error("Agent Installation 运行时证明不完整");
  const runtimeBinding = runtime ? {
    backend: runtime.backend === "firecracker-jailer" ? runtime.backend : null,
    launcherReleaseId: text(runtime.launcherReleaseId),
    guestReleaseId: text(runtime.guestReleaseId),
    workerBindingDigest: text(runtime.workerBindingDigest),
  } : null;
  const registeredWorkers = fleet ? number(fleet.registeredWorkers) : null;
  const readyWorkers = fleet ? number(fleet.readyWorkers) : null;
  const observedAt = fleet ? text(fleet.observedAt) : null;
  if (runtimeBinding && (!runtimeBinding.backend || !runtimeBinding.launcherReleaseId || !runtimeBinding.guestReleaseId
      || !runtimeBinding.workerBindingDigest || registeredWorkers === null || !Number.isSafeInteger(registeredWorkers)
      || registeredWorkers < 0 || readyWorkers === null || !Number.isSafeInteger(readyWorkers) || readyWorkers < 0
      || readyWorkers > registeredWorkers || !observedAt)) {
    throw new Error("Agent Installation 运行时证明无效");
  }
  return {
    id, agent, version, workerPool, adapterVersion,
    imageDigest: text(value.imageDigest),
    buildReceiptId: text(value.buildReceiptId),
    runtimeBinding: runtimeBinding as AgentInstallation["runtimeBinding"],
    fleetHealth: runtimeBinding ? { registeredWorkers: registeredWorkers!, readyWorkers: readyWorkers!, observedAt: observedAt! } : null,
    state: text(value.state) ?? "FAILED",
    health,
    rolloutPercent: number(value.rolloutPercent) ?? 0,
    rollbackInstallationId: text(value.rollbackInstallationId),
    createdAt: text(value.createdAt) ?? undefined,
    activatedAt: text(value.activatedAt),
    drainingAt: text(value.drainingAt),
    retiredAt: text(value.retiredAt),
    ...(object(value.failure) ? { failure: object(value.failure) as AgentInstallation["failure"] } : {}),
  };
}

function rolloutRows(value: unknown, installations: readonly AgentInstallation[]): AdminState["rollouts"] {
  const source = object(value);
  if (source) return Object.fromEntries(Object.entries(source).map(([id, child]) => {
    const row = object(child) ?? {};
    return [id, { percent: number(row.percent) ?? 0, state: text(row.state) ?? "READY", previous: number(row.previous) ?? 0 }];
  }));
  return Object.fromEntries(installations.map((installation) => [installation.id,
    { percent: installation.rolloutPercent, state: installation.state, previous: 0 }]));
}

function profileRow(value: Record<string, unknown>): AdminState["profiles"][number] | null {
  const agent = agentKind(value.agent); const id = text(value.id); const scope = text(value.scope); const scopeId = text(value.scopeId);
  const state = text(value.state); const installationId = text(value.installationId);
  const providerRevisionId = text(value.providerRevisionId) ?? text(value.providerId);
  const rawBudget = object(value.budget);
  const fallbackProfileRevisionId = text(value.fallbackProfileRevisionId) ?? text(value.fallbackProfileId);
  return agent && id && scope && scopeId && state && installationId && providerRevisionId
    ? {
      id, agent, scope, scopeId, state, installationId, providerRevisionId, fallbackProfileRevisionId,
      revision: number(value.revision),
      budget: {
        maxUsd: number(rawBudget?.maxUsd) ?? number(value.budgetUsd),
        maxTurns: number(rawBudget?.maxTurns),
        timeoutSeconds: number(rawBudget?.timeoutSeconds),
      },
    } : null;
}
function providerRow(value: Record<string, unknown>): AdminState["providers"][number] | null {
  const id = text(value.id); const agent = agentKind(value.agent); const protocol = text(value.protocol); const baseUrl = text(value.baseUrl);
  const models = object(value.models); const primaryModel = text(models?.primaryModel) ?? text(value.primaryModel); const state = text(value.state);
  const credentialVersionId = text(value.credentialVersionId) ?? text(value.credentialId);
  const planningModel = text(models?.planningModel) ?? primaryModel;
  const smallFastModel = text(models?.smallFastModel) ?? primaryModel;
  const subagentModel = text(models?.subagentModel) ?? primaryModel;
  const pricing = object(value.pricing); const governance = object(value.governance);
  return id && agent && protocol && baseUrl && primaryModel && planningModel && smallFastModel && subagentModel && credentialVersionId && state
    ? {
      id, agent, protocol, baseUrl, primaryModel,
      models: { primaryModel, planningModel, smallFastModel, subagentModel },
      pricing: {
        inputUsdPerMillionTokens: number(pricing?.inputUsdPerMillionTokens) ?? number(value.inputUsdPerMillionTokens),
        outputUsdPerMillionTokens: number(pricing?.outputUsdPerMillionTokens) ?? number(value.outputUsdPerMillionTokens),
      },
      governance: {
        dataRegion: text(governance?.dataRegion), retentionPolicy: text(governance?.retentionPolicy),
        trainingPolicy: text(governance?.trainingPolicy), confirmedBy: text(governance?.confirmedBy),
        confirmedAt: text(governance?.confirmedAt),
      },
      credentialVersionId, state,
    } : null;
}
function credentialRow(value: Record<string, unknown>): AdminState["credentials"][number] | null {
  const id = text(value.id); const label = text(value.label); const state = text(value.state);
  const maskedFingerprint = text(value.maskedFingerprint) ?? text(value.masked);
  return id && label && state && maskedFingerprint
    ? {
      id, label, state, maskedFingerprint, version: number(value.version), createdAt: text(value.createdAt),
      rotatedAt: text(value.rotatedAt),
      lastUsedAt: text(value.lastUsedAt),
    } : null;
}
function defaultRows(value: unknown): Record<string, string> {
  const source = object(value);
  if (!source) return {};
  const defaults: Record<string, string> = {};
  for (const [key, profileId] of Object.entries(source)) {
    if ((key === "platform" || /^(tenant|project):[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(key))
      && typeof profileId === "string" && profileId) defaults[key] = profileId;
  }
  return defaults;
}
function scopeLabel(scopeKey: string): string {
  if (scopeKey === "platform") return "平台 / global";
  const separator = scopeKey.indexOf(":");
  const scope = scopeKey.slice(0, separator) === "tenant" ? "租户" : "项目";
  return `${scope} / ${scopeKey.slice(separator + 1)}`;
}
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(object).filter((item): item is Record<string, unknown> => Boolean(item)) : []; }
function text(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function agentKind(value: unknown): AgentKind | null { return value === "claude-code" || value === "codex-cli" ? value : null; }
function versionStatus(value: unknown): AgentVersionRow["status"] | null {
  return value === "APPROVED" || value === "DISCOVERED" || value === "VALIDATING" || value === "DEPRECATED"
    || value === "BLOCKED" || value === "REJECTED" ? value : null;
}
function catalogRows(value: unknown): AgentCatalogItem[] {
  const result = records(value).map((row) => {
    const kind = agentKind(row.id);
    const builtIn = builtInAgentUi.find((item) => item.id === kind);
    if (!kind || !builtIn) throw new Error("Agent Registry 响应包含不受支持的 Agent");
    const adapterId = text(row.adapterId);
    const adapterVersion = text(row.adapterVersion);
    const providerProtocol = text(row.providerProtocol);
    const configurationSchemaId = text(object(row.configurationSchema)?.schemaId);
    if (adapterId !== builtIn.adapterId || adapterVersion !== builtIn.adapterVersion
      || providerProtocol !== builtIn.providerProtocol || configurationSchemaId !== builtIn.configurationSchemaId) {
      throw new Error("Agent Registry 的 Adapter 或 Provider Schema 与当前平台版本不匹配");
    }
    const officialSource = text(row.officialSource) ?? builtIn.officialSource;
    let source: URL;
    try { source = new URL(officialSource); } catch { throw new Error("Agent Registry 官方来源无效"); }
    if (source.protocol !== "https:" || source.username || source.password || source.search || source.hash) {
      throw new Error("Agent Registry 官方来源无效");
    }
    return {
      id: kind,
      name: text(row.name) ?? builtIn.name,
      vendor: text(row.vendor) ?? builtIn.vendor,
      description: builtIn.description,
      officialSource: source.toString(),
      adapterId,
      adapterVersion,
      providerProtocol: builtIn.providerProtocol,
      configurationSchemaId,
      capabilities: catalogStringList(row.capabilities, builtIn.capabilities),
      supportedWorkers: catalogStringList(row.supportedWorkers, builtIn.supportedWorkers),
    };
  });
  if (result.length !== 2 || new Set(result.map((item) => item.id)).size !== 2
    || !(["claude-code", "codex-cli"] as const).every((kind) => result.some((item) => item.id === kind))) {
    throw new Error("Agent Registry 必须精确包含 Claude Code 与 Codex CLI");
  }
  return result;
}
function catalogStringList(value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length === 0 || value.length > 32
    || value.some((item) => typeof item !== "string" || !item || item.length > 120)) {
    throw new Error("Agent Registry 能力或平台列表无效");
  }
  return [...value] as string[];
}
function shortDigest(value: string): string { return value.length > 22 ? `${value.slice(0, 14)}…${value.slice(-7)}` : value; }
function isAdminRole(value: unknown): value is AdminRole { return typeof value === "string" && value in rolePermissions; }
function isLoopbackBrowser(): boolean { return typeof window !== "undefined" && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname); }
function credentialMatchesAgent(label: string, agent: AgentKind): boolean {
  const normalized = label.toLowerCase();
  return agent === "claude-code" ? normalized.includes("claude") || normalized.includes("anthropic") : normalized.includes("codex") || normalized.includes("openai");
}
function providerHost(value: string): string { try { return new URL(value).host; } catch { return "无效端点"; } }

function AuditTab({ events, filter, localHealth, agentHealth, setFilter }: { events: AuditEvent[]; filter: string; localHealth: LocalHealth | null; agentHealth: AgentHealth | null; setFilter: (value: string) => void }) {
  const filtered = useMemo(() => filter === "全部事件" ? events : events.filter((event) => filter === "仅告警" ? event.tone === "warning" : event.action.includes("PROVIDER") || event.action.includes("CREDENTIAL") || event.action.includes("Provider") || event.action.includes("凭据")), [events, filter]);
  const readyAgents = localHealth?.dependencies?.localAgents?.filter((agent) => agent.state === "READY").length ?? 0;
  const workerReady = localHealth?.dependencies?.developmentWorker === "READY";
  const usage = agentHealth?.usage;
  const alerts = agentHealth?.alerts ?? [];
  const diffs = agentHealth?.configurationDiffs ?? [];
  const operationalHealthy = agentHealth?.status === "HEALTHY";
  return (
    <>
      <div className={styles.healthBanner}>
        <div><span className={`${styles.pulseRing} ${operationalHealthy ? "" : styles.pulseRingWarning}`}><i /></span><div><strong>{operationalHealthy ? "Agent 控制面健康" : agentHealth ? "Agent 控制面存在门禁告警" : "正在读取 Agent 控制面健康"}</strong><small>运营数据来自 `/api/admin/agent-health`；本机执行状态独立来自 `/api/health`</small></div></div>
        <dl><div><dt>精确 CLI</dt><dd>{readyAgents} / 2</dd></div><div><dt>Inference Gateway</dt><dd>{localHealth?.dependencies?.inferenceGateway === "CONFIGURED" ? "已配置" : "未配置"}</dd></div><div><dt>运营告警</dt><dd>{alerts.length}</dd></div><div><dt>开发 Worker</dt><dd>{workerReady ? "READY" : "BLOCKED"}</dd></div></dl>
      </div>
      <div className={styles.metricRail}>
        <div><span>24h 推理请求</span><strong>{usage?.available ? usage.totals.requests.toLocaleString("zh-CN") : "—"}</strong><small>append-only</small></div>
        <div><span>24h 输入 / 输出</span><strong>{usage?.available ? `${compactNumber(usage.totals.inputTokens)} / ${compactNumber(usage.totals.outputTokens)}` : "—"}</strong><small>tokens</small></div>
        <div><span>24h 计量成本</span><strong>{usage?.available ? `$${usage.totals.costUsd.toFixed(4)}` : "—"}</strong><small>USD</small></div>
        <div><span>配置差异</span><strong>{diffs.length}</strong><small>最近 50 条</small></div>
      </div>
      <div className={styles.twoColumn}>
        <section className={styles.section}>
          <SectionHeading eyebrow="ALERTS" title="当前告警" description="由 Installation、Provider、Profile 绑定和账本可用性实时推导。" />
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}><thead><tr><th>级别</th><th>资源</th><th>说明</th></tr></thead><tbody>
              {alerts.map((alert) => <tr key={alert.id}><td><StatusPill tone={alert.severity === "CRITICAL" ? "danger" : "warning"}>{alert.severity}</StatusPill></td><td><code>{alert.resource}</code></td><td>{alert.message}</td></tr>)}
            </tbody></table>
            {alerts.length === 0 && <div className={styles.emptyState}>当前没有 Agent 运营告警</div>}
          </div>
        </section>
        <section className={styles.section}>
          <SectionHeading eyebrow="CONFIG DIFF" title="配置变更差异" description="从可见的不可变审计记录提取 before / after，不回推或覆盖历史 revision。" />
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}><thead><tr><th>时间</th><th>资源</th><th>差异</th></tr></thead><tbody>
              {diffs.slice(0, 8).map((diff) => <tr key={diff.id}><td>{formatHealthTime(diff.at)}</td><td><code>{diff.resource}</code></td><td>{diff.changes.map((change) => `${change.field}: ${formatDiffValue(change.before)} → ${formatDiffValue(change.after)}`).join(" · ")}</td></tr>)}
            </tbody></table>
            {diffs.length === 0 && <div className={styles.emptyState}>尚无带 before / after 的配置变更</div>}
          </div>
        </section>
      </div>
      <section className={styles.section}>
        <SectionHeading eyebrow="USAGE" title="不可变推理使用记录" description="最近 24 小时、最多 50 条；每条记录绑定 tenant、project、run、Provider、模型和 credential version。" />
        <div className={styles.tableWrap}>
          <table className={styles.dataTable}><thead><tr><th>记录时间</th><th>Run</th><th>Provider / Model</th><th>输入</th><th>输出</th><th>成本</th></tr></thead><tbody>
            {(usage?.records ?? []).slice(0, 12).map((record) => <tr key={record.requestId}><td>{formatHealthTime(record.recordedAt)}</td><td><code>{shortDigest(record.runId)}</code></td><td><div className={styles.tableAgent}><div><strong>{record.model}</strong><code>{record.providerRevisionId} · {record.credentialVersionId}</code></div></div></td><td>{record.inputTokens.toLocaleString("zh-CN")}</td><td>{record.outputTokens.toLocaleString("zh-CN")}</td><td>${record.costUsd.toFixed(6)}</td></tr>)}
          </tbody></table>
          {usage && !usage.available && <div className={styles.emptyState}>使用账本当前不可读取；不会以估算值替代</div>}
          {usage?.available && usage.records.length === 0 && <div className={styles.emptyState}>最近 24 小时没有推理使用记录</div>}
          {!usage && <div className={styles.emptyState}>正在读取推理使用账本</div>}
        </div>
      </section>
      <section className={styles.section}>
        <SectionHeading title="不可变审计记录" description="配置 revision、探针、版本治理和凭据使用均记录 actor、差异与幂等键。" action={<select className={styles.projectSelect} value={filter} onChange={(event) => setFilter(event.target.value)}><option>全部事件</option><option>仅告警</option><option>Provider / 凭据</option></select>} />
        <div className={styles.auditTimeline}>
          {filtered.map((event) => <div className={styles.auditEvent} key={event.id}><time>{event.at}</time><span className={`${styles.auditDot} ${styles[`audit_${event.tone}`]}`} /><div><div><strong>{event.action}</strong><span>{event.target}</span></div><p>{event.detail}</p><small>{event.actor} · {event.role}</small></div><button className={styles.moreButton} type="button"><AdminIcon name="more" /></button></div>)}
          {filtered.length === 0 && <div className={styles.emptyState}>当前筛选条件下没有事件</div>}
        </div>
        <div className={styles.tableFooter}><span>当前投影 {filtered.length} 条 · 保留与 WORM 策略由审计存储执行</span></div>
      </section>
    </>
  );
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatHealthTime(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("zh-CN", { hour12: false }) : "无效时间";
}

function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  const serialized = JSON.stringify(value);
  return serialized.length > 64 ? `${serialized.slice(0, 61)}…` : serialized;
}
