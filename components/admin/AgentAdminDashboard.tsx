"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { LocalAgentReadiness, LocalHealth } from "@/components/console/useLocalPlatform";
import { agentAdminCapabilities } from "@/lib/admin/agent-permissions";
import {
  agents,
  rolePermissions,
  versionRows,
  type AdminRole,
  type AgentKind,
  type AgentVersionRow,
  type AuditEvent,
} from "@/lib/demo/admin-data";
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
  imageDigest: string;
  buildReceiptId: string;
  state: string;
  health: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  rolloutPercent: number;
};
type AdminState = {
  defaultAgent: AgentKind;
  versions: Array<{ id: string; agent: AgentKind; version: string; state: AgentVersionRow["status"] }>;
  installations: AgentInstallation[];
  rollouts: Record<string, { percent: number; state: string; previous: number }>;
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
      "x-deviludo-role": options.role ?? "Auditor",
    } : undefined,
    body: options.method ? JSON.stringify(options.body ?? {}) : undefined,
  });
  const payload = await response.json() as { data?: T; meta?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? `管理 API 返回 ${response.status}`);
  return (payload.data ?? payload.meta) as T;
}

const tabs: { id: TabId; label: string; count?: string }[] = [
  { id: "overview", label: "总览" },
  { id: "versions", label: "版本", count: "4" },
  { id: "deployments", label: "安装部署", count: "2" },
  { id: "providers", label: "Provider", count: "2" },
  { id: "inheritance", label: "选择与继承" },
  { id: "audit", label: "健康与审计" },
];

