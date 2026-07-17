"use client";

import { useState } from "react";
import { AppShell } from "./AppShell";
import { CheckIcon, FileIcon, ServerIcon, ShieldIcon } from "./Icons";
import { useLocalPlatform } from "./useLocalPlatform";

const projectId = "ember-archipelago";

type RunnerView = {
  os: "macOS" | "Windows" | "Linux";
  online: boolean;
  detail: string;
  targetState: string;
};

export function RunnersPage() {
  const [selected, setSelected] = useState<RunnerView["os"]>("macOS");
  const { delivery, health, error } = useLocalPlatform(projectId);
  const runners: RunnerView[] = [
    {
      os: "macOS",
      online: health?.dependencies?.fixtureExecutor === "READY",
      detail: health?.dependencies?.localGodot ?? "本机 Godot 未连接",
      targetState: delivery?.targetResults.macos ?? "QUEUED",
    },
    { os: "Windows", online: false, detail: "等待出站 mTLS Runner 注册", targetState: delivery?.targetResults.windows ?? "QUEUED" },
    { os: "Linux", online: false, detail: "等待出站 mTLS Runner 注册", targetState: delivery?.targetResults.linux ?? "QUEUED" },
  ];
  const selectedRunner = runners.find((runner) => runner.os === selected) ?? runners[0];
  const onlineCount = runners.filter((runner) => runner.online).length;
  return (
    <AppShell>
      <section className="page-heading resource-heading"><div><span className="eyebrow">跨平台执行面 · 本地实况</span><h1>运行节点</h1><p>{error ? `状态读取失败：${error}` : "本机侧车与未来通过出站 mTLS 注册的 E2E Runner；开发 Agent 不会安装在这些节点。"}</p></div><span className="resource-stat"><b>{onlineCount}</b><small>在线节点</small></span></section>
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
          <dl><div><dt>连接状态</dt><dd>{selectedRunner.online ? "READY" : "NOT_CONNECTED"}</dd></div><div><dt>运行时</dt><dd>{selectedRunner.detail}</dd></div><div><dt>目标门禁</dt><dd>{selectedRunner.targetState}</dd></div><div><dt>注册模式</dt><dd>{selectedRunner.os === "macOS" ? "loopback 侧车" : "出站 mTLS"}</dd></div></dl>
          <div className="fencing-note"><ShieldIcon /><span><b>防迟到结果</b><small>attempt_id、fencing_token 和 seq_no 不匹配的结果会被丢弃。</small></span></div>
        </aside>
      </div>
    </AppShell>
  );
}

export function EvidencePage() {
  const { delivery, error } = useLocalPlatform(projectId);
  const [verification, setVerification] = useState<{ evidenceId: string; message: string; ok: boolean } | null>(null);
  const evidence = delivery?.localValidation ?? null;

  async function verifyEvidence() {
    if (!evidence) return;
    try {
      const base = `/api/projects/${projectId}/local-validation/evidence`;
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
      setVerification({ evidenceId: evidence.evidenceId, ok, message: ok ? "清单、Git 提交、bundle、JUnit 与日志摘要一致。" : "证据内容摘要不一致，已拒绝验证。" });
    } catch (reason) {
      setVerification({ evidenceId: evidence.evidenceId, ok: false, message: reason instanceof Error ? reason.message : "证据验证失败" });
    }
  }

  return (
    <AppShell>
      <section className="page-heading resource-heading"><div><span className="eyebrow">可追溯交付 · 本地实况</span><h1>证据中心</h1><p>{error ? `状态读取失败：${error}` : "真实本机证据绑定冻结规格、隔离 Git 提交、Godot 版本和构建摘要；缺少依赖时保持门禁。"}</p></div><span className="resource-stat"><b>{evidence?.valid ? 1 : 0}</b><small>有效证据包</small></span></section>
      {verification ? <div className={`inline-notice ${verification.ok ? "" : "danger"}`}><CheckIcon /> {verification.evidenceId}：{verification.message}</div> : null}
      <section className="evidence-table-panel">
        <div className="evidence-head"><span>证据包</span><span>平台</span><span>提交</span><span>测试</span><span>签名</span><span>生成时间</span><span /></div>
        {evidence ? (
          <div className="evidence-row" key={evidence.evidenceId}>
            <span><FileIcon /><b>{evidence.evidenceId}</b></span><span>macOS 本机</span><span className="mono" title={evidence.candidateSha}>{evidence.candidateSha.slice(0, 7)}</span><span>{evidence.checks.filter((check) => check.status === "PASSED").length} / {evidence.checks.length}</span><span className={evidence.valid ? "signed" : "invalid"}>{evidence.valid ? "有效" : "已失效"}</span><span>{new Date(evidence.createdAt).toLocaleString("zh-CN")}</span><button disabled={!evidence.valid} onClick={() => void verifyEvidence()} type="button">验证</button>
          </div>
        ) : <div className="evidence-empty"><FileIcon /><b>尚无真实证据</b><span>批准项目规格后，在项目页运行“真实本机验证”。</span></div>}
      </section>
      {evidence ? <div className="evidence-artifacts"><b>原始证据</b><a href={`/api/projects/${projectId}/local-validation/evidence/manifest.json`} target="_blank" rel="noreferrer">manifest.json</a><a href={`/api/projects/${projectId}/local-validation/evidence/junit.xml`} target="_blank" rel="noreferrer">JUnit XML</a><a href={`/api/projects/${projectId}/local-validation/evidence/godot.log`} target="_blank" rel="noreferrer">Godot 日志</a><span>{evidence.godotVersion} · {evidence.releaseGate === "WAITING_EXPORT_TEMPLATES" ? "等待导出模板" : "本地门禁通过"}</span></div> : null}
    </AppShell>
  );
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
