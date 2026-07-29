"use client";

import { useEffect, useState } from "react";
import type { ServerNodeRecord, ServerPoolRecord } from "@/lib/runtime/server-pools";

type PoolResponse = Readonly<{ pools: readonly ServerPoolRecord[]; nodes: readonly ServerNodeRecord[] }>;

export function ServerPoolDashboard() {
  const [state, setState] = useState<PoolResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/server-pools", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`服务器池接口返回 ${response.status}`);
        return await response.json() as PoolResponse;
      })
      .then(setState)
      .catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "加载失败");
      });
    return () => controller.abort();
  }, []);

  if (error) return <div className="inline-notice danger">{error}</div>;
  if (!state) return <section className="resource-empty-project">正在读取五类服务器池状态…</section>;

  return (
    <div className="poolGrid">
      {state.pools.map(pool => {
        const nodes = state.nodes.filter(node => node.poolKind === pool.kind);
        return (
          <article className="resource-detail poolCard" key={pool.kind}>
            <header>
              <div>
                <h2>{pool.kind}</h2>
                <div className="capabilities">{pool.operatingSystem}</div>
              </div>
              <span className="badge">{pool.readiness}</span>
            </header>
            <div className="metrics">
              <div><strong>{pool.activeNodes}</strong><small>活动</small></div>
              <div><strong>{pool.desiredNodes}</strong><small>期望</small></div>
              <div><strong>{pool.maximumNodes}</strong><small>上限</small></div>
            </div>
            <div className="capabilities">{pool.capabilities.join(" · ")}</div>
            <ul className="nodeList">
              {nodes.length === 0 ? <li><span>无常驻节点</span><span>按需</span></li> : nodes.map(node => (
                <li key={node.id}><span>{node.id}</span><span>{node.state}</span></li>
              ))}
            </ul>
          </article>
        );
      })}
    </div>
  );
}