const navGroups: { label: string; items: { label: string; icon: AdminIconName; active?: boolean; badge?: string }[] }[] = [
  {
    label: "工作空间",
    items: [
      { label: "运行概览", icon: "activity" },
      { label: "项目", icon: "projects" },
      { label: "构建与测试", icon: "runners", badge: "12" },
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
  const [versions, setVersions] = useState<AgentVersionRow[]>(versionRows);
  const [installations, setInstallations] = useState<AgentInstallation[]>([]);
  const [toast, setToast] = useState<Toast>(null);
  const [auditFilter, setAuditFilter] = useState("全部事件");
  const [auditRecords, setAuditRecords] = useState<AuditEvent[]>([]);
  const [localHealth, setLocalHealth] = useState<LocalHealth | null>(null);

  const refreshAdminState = useCallback(async () => {
    const response = await fetch("/api/admin/agents", { cache: "no-store" });
    const payload = await response.json() as { meta?: AdminState; error?: { message?: string } };
    if (!response.ok || !payload.meta) throw new Error(payload.error?.message ?? "读取 Agent 管理状态失败");
    setDefaultAgent(payload.meta.defaultAgent);
    setVersions((current) => current.map((row) => {
      const live = payload.meta?.versions.find((item) => item.agent === row.agent && item.version === row.version);
      return live ? { ...row, status: live.state } : row;
    }));
    setInstallations(payload.meta.installations.map((installation) => {
      const rollout = payload.meta?.rollouts[installation.id];
      return rollout ? { ...installation, rolloutPercent: rollout.percent, state: rollout.state } : installation;
    }));
  }, []);

  const refreshAudit = useCallback(async () => {
    const response = await fetch("/api/admin/audit", { cache: "no-store" });
    const payload = await response.json() as { data?: Array<{ id: string; action: string; resource: string; actor: string; at: string; metadata: Record<string, unknown> }> };
    if (!response.ok || !payload.data) return;
    const live = payload.data.map<AuditEvent>((entry) => ({
      id: entry.id,
      at: new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false }),
      actor: "local/session",
      role: entry.actor,
      action: entry.action,
      target: entry.resource,
      detail: Object.entries(entry.metadata).map(([key, value]) => `${key}=${String(value)}`).join(" · ") || "不可变管理事件",
      tone: /BLOCK|ROLLBACK|REVOKE|FAIL/i.test(entry.action) ? "warning" : /APPROVE|ACTIVE|CREATED|UPDATED/i.test(entry.action) ? "success" : "neutral",
    }));
    setAuditRecords(live);
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
    const initial = window.setTimeout(() => void refreshLocalHealth(controller.signal), 0);
    const timer = window.setInterval(() => void refreshLocalHealth(controller.signal), 4_000);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refreshLocalHealth]);

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

  const permissions = agentAdminCapabilities(role);
  const canOperateVersions = permissions.manageVersions;

  const updateVersion = async (id: string, status: AgentVersionRow["status"]) => {
    if (!canOperateVersions) {
      notify("当前角色没有版本治理权限", "warning");
      return;
    }
    const row = versions.find((item) => item.id === id);
    if (!row) return;
    try {
      await adminRequest(`agent-versions/${status === "APPROVED" ? "approve" : "block"}`, {
        method: "POST",
        role,
        body: { id: `${row.agent}@${row.version}` },
      });
      await refreshAdminState();
      await refreshAudit();
      notify(status === "APPROVED" ? "版本已批准，可用于构建 WorkerImage" : "版本已阻止并写入本地审计");
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
    const catalog = row ? agents.find((item) => item.id === row.agent) : undefined;
    if (!row || !catalog) return;
    try {
      await adminRequest("agent-installations", {
        method: "POST",
        role,
        body: {
          agent: row.agent,
          version: row.version,
          workerPool: row.agent === "claude-code" ? "dev-linux-a" : "dev-linux-b",
          adapterVersion: catalog.adapterVersion.replace(/^adapter-[^@]+@/, ""),
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
      const result = await adminRequest<{ percent: number }>(`agent-rollouts/${installationId}/advance`, { method: "POST", role });
      await refreshAdminState();
      await refreshAudit();
      notify(result.percent === 100 ? "新版本已切换至 100%，仅影响新任务" : `灰度已推进至 ${result.percent}%`);
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

  const changeDefaultAgent = async (agent: AgentKind) => {
    if (!canOperateVersions) {
      notify("仅 PlatformAgentAdmin 可修改全局默认", "warning");
      return;
    }
    const profileRevisionId = agent === "claude-code" ? "profile-claude-platform-r5" : "profile-codex-platform-r2";
    try {
      await adminRequest("agent-defaults/platform", { method: "PUT", role, body: { profileRevisionId } });
      await refreshAdminState();
      await refreshAudit();
      notify(`${agent === "claude-code" ? "Claude Code" : "Codex CLI"} 已设为平台默认，仅影响新任务`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "默认 Agent 更新失败", "warning");
    }
  };

  const discoverVersions = async () => {
    if (!canOperateVersions) {
      notify("仅 PlatformAgentAdmin 可发现版本", "warning");
      return;
    }
    try {
      await adminRequest("agent-versions/discover", { method: "POST", role });
      await refreshAdminState();
      await refreshAudit();
      notify("官方候选已写入版本目录；不会自动激活", "neutral");
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
            <div className={styles.avatar}>WT</div>
            <div><strong>Wang Tianyang</strong><small>平台管理员</small></div>
            <AdminIcon name="more" />
          </div>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}><span>平台</span><AdminIcon name="chevron" /><span>管理</span><AdminIcon name="chevron" /><strong>Agents</strong></div>
          <div className={styles.topActions}>
            <div className={styles.environment}><span />本地测试环境</div>
            <button className={styles.iconButton} type="button" aria-label="搜索"><AdminIcon name="search" /></button>
            <button className={`${styles.iconButton} ${styles.bellButton}`} type="button" aria-label="通知"><AdminIcon name="bell" /><span /></button>
            <label className={styles.roleSelect}>
              <span>模拟角色</span>
              <select value={role} onChange={(event) => setRole(event.target.value as AdminRole)} aria-label="切换管理角色">
                {roleOptions.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
          </div>
        </header>

        <div className={styles.pageHeader}>
          <div>
            <div className={styles.titleRow}><h1>Agent 运维台</h1><StatusPill tone={executionReady ? "success" : "warning"}>{executionReady ? "本机可执行" : "本机执行已阻止"}</StatusPill></div>
            <p>治理开发 Agent 的版本、部署、Provider 与配置继承。运行时锁定配置，不受后续变更影响。</p>
          </div>
          <div className={styles.headerActions}>
            <button className={styles.secondaryButton} type="button" onClick={() => void discoverVersions()} disabled={!permissions.manageVersions} title={permissions.manageVersions ? undefined : "需要 PlatformAgentAdmin 权限"}><AdminIcon name="refresh" />发现版本</button>
            <button className={styles.primaryButton} type="button" onClick={() => { setActiveTab("providers"); notify("已打开 Provider 草稿编辑器", "neutral"); }} disabled={!permissions.editPlatformProvider} title={permissions.editPlatformProvider ? undefined : "当前角色不能编辑平台级 Provider"}>新建 Provider</button>
          </div>
        </div>

        <div className={styles.securityStrip}>
          <AdminIcon name="shield" />
          <div><strong>隔离策略已启用</strong><span>Agent 仅部署到一次性 Linux 开发 Worker；E2E Runner 与 Steam 发布节点不安装自主 Agent。</span></div>
          <button type="button" onClick={() => setActiveTab("inheritance")}>查看策略 <AdminIcon name="chevron" /></button>
        </div>

        <div className={styles.tabs} role="tablist" aria-label="Agent 管理分区">
          {tabs.map((tab) => (
            <button key={tab.id} className={activeTab === tab.id ? styles.tabActive : ""} onClick={() => setActiveTab(tab.id)} type="button" role="tab" aria-selected={activeTab === tab.id}>
              {tab.label}{tab.count && <span>{tab.count}</span>}
            </button>
          ))}
        </div>

        <div className={styles.content}>
          {activeTab === "overview" && <OverviewTab defaultAgent={defaultAgent} localAgents={localAgents} localHealth={localHealth} canChangeDefault={permissions.changePlatformDefault} onDefaultChange={(agent) => void changeDefaultAgent(agent)} onNavigate={setActiveTab} />}
          {activeTab === "versions" && <VersionsTab rows={versions} installations={installations} canOperate={canOperateVersions} onUpdate={updateVersion} onInstall={installVersion} />}
          {activeTab === "deployments" && <DeploymentsTab installations={installations} canOperate={permissions.manageInstallations} onAdvance={advanceRollout} onRollback={rollback} />}
          {activeTab === "providers" && <ProvidersTab role={role} localHealth={localHealth} notify={notify} onChanged={() => { void refreshAdminState(); void refreshAudit(); }} />}
          {activeTab === "inheritance" && <InheritanceTab defaultAgent={defaultAgent} notify={notify} />}
          {activeTab === "audit" && <AuditTab events={auditRecords} filter={auditFilter} localHealth={localHealth} setFilter={setAuditFilter} />}
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

function OverviewTab({ defaultAgent, localAgents, localHealth, canChangeDefault, onDefaultChange, onNavigate }: { defaultAgent: AgentKind; localAgents: LocalAgentReadiness[]; localHealth: LocalHealth | null; canChangeDefault: boolean; onDefaultChange: (agent: AgentKind) => void; onNavigate: (tab: TabId) => void }) {
  const exactMatches = localAgents.filter((agent) => agent.state === "READY").length;
  const workerReady = localHealth?.dependencies?.developmentWorker === "READY";
  return (
    <>
      <div className={styles.metricRail}>
        <div><span>本机 Agent 发现</span><strong>{localAgents.length} / 2</strong><small>只读版本探针</small></div>
        <div><span>精确版本匹配</span><strong>{exactMatches} / 2</strong><small>{exactMatches === 2 ? "均匹配锁定版本" : "不匹配时禁止启动"}</small></div>
        <div><span>Inference Gateway</span><strong>{localHealth?.dependencies?.inferenceGateway === "CONFIGURED" ? "已配置" : "未配置"}</strong><small>长期 Key 不下发 Worker</small></div>
        <div><span>开发 Worker</span><strong>{workerReady ? "READY" : "BLOCKED"}</strong><small>{workerReady ? "镜像与执行门禁已满足" : "等待版本、镜像与 Gateway"}</small></div>
      </div>

      <section className={styles.section}>
        <SectionHeading title="Agent 目录" description="首版仅支持经平台签名的两种内置 Agent；每个 WorkerImage 只包含一种 Agent。" action={<button className={styles.textButton} type="button" onClick={() => onNavigate("versions")}>管理版本 <AdminIcon name="chevron" /></button>} />
        <div className={styles.agentCatalog}>
          {agents.map((agent) => (
            <article className={`${styles.agentRow} ${defaultAgent === agent.id ? styles.agentRowDefault : ""}`} key={agent.id}>
              <AgentMark kind={agent.id} />
              <div className={styles.agentIdentity}>
                <div><h3>{agent.name}</h3><span>{agent.vendor}</span>{defaultAgent === agent.id && <StatusPill tone="info">平台默认</StatusPill>}</div>
                <p>{agent.description}</p>
                <a href={`https://${agent.source}`} target="_blank" rel="noreferrer">{agent.source}<AdminIcon name="external" /></a>
              </div>
              <div className={styles.agentMeta}>
                <span>已批准版本</span><strong>{agent.version}</strong><small>{agent.adapterVersion}</small>
              </div>
              <div className={styles.capabilities}>
                {agent.capabilities.map((capability) => <span key={capability}>{capability}</span>)}
                <small>{agent.platforms.join(" · ")}</small>
              </div>
              <div className={styles.agentActions}>
                {defaultAgent === agent.id ? <button className={styles.selectedButton} type="button" disabled><AdminIcon name="check" />已选择</button> : <button className={styles.secondaryButton} type="button" onClick={() => onDefaultChange(agent.id)} disabled={!canChangeDefault} title={canChangeDefault ? undefined : "需要 PlatformAgentAdmin 权限"}>设为默认</button>}
                <button className={styles.moreButton} type="button" aria-label={`${agent.name} 更多操作`}><AdminIcon name="more" /></button>
              </div>
            </article>
          ))}
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
                <em>{agent.state === "READY" ? "精确版本匹配" : `${agent.state} · 期望 ${agent.expectedVersion}`}</em>
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
          <thead><tr><th>Agent / 版本</th><th>官方发现</th><th>完整性</th><th>SBOM</th><th>漏洞</th><th>状态</th><th><span className={styles.srOnly}>操作</span></th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td><div className={styles.tableAgent}><AgentMark kind={row.agent} small /><div><strong>{row.agent === "claude-code" ? "Claude Code" : "Codex CLI"}</strong><code>{row.version}</code></div></div></td>
                <td>{row.releasedAt}</td><td><span className={row.integrity.includes("待") ? styles.pendingText : ""}>{row.integrity}</span></td><td>{row.sbom}</td>
                <td><span className={row.vulnerabilities.includes("1 高危") ? styles.dangerText : styles.goodText}>{row.vulnerabilities}</span></td>
                <td><StatusPill tone={row.status === "APPROVED" ? "success" : row.status === "BLOCKED" ? "danger" : "warning"}>{row.status}</StatusPill></td>
                <td>
                  {row.status === "DISCOVERED" ? <div className={styles.inlineActions}><button type="button" onClick={() => onUpdate(row.id, "APPROVED")} disabled={!canOperate}>批准</button><button type="button" onClick={() => onUpdate(row.id, "BLOCKED")} disabled={!canOperate}>阻止</button></div> : row.status === "APPROVED" ? <div className={styles.inlineActions}><button type="button" onClick={() => onInstall(row.id)} disabled={!canOperate || installations.some((item) => item.agent === row.agent && item.version === row.version)}>{installations.some((item) => item.agent === row.agent && item.version === row.version) ? "已构建" : "构建镜像"}</button></div> : <button className={styles.moreButton} type="button"><AdminIcon name="more" /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.tableFooter}><span>显示 4 个精确版本 · 无浮动通道</span><span>最后发现：2 分钟前</span></div>
    </section>
  );
}

function DeploymentsTab({ installations, canOperate, onAdvance, onRollback }: {
  installations: AgentInstallation[];
  canOperate: boolean;
  onAdvance: (installationId: string) => void;
  onRollback: (installationId: string) => void;
}) {
  return (
    <>
      <section className={styles.section}>
        <SectionHeading title="开发 Worker 安装" description="不可变镜像以 digest 部署；灰度只分配新任务，已运行任务继续使用锁定版本。" />
        {!canOperate && <div className={styles.permissionNotice}><AdminIcon name="shield" />当前角色只能查看部署。灰度、回滚与排空需要 PlatformAgentAdmin。</div>}
        {installations.map((installation) => {
          const percent = installation.rolloutPercent;
          const next = percent < 5 ? "5%" : percent < 25 ? "25%" : "100%";
          return (
            <div className={styles.installationRow} key={installation.id}>
              <AgentMark kind={installation.agent} />
              <div className={styles.installationIdentity}><h3>{installation.agent === "claude-code" ? "Claude Code" : "Codex CLI"} {installation.version}</h3><code>{installation.imageDigest.slice(0, 22)}…{installation.imageDigest.slice(-8)}</code><span>{installation.workerPool} · {installation.health} · adapter {installation.adapterVersion}</span></div>
              <div className={styles.rolloutBlock}>
                <div><span>新任务流量</span><strong>{percent}%</strong><StatusPill tone={installation.state === "ACTIVE" ? "success" : installation.state === "DRAINING" ? "warning" : "info"}>{installation.state}</StatusPill></div>
                <div className={styles.progressTrack}><span style={{ width: `${percent}%` }} /></div>
                <div className={styles.rolloutTicks}><span>5%</span><span>25%</span><span>100%</span></div>
              </div>
              <div className={styles.verticalActions}>
                <button className={styles.primaryButton} type="button" onClick={() => onAdvance(installation.id)} disabled={!canOperate || percent === 100}>推进至 {next}</button>
                <button className={styles.secondaryButton} type="button" onClick={() => onRollback(installation.id)} disabled={!canOperate || percent === 0}>回滚</button>
              </div>
            </div>
          );
        })}
        {installations.length === 0 && <div className={styles.emptyState}>尚无可信 WorkerImage。请先在版本目录批准并构建镜像。</div>}
      </section>
      <section className={styles.section}>
        <SectionHeading eyebrow="GATE" title="镜像晋级检查" description="所有检查均绑定精确 CLI、适配器与基础镜像 digest。" />
        <div className={styles.checkGrid}>
          {["官方签名与哈希", "SBOM 与许可证", "恶意软件扫描", "漏洞策略", "CLI / Adapter Contract", "沙箱逃逸测试", "合成代码任务", "无租户数据验证"].map((item, index) => <div key={item}><span className={index === 7 ? styles.checkRunning : styles.checkDone}>{index === 7 ? "···" : "✓"}</span><strong>{item}</strong><small>{index === 7 ? "持续监测" : "通过"}</small></div>)}
        </div>
      </section>
    </>
  );
}

function ProvidersTab({ role, localHealth, notify, onChanged }: { role: AdminRole; localHealth: LocalHealth | null; notify: (message: string, tone?: "success" | "warning" | "neutral") => void; onChanged: () => void }) {
  const [agent, setAgent] = useState<AgentKind>("claude-code");
  const [baseUrl, setBaseUrl] = useState("https://gateway.example.com");
  const [primaryModel, setPrimaryModel] = useState("claude-sonnet-4-5-20250929");
  const [planningModel, setPlanningModel] = useState("");
  const [fastModel, setFastModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [regionAcknowledged, setRegionAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [credentialMask, setCredentialMask] = useState("•••• •••• •••• 8D3A");
  const [draftProfileId, setDraftProfileId] = useState("");
  const permissions = agentAdminCapabilities(role);

  const protocol = agent === "claude-code" ? "Anthropic Messages / Gateway" : "OpenAI Responses";

  const validate = () => {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:") return "Base URL 仅允许 HTTPS";
      if (url.username || url.password || url.search || url.hash) return "URL 不得包含凭据、query 或 fragment";
      if (url.port && !["443", "8443"].includes(url.port)) return "端口必须为 443 或经批准的 8443";
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "127.0.0.1" || /^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "端点不能指向 loopback、私网或 link-local 地址";
    } catch {
      return "请输入有效的 HTTPS URL";
    }
    if (!primaryModel.trim()) return "Primary Model 必填";
    if (/^(latest|default|sonnet|opus|haiku)$/i.test(primaryModel.trim())) return "Active Profile 禁止使用浮动模型别名";
    if (apiKey && apiKey.length < 12) return "凭据格式过短；请使用测试凭据或留空沿用当前版本";
    if (!regionAcknowledged) return "请确认第三方端点的数据处理信息";
    return "";
  };

  const persistDraft = async () => {
    if (!permissions.editPlatformProvider) throw new Error("当前角色不能编辑平台级 Provider");
    let credentialId = agent === "claude-code" ? "cred-claude-platform-v4" : "cred-codex-platform-v2";
    if (apiKey) {
      if (!permissions.manageGlobalCredentials) throw new Error("替换平台凭据需要 SecurityAdmin 权限");
      const credential = await adminRequest<{ id: string; fingerprint: string }>("credentials", {
        method: "POST",
        role,
        body: { label: `local-${agent}-provider`, apiKey },
      });
      credentialId = credential.id;
      setCredentialMask(credential.fingerprint);
    }
    const created = await adminRequest<{ profile: { id: string } }>("agent-profiles", {
      method: "POST",
      role,
      body: {
        agent,
        baseUrl,
        primaryModel,
        planningModel,
        smallFastModel: fastModel,
        installationId: agent === "claude-code" ? "claude-installation-214" : "codex-installation-091",
        credentialId,
        scope: "platform",
        scopeId: "global",
        budgetUsd: 25,
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
      notify("Provider 草稿已写入本地控制面；当前生效配置未改变", "neutral");
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

  return (
    <div className={styles.providerLayout}>
      <section className={styles.section}>
        <SectionHeading title="生效 Provider" description="每种 Agent 使用独立协议 Schema，不执行静默跨 Agent 切换。" />
        {localHealth?.dependencies?.providerBindingProbe !== "CONFIGURED" ? <div className={styles.permissionNotice}><AdminIcon name="shield" />下列为控制面配置快照；本机没有受信 Provider 绑定探针，不能用于 Agent 执行。</div> : null}
        {!permissions.editPlatformProvider ? <div className={styles.permissionNotice}><AdminIcon name="shield" />当前角色只能查看平台 Provider。租户和项目覆盖应在对应作用域页面配置。</div> : null}
        <div className={styles.providerRows}>
          <button type="button" className={`${styles.providerRow} ${agent === "claude-code" ? styles.providerRowSelected : ""}`} onClick={() => { setAgent("claude-code"); setPrimaryModel("claude-sonnet-4-5-20250929"); setDraftProfileId(""); }}>
            <AgentMark kind="claude-code" small /><div><strong>Anthropic · cn-gateway</strong><span>Messages · claude-sonnet-4-5-20250929</span></div><StatusPill tone="success">ACTIVE</StatusPill><AdminIcon name="chevron" />
          </button>
          <button type="button" className={`${styles.providerRow} ${agent === "codex-cli" ? styles.providerRowSelected : ""}`} onClick={() => { setAgent("codex-cli"); setPrimaryModel("gpt-5.2-codex-2026-02-01"); setDraftProfileId(""); }}>
            <AgentMark kind="codex-cli" small /><div><strong>OpenAI · platform</strong><span>Responses · gpt-5.2-codex-2026-02-01</span></div><StatusPill tone="success">ACTIVE</StatusPill><AdminIcon name="chevron" />
          </button>
        </div>
        <div className={styles.credentialPanel}>
          <div className={styles.credentialIcon}><AdminIcon name="key" /></div>
          <div><span>当前 CredentialBinding</span><strong>{credentialMask}</strong><small>仅显示掩码；版本、轮换与最后使用时间由 Vault 元数据提供</small></div>
          <button type="button" disabled={!permissions.manageGlobalCredentials} title={permissions.manageGlobalCredentials ? undefined : "需要 SecurityAdmin 权限"} onClick={() => notify("已创建双版本轮换草稿；旧版本仍可回滚", "neutral")}>轮换</button>
        </div>
        <div className={styles.gatewayDiagram}>
          <div><span>Agent Worker</span><small>短期 run token</small></div><i>→</i><div className={styles.gatewayCore}><span>Inference Gateway</span><small>白名单 · 配额 · 审计</small></div><i>→</i><div><span>第三方端点</span><small>上游 Key 仅在 Gateway</small></div>
        </div>
      </section>

      <form className={`${styles.section} ${styles.providerForm}`} onSubmit={saveDraft} noValidate>
        <SectionHeading eyebrow="DRAFT" title="编辑 Provider" description="保存草稿与测试激活分离；本地 API 不会在缺少受信 Connector 时访问上游。" />
        <div className={styles.formGroup}>
          <label>Agent</label>
          <div className={styles.segmented}>
            <button className={agent === "claude-code" ? styles.segmentActive : ""} type="button" disabled={!permissions.editPlatformProvider} onClick={() => { setAgent("claude-code"); setPrimaryModel("claude-sonnet-4-5-20250929"); setDraftProfileId(""); }}>Claude Code</button>
            <button className={agent === "codex-cli" ? styles.segmentActive : ""} type="button" disabled={!permissions.editPlatformProvider} onClick={() => { setAgent("codex-cli"); setPrimaryModel("gpt-5.2-codex-2026-02-01"); setDraftProfileId(""); }}>Codex CLI</button>
          </div>
        </div>
        <div className={styles.formGroup}><label htmlFor="protocol">协议</label><input id="protocol" value={protocol} disabled /><small>协议由 Agent Adapter 固定，不可混用。</small></div>
        <div className={styles.formGroup}><label htmlFor="baseUrl">Base URL</label><input id="baseUrl" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck="false" disabled={!permissions.editPlatformProvider} /><small>仅 HTTPS；DNS 与每次 redirect 都会重新执行 SSRF 校验。</small></div>
        <div className={styles.formGroup}><label htmlFor="primaryModel">Primary Model <em>必填</em></label><input id="primaryModel" value={primaryModel} onChange={(event) => setPrimaryModel(event.target.value)} spellCheck="false" disabled={!permissions.editPlatformProvider} /><small>必须是精确模型 ID，禁止 latest / default / sonnet 等浮动别名。</small></div>
        <div className={styles.fieldPair}>
          <div className={styles.formGroup}><label htmlFor="planningModel">Planning Model</label><input id="planningModel" value={planningModel} onChange={(event) => setPlanningModel(event.target.value)} placeholder="留空则固定到 Primary" disabled={!permissions.editPlatformProvider} /></div>
          <div className={styles.formGroup}><label htmlFor="fastModel">Small / Fast Model</label><input id="fastModel" value={fastModel} onChange={(event) => setFastModel(event.target.value)} placeholder="留空则固定到 Primary" disabled={!permissions.editPlatformProvider} /></div>
        </div>
        <div className={styles.formGroup}><label htmlFor="apiKey">替换 API Key</label><div className={styles.keyInput}><AdminIcon name="key" /><input id="apiKey" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="留空以沿用当前凭据版本" autoComplete="new-password" disabled={!permissions.manageGlobalCredentials} /></div><small>写入后立即清空；数据库仅保存 SecretRef、掩码与不可逆指纹。平台凭据仅由 SecurityAdmin 替换。</small></div>
        <label className={styles.checkLabel}><input type="checkbox" checked={regionAcknowledged} onChange={(event) => setRegionAcknowledged(event.target.checked)} disabled={!permissions.editPlatformProvider} /><span>已确认该端点的数据地域、保留期限、训练政策及源码处理范围。</span></label>
        {error && <div className={styles.formError}><AdminIcon name="alert" />{error}</div>}
        <div className={styles.probeList}><span>激活探针</span><div>{["认证", "模型", "流式", "工具", "取消", "Usage", "超时", "无工具"].map((probe) => <em key={probe}>{probe}</em>)}</div></div>
        <div className={styles.formActions}><button className={styles.secondaryButton} type="submit" disabled={testing || !permissions.editPlatformProvider}>保存草稿</button><button className={styles.primaryButton} type="button" disabled={testing || !permissions.activatePlatformProvider} title={permissions.activatePlatformProvider ? undefined : "需要 SecurityAdmin 权限"} onClick={testAndActivate}>{testing ? "正在校验门禁…" : "测试并激活"}</button></div>
      </form>
    </div>
  );
}

function InheritanceTab({ defaultAgent, notify }: { defaultAgent: AgentKind; notify: (message: string, tone?: "success" | "warning" | "neutral") => void }) {
  const [project, setProject] = useState("clockwork-island");
  const resolved = project === "clockwork-island" ? "codex-cli" : defaultAgent;
  return (
    <>
      <section className={styles.section}>
        <SectionHeading title="有效配置解析" description="项目覆盖 → 租户覆盖 → 平台默认；下级只能收紧平台安全策略与允许列表。" action={<select className={styles.projectSelect} value={project} onChange={(event) => setProject(event.target.value)}><option value="clockwork-island">Clockwork Island</option><option value="paper-kingdom">Paper Kingdom</option></select>} />
        <div className={styles.inheritanceFlow}>
          <div className={styles.inheritanceNode}><span>平台默认</span><AgentMark kind={defaultAgent} small /><strong>{defaultAgent === "claude-code" ? "Claude Code" : "Codex CLI"}</strong><small>profile/platform/claude-prod · rev 18</small><StatusPill tone="neutral">起点</StatusPill></div>
          <AdminIcon name="chevron" />
          <div className={styles.inheritanceNode}><span>Studio North · 租户</span><AgentMark kind="claude-code" small /><strong>Claude Code</strong><small>允许 Claude + Codex · 预算 $120/run</small><StatusPill tone="neutral">继承</StatusPill></div>
          <AdminIcon name="chevron" />
          <div className={`${styles.inheritanceNode} ${styles.inheritanceNodeEffective}`}><span>{project === "clockwork-island" ? "Clockwork Island" : "Paper Kingdom"} · 项目</span><AgentMark kind={resolved as AgentKind} small /><strong>{resolved === "codex-cli" ? "Codex CLI" : "Claude Code"}</strong><small>{project === "clockwork-island" ? "显式项目覆盖 · profile/codex-strict · rev 6" : "无项目覆盖 · 继承租户配置"}</small><StatusPill tone="info">EFFECTIVE</StatusPill></div>
        </div>
        <div className={styles.resolutionTable}>
          <div><span>Installation</span><strong>{resolved === "codex-cli" ? "codex-0.91.0 / dev-linux-b" : "claude-2.1.14 / dev-linux-a"}</strong><small>来源：{project === "clockwork-island" ? "项目覆盖" : "平台默认"}</small></div>
          <div><span>Provider / Model</span><strong>{resolved === "codex-cli" ? "OpenAI Responses" : "Anthropic Messages"}</strong><small>{resolved === "codex-cli" ? "gpt-5.2-codex-2026-02-01" : "claude-sonnet-4-5-20250929"}</small></div>
          <div><span>权限</span><strong>workspace-write</strong><small>网络仅 SCM / inference 代理</small></div>
          <div><span>任务预算 / 超时</span><strong>$80 · 90 min</strong><small>租户策略收紧平台上限</small></div>
        </div>
        <div className={styles.lockNotice}><AdminIcon name="layers" /><div><strong>入队快照</strong><span>每个 AgentRun 永久记录 profile revision、installation、image digest、adapter、精确模型与 credential version。后台变更不会漂移已排队或运行中的任务。</span></div><button type="button" onClick={() => notify("已复制有效配置摘要", "neutral")}>复制摘要</button></div>
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

function AuditTab({ events, filter, localHealth, setFilter }: { events: AuditEvent[]; filter: string; localHealth: LocalHealth | null; setFilter: (value: string) => void }) {
  const filtered = useMemo(() => filter === "全部事件" ? events : events.filter((event) => filter === "仅告警" ? event.tone === "warning" : event.action.includes("PROVIDER") || event.action.includes("CREDENTIAL") || event.action.includes("Provider") || event.action.includes("凭据")), [events, filter]);
  const readyAgents = localHealth?.dependencies?.localAgents?.filter((agent) => agent.state === "READY").length ?? 0;
  const workerReady = localHealth?.dependencies?.developmentWorker === "READY";
  return (
    <>
      <div className={styles.healthBanner}>
        <div><span className={styles.pulseRing}><i /></span><div><strong>{workerReady ? "本机 Agent Worker 就绪" : "本机 Agent 执行受门禁保护"}</strong><small>数据来自当前 `/api/health`，不使用模拟在线数</small></div></div>
        <dl><div><dt>精确 CLI</dt><dd>{readyAgents} / 2</dd></div><div><dt>Inference Gateway</dt><dd>{localHealth?.dependencies?.inferenceGateway === "CONFIGURED" ? "已配置" : "未配置"}</dd></div><div><dt>Provider 绑定</dt><dd>{localHealth?.dependencies?.providerBindingProbe === "CONFIGURED" ? "已验证" : "未配置"}</dd></div><div><dt>开发 Worker</dt><dd>{workerReady ? "READY" : "BLOCKED"}</dd></div></dl>
      </div>
      <section className={styles.section}>
        <SectionHeading title="不可变审计记录" description="配置 revision、探针、版本治理和凭据使用均记录 actor、差异与幂等键。" action={<select className={styles.projectSelect} value={filter} onChange={(event) => setFilter(event.target.value)}><option>全部事件</option><option>仅告警</option><option>Provider / 凭据</option></select>} />
        <div className={styles.auditTimeline}>
          {filtered.map((event) => <div className={styles.auditEvent} key={event.id}><time>{event.at}</time><span className={`${styles.auditDot} ${styles[`audit_${event.tone}`]}`} /><div><div><strong>{event.action}</strong><span>{event.target}</span></div><p>{event.detail}</p><small>{event.actor} · {event.role}</small></div><button className={styles.moreButton} type="button"><AdminIcon name="more" /></button></div>)}
          {filtered.length === 0 && <div className={styles.emptyState}>当前筛选条件下没有事件</div>}
        </div>
        <div className={styles.tableFooter}><span>审计保留 365 天 · WORM 存储</span><button type="button">导出 NDJSON</button></div>
      </section>
    </>
  );
}
