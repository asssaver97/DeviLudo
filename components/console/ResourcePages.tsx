"use client";

import Link from "next/link";
import { useState } from "react";
import { AppShell } from "./AppShell";
import { CheckIcon, FileIcon, ServerIcon, ShieldIcon } from "./Icons";
import { ProjectScopeSelector } from "./ProjectScopeSelector";
import { useEvidenceCatalog } from "./useEvidenceCatalog";
import { useLocalPlatform } from "./useLocalPlatform";
import { useProjectSelection } from "./useProjectCatalog";
import { useRunnerFleet } from "./useRunnerFleet";

type RunnerView = {
  os: "macOS" | "Windows" | "Linux";
  online: boolean;
  detail: string;
  targetState: string;
};

export function RunnersPage() {
  const [selected, setSelected] = useState<RunnerView["os"]>("macOS");
  const { projects, project, selectedProjectId, selectProject, mode, loading: projectsLoading, error: projectError } = useProjectSelection();
  const { delivery, productionDelivery, health, error: deliveryError } = useLocalPlatform(selectedProjectId);
  const { fleet, error: fleetError } = useRunnerFleet(selectedProjectId, mode === "PRODUCTION");
  const error = projectError || deliveryError || fleetError;
  const productionTargetState = (platform: "linux" | "windows" | "macos") => {
    if (!productionDelivery?.targetMatrix.includes(platform)) return "NOT_SELECTED";
    if (productionDelivery.candidateEvidenceBundleId) return "PASSED";
    return productionDelivery.state === "CROSS_PLATFORM_E2E" ? "RUNNING" : "QUEUED";
  };
  const runnerView = (os: RunnerView["os"], platform: "linux" | "macos" | "windows"): RunnerView => {
    const projected = fleet?.runners.find((runner) => runner.platform === platform);
    if (mode === "PRODUCTION") return {
      os,
      online: projected?.connectivity === "READY",
      detail: projected
        ? `${projected.runnerId} · ${projected.architecture} · ${projected.connectivity}`
        : "尚无该项目的 Runner 租约",
      targetState: productionTargetState(platform),
    };
    return {
      os,
      online: platform === "macos" && health?.dependencies?.fixtureExecutor === "READY",
      detail: platform === "macos" ? health?.dependencies?.localGodot ?? "本机 Godot 未连接" : "等待出站 mTLS Runner 注册",
      targetState: delivery?.targetResults[platform] ?? "NOT_SELECTED",
    };
  };
  const runners: RunnerView[] = [runnerView("macOS", "macos"), runnerView("Windows", "windows"), runnerView("Linux", "linux")];
  const selectedRunner = runners.find((runner) => runner.os === selected) ?? runners[0];
  const onlineCount = runners.filter((runner) => runner.online).length;
  return (
    <AppShell>
      <section className="page-heading resource-heading">
        <div><span className="eyebrow">跨平台执行面 · {mode === "LOCAL_FIXTURE" ? "本地实况" : "生产投影"}</span><h1>运行节点</h1><p>{error ? `状态读取失败：${error}` : project ? `${project.name} 的目标矩阵与已注册 Runner；开发 Agent 不会安装在这些节点。` : projectsLoading ? "正在读取可访问项目…" : "创建或绑定项目后查看目标矩阵。"}</p></div>
        <div className="resource-heading-actions"><ProjectScopeSelector projects={projects} selectedProjectId={selectedProjectId} onChange={selectProject} /><span className="resource-stat"><b>{project ? onlineCount : 0}</b><small>在线节点</small></span></div>
      </section>
      {!project ? <EmptyProjectResource loading={projectsLoading} noun="运行节点" /> : (
      <div className="resource-grid">
        <section className="resource-list">
          {runners.map((runner) => (
            <button className={selected === runner.os ? "selected" : ""} key={runner.os} onClick={() => setSelected(runner.os)} type="button">
              <span className="resource-os">{runner.os.slice(0, 1)}</span>
              <span><b>{runner.os}</b><small>{runner.detail}</small></span>
              <span><i className={runner.online ? "" : "offline"} /> {runner.online ? "1 / 1 在线" : "未连接"}</span>
            </button>
          ))}
        </section>
        <aside className="resource-detail">
          <span className="detail-icon"><ServerIcon /></span><span className="eyebrow">节点详情</span><h2>{selectedRunner.os} {selectedRunner.online ? "本机节点" : "目标集群"}</h2>
          <dl><div><dt>连接状态</dt><dd>{selectedRunner.online ? "READY" : "NOT_CONNECTED"}</dd></div><div><dt>运行时</dt><dd>{selectedRunner.detail}</dd></div><div><dt>目标门禁</dt><dd>{selectedRunner.targetState}</dd></div><div><dt>注册模式</dt><dd>{mode === "LOCAL_FIXTURE" && selectedRunner.os === "macOS" ? "loopback 侧车" : "出站 mTLS"}</dd></div></dl>
          <div className="fencing-note"><ShieldIcon /><span><b>防迟到结果</b><small>attempt_id、fencing_token 和 seq_no 不匹配的结果会被丢弃。</small></span></div>
        </aside>
      </div>
      )}
    </AppShell>
  );
}

