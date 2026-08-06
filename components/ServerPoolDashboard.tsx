"use client";

import { useEffect, useState } from "react";
import { cachedValue, clientCacheKeys, loadCached } from "@/lib/product/client-cache";
import type { ServerNodeRecord, ServerPoolRecord } from "@/lib/runtime/server-pools";
import { useLanguage } from "./i18n/LanguageProvider";

type PoolResponse = Readonly<{ pools: readonly ServerPoolRecord[]; nodes: readonly ServerNodeRecord[] }>;

export function ServerPoolDashboard() {
  const { text } = useLanguage();
  const initialState = cachedValue<PoolResponse>(clientCacheKeys.serverPools);
  const [state, setState] = useState<PoolResponse | null>(initialState ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadCached<PoolResponse>(clientCacheKeys.serverPools, 15_000, async () => {
        const response = await fetch("/api/admin/server-pools", { cache: "no-store" });
        if (!response.ok) throw new Error(text(`服务器池接口返回 ${response.status}`, `Server pool API returned ${response.status}`));
        return await response.json() as PoolResponse;
      })
      .then(value => { if (active) setState(value); })
      .catch(reason => {
        if (active) setError(reason instanceof Error ? reason.message : text("加载失败", "Unable to load"));
      });
    return () => { active = false; };
  }, [text]);

  if (error) return <div className="inline-notice danger">{error}</div>;
  if (!state) return <section className="resource-empty-project">{text("正在读取五类服务器池状态…", "LOADING FIVE SERVER POOLS…")}</section>;

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
              <div><strong>{pool.activeNodes}</strong><small>{text("活动", "ACTIVE")}</small></div>
              <div><strong>{pool.desiredNodes}</strong><small>{text("期望", "DESIRED")}</small></div>
              <div><strong>{pool.maximumNodes}</strong><small>{text("上限", "MAX")}</small></div>
            </div>
            <div className="capabilities">{pool.capabilities.join(" · ")}</div>
            <ul className="nodeList">
              {nodes.length === 0 ? <li><span>{text("无常驻节点", "No resident nodes")}</span><span>{text("按需", "ON DEMAND")}</span></li> : nodes.map(node => (
                <li key={node.id}><span>{node.id}</span><span>{node.state}</span></li>
              ))}
            </ul>
          </article>
        );
      })}
    </div>
  );
}
