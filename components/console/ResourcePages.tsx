"use client";

import { useState } from "react";
import { evidenceBundles, runnerFleet } from "@/lib/demo/platform-data";
import { AppShell } from "./AppShell";
import { CheckIcon, FileIcon, ServerIcon, ShieldIcon } from "./Icons";

export function RunnersPage() {
  const [selected, setSelected] = useState("Windows");
  return (
    <AppShell>
      <section className="page-heading resource-heading"><div><span className="eyebrow">跨平台执行面</span><h1>运行节点</h1><p>通过出站 mTLS 注册的 E2E Runner；开发 Agent 不会安装在这些节点。</p></div><span className="resource-stat"><b>8</b><small>在线节点</small></span></section>
      <div className="resource-grid">
        <section className="resource-list">
          {runnerFleet.map((runner) => (
            <button className={selected === runner.os ? "selected" : ""} key={runner.os} onClick={() => setSelected(runner.os)} type="button">
              <span className="resource-os">{runner.os.slice(0, 1)}</span>
              <span><b>{runner.os}</b><small>{runner.detail}</small></span>
              <span><i /> {runner.online} / {runner.count} 在线</span>
            </button>
          ))}
        </section>
        <aside className="resource-detail">
          <span className="detail-icon"><ServerIcon /></span><span className="eyebrow">节点详情</span><h2>{selected} 集群</h2>
          <dl><div><dt>注册模式</dt><dd>出站 mTLS</dd></div><div><dt>Godot</dt><dd>4.5.1 · digest 固定</dd></div><div><dt>显示能力</dt><dd>1920×1080 · GPU</dd></div><div><dt>当前租约</dt><dd>2 个任务</dd></div></dl>
          <div className="fencing-note"><ShieldIcon /><span><b>防迟到结果</b><small>attempt_id、fencing_token 和 seq_no 不匹配的结果会被丢弃。</small></span></div>
        </aside>
      </div>
    </AppShell>
  );
}

export function EvidencePage() {
  const [verified, setVerified] = useState<string | null>(null);
  return (
    <AppShell>
      <section className="page-heading resource-heading"><div><span className="eyebrow">可追溯交付</span><h1>证据中心</h1><p>每个包绑定同一规格、测试计划、提交和目标矩阵，并由平台签名。</p></div><span className="resource-stat"><b>2</b><small>有效证据包</small></span></section>
      {verified ? <div className="inline-notice"><CheckIcon /> {verified} 的签名、提交和构建摘要一致。</div> : null}
      <section className="evidence-table-panel">
        <div className="evidence-head"><span>证据包</span><span>平台</span><span>提交</span><span>测试</span><span>签名</span><span>生成时间</span><span /></div>
        {evidenceBundles.map((bundle) => (
          <div className="evidence-row" key={bundle.id}>
            <span><FileIcon /><b>{bundle.id}</b></span><span>{bundle.platform}</span><span className="mono">{bundle.commit}</span><span>{bundle.tests}</span><span className={bundle.signed ? "signed" : "invalid"}>{bundle.signed ? "有效" : "已失效"}</span><span>{bundle.createdAt}</span><button disabled={!bundle.signed} onClick={() => setVerified(bundle.id)} type="button">验证</button>
          </div>
        ))}
      </section>
    </AppShell>
  );
}