export function EvidencePage() {
  const { projects, project, selectedProjectId, selectProject, mode, loading: projectsLoading, error: projectError } = useProjectSelection();
  const { delivery, productionDelivery, error: deliveryError } = useLocalPlatform(selectedProjectId);
  const { catalog, error: catalogError } = useEvidenceCatalog(selectedProjectId, mode === "PRODUCTION");
  const [verification, setVerification] = useState<{ projectId: string; evidenceId: string; message: string; ok: boolean } | null>(null);
  const error = projectError || deliveryError || catalogError;
  const evidence = delivery?.localValidation ?? null;
  const productionEntries = catalog?.entries ?? [];
  const currentEvidenceIds = new Set([
    productionDelivery?.evidenceBundleId,
    productionDelivery?.candidateEvidenceBundleId,
    productionDelivery?.mainEvidenceBundleId,
    productionDelivery?.steamInstallEvidenceBundleId,
  ].filter((value): value is string => Boolean(value)));
  const validProductionEvidence = productionEntries.filter((entry) => entry.invalidatedAt === null && entry.bundle.status === "PASSED").length;

  async function verifyEvidence() {
    if (!evidence || !selectedProjectId) return;
    try {
      const base = `/api/projects/${encodeURIComponent(selectedProjectId)}/local-validation/evidence`;
      const [manifestResponse, junitResponse, logResponse] = await Promise.all([
        fetch(`${base}/manifest.json`, { cache: "no-store" }),
        fetch(`${base}/junit.xml`, { cache: "no-store" }),
        fetch(`${base}/godot.log`, { cache: "no-store" }),
      ]);
      if (!manifestResponse.ok || !junitResponse.ok || !logResponse.ok) throw new Error("无法读取完整证据包");
      const manifest = JSON.parse(await manifestResponse.text()) as Record<string, unknown> & {
        evidenceId?: string;
        candidateSha?: string;
        bundleDigest?: string;
        artifactDigests?: Record<string, string>;
      };
      const junit = await junitResponse.text();
      const log = await logResponse.text();
      const { evidenceId, bundleDigest, ...unsigned } = manifest;
      const ok = manifest.evidenceId === evidence.evidenceId
        && manifest.candidateSha === evidence.candidateSha
        && bundleDigest === evidence.bundleDigest
        && evidenceId === `EV-LOCAL-${String(bundleDigest).slice(0, 12).toUpperCase()}`
        && bundleDigest === await sha256(JSON.stringify(unsigned))
        && manifest.artifactDigests?.["junit.xml"] === await sha256(junit)
        && manifest.artifactDigests?.["godot.log"] === await sha256(log);
      setVerification({ projectId: selectedProjectId, evidenceId: evidence.evidenceId, ok, message: ok ? "清单、Git 提交、bundle、JUnit 与日志摘要一致。" : "证据内容摘要不一致，已拒绝验证。" });
    } catch (reason) {
      setVerification({ projectId: selectedProjectId, evidenceId: evidence.evidenceId, ok: false, message: reason instanceof Error ? reason.message : "证据验证失败" });
    }
  }

  return (
    <AppShell>
      <section className="page-heading resource-heading">
        <div><span className="eyebrow">可追溯交付 · {mode === "LOCAL_FIXTURE" ? "本地实况" : "生产投影"}</span><h1>证据中心</h1><p>{error ? `状态读取失败：${error}` : project ? `${project.name} 的证据绑定冻结规格、锁定提交与目标矩阵；Web 进程不读取生产制品库。` : projectsLoading ? "正在读取可访问项目…" : "创建或绑定项目后查看交付证据。"}</p></div>
        <div className="resource-heading-actions"><ProjectScopeSelector projects={projects} selectedProjectId={selectedProjectId} onChange={selectProject} /><span className="resource-stat"><b>{project ? evidence?.valid ? 1 : validProductionEvidence : 0}</b><small>有效证据包</small></span></div>
      </section>
      {!project ? <EmptyProjectResource loading={projectsLoading} noun="交付证据" /> : <>
      {verification?.projectId === selectedProjectId ? <div className={`inline-notice ${verification.ok ? "" : "danger"}`}><CheckIcon /> {verification.evidenceId}：{verification.message}</div> : null}
      <section className="evidence-table-panel">
        <div className="evidence-head"><span>证据包</span><span>平台</span><span>提交</span><span>测试</span><span>签名</span><span>生成时间</span><span /></div>
        {evidence ? (
          <div className="evidence-row" key={evidence.evidenceId}>
            <span><FileIcon /><b>{evidence.evidenceId}</b></span><span>macOS 本机</span><span className="mono" title={evidence.candidateSha}>{evidence.candidateSha.slice(0, 7)}</span><span>{evidence.checks.filter((check) => check.status === "PASSED").length} / {evidence.checks.length}</span><span className={evidence.valid ? "signed" : "invalid"}>{evidence.valid ? "有效" : "已失效"}</span><span>{new Date(evidence.createdAt).toLocaleString("zh-CN")}</span><button disabled={!evidence.valid} onClick={() => void verifyEvidence()} type="button">验证</button>
          </div>
        ) : productionEntries.length ? (
          productionEntries.map((entry) => {
          const passed = entry.bundle.platformEvidence.filter((platform) => platform.status === "PASSED").length;
          const valid = entry.invalidatedAt === null && entry.bundle.status === "PASSED";
          return (
            <div className="evidence-row" key={entry.evidenceBundleId}>
              <span title={entry.bundle.bundleDigest}><FileIcon /><b>{entry.evidenceBundleId}</b></span>
              <span>{entry.bundle.platformEvidence.map((platform) => `${platform.platform}:${platform.status}`).join(" / ")}</span>
              <span className="mono" title={entry.bundle.commitSha}>{entry.bundle.commitSha.slice(0, 12)}</span>
              <span>{passed} / {entry.bundle.platformEvidence.length}</span>
              <span className={valid ? "signed" : "invalid"}>{entry.invalidatedAt ? "已失效" : entry.bundle.status === "PASSED" ? "有效" : "失败"}</span>
              <span>{new Date(entry.bundle.createdAt).toLocaleString("zh-CN")}</span>
              <button disabled type="button">{currentEvidenceIds.has(entry.evidenceBundleId) ? "当前门禁" : "历史证据"}</button>
            </div>
          );
          })
        ) : <div className="evidence-empty"><FileIcon /><b>尚无真实证据</b><span>完成锁定目标矩阵后，权威投影会显示证据引用。</span></div>}
      </section>
      {evidence && selectedProjectId ? <div className="evidence-artifacts"><b>原始证据</b><a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/local-validation/evidence/manifest.json`} target="_blank" rel="noreferrer">manifest.json</a><a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/local-validation/evidence/junit.xml`} target="_blank" rel="noreferrer">JUnit XML</a><a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/local-validation/evidence/godot.log`} target="_blank" rel="noreferrer">Godot 日志</a><span>{evidence.godotVersion} · {evidence.releaseGate === "WAITING_EXPORT_TEMPLATES" ? "等待导出模板" : "本地门禁通过"}</span></div> : null}
      {!evidence && catalog ? <div className="evidence-artifacts"><b>权威目录</b><span>{catalog.entries.length} 个不可变 manifest</span><span>读取时间 {new Date(catalog.observedAt).toLocaleString("zh-CN")}</span><span>S3 对象键与下载授权保持隔离</span></div> : null}
      </>}
    </AppShell>
  );
}

function EmptyProjectResource({ loading, noun }: { loading: boolean; noun: string }) {
  return <section className="resource-empty-project"><FileIcon /><h2>{loading ? "正在同步项目目录" : `还没有可用于${noun}的项目`}</h2><p>此页面不会以固定演示项目替代当前租户的真实项目。</p>{!loading ? <Link className="button button-acid" href="/projects/new">创建第一个项目</Link> : null}</section>;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
