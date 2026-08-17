"use client";

import { useEffect, useState } from "react";
import { cachedValue, clientCacheKeys, loadCached } from "@/lib/product/client-cache";
import type { ServerNodeRecord, ServerPoolRecord } from "@/lib/runtime/server-pools";
import { useLanguage } from "./i18n/LanguageProvider";

type PoolResponse = Readonly<{ pools: readonly ServerPoolRecord[]; nodes: readonly ServerNodeRecord[] }>;
type Enrollment = Readonly<{ poolKind: string; token: string; expiresAt: string }>;

export function ServerPoolDashboard() {
  const { errorText, text } = useLanguage();
  const initialState = cachedValue<PoolResponse>(clientCacheKeys.serverPools);
  const [state, setState] = useState<PoolResponse | null>(initialState ?? null);
  const [error, setError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [enrollmentBusy, setEnrollmentBusy] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async (maximumAge: number) => loadCached<PoolResponse>(clientCacheKeys.serverPools, maximumAge, async () => {
        const response = await fetch("/api/runtime/server-pools", { cache: "no-store" });
        if (!response.ok) throw new Error(text(`服务器池接口返回 ${response.status}`, `Server pool API returned ${response.status}`));
        return await response.json() as PoolResponse;
      });
    const refresh = (maximumAge: number) => {
      void load(maximumAge)
      .then(value => { if (active) setState(value); })
      .catch(reason => {
        if (active) setError(reason instanceof Error ? reason.message : text("加载失败", "Unable to load"));
      });
    };
    refresh(15_000);
    const timer = window.setInterval(() => refresh(0), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [text]);

  if (error) return <div className="inline-notice danger">{error}</div>;
  if (!state) return <section className="resource-empty-project">{text("正在读取五类服务器池状态…", "LOADING FIVE SERVER POOLS…")}</section>;

  async function createEnrollment(poolKind: string) {
    setEnrollmentBusy(poolKind);
    setError(null);
    try {
      const response = await fetch("/api/runtime/e2e-enrollment-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poolKind }),
      });
      const body = await response.json() as { enrollment?: { token?: string; expiresAt?: string }; message?: string };
      if (!response.ok || !body.enrollment?.token || !body.enrollment.expiresAt) {
        throw new Error(errorText(body.message, "无法创建节点配对码", "Unable to create node enrollment token"));
      }
      setEnrollment(Object.freeze({ poolKind, token: body.enrollment.token, expiresAt: body.enrollment.expiresAt }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("无法创建节点配对码", "Unable to create node enrollment token"));
    } finally {
      setEnrollmentBusy(null);
    }
  }

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
            {pool.kind.startsWith("E2E_") ? (
              <button className="button button-secondary pool-enroll-button" disabled={enrollmentBusy !== null} onClick={() => void createEnrollment(pool.kind)} type="button">
                {enrollmentBusy === pool.kind ? text("正在创建…", "CREATING…") : text("接入新节点", "CONNECT NODE")}
              </button>
            ) : null}
            <ul className="nodeList">
              {nodes.length === 0 ? <li><span>{text("无常驻节点", "No resident nodes")}</span><span>{text("按需", "ON DEMAND")}</span></li> : nodes.map(node => (
                <li key={node.id}>
                  <span>{node.id}</span>
                  <span>{node.state === "ACTIVE" && isRecentlyConnected(node.lastHeartbeatAt) ? text("已连接", "CONNECTED") : node.state === "ACTIVE" ? text("等待心跳", "WAITING") : node.state}</span>
                </li>
              ))}
            </ul>
            {enrollment?.poolKind === pool.kind ? (
              <div className="pool-enrollment" role="status">
                <strong>{text("一次性配对码", "ONE-TIME ENROLLMENT TOKEN")}</strong>
                <code>{enrollment.token}</code>
                <small>{text("30 分钟内有效。只发送给要接入的节点；首次配对后不可再次使用。", "Valid for 30 minutes. Send it only to the node being enrolled; it cannot be reused after pairing.")}</small>
                <small>{text("可信局域网：先用 npm run local:up -- --remote-e2e <本机私网 IP> 启动；Windows 上运行 scripts/local-remote-windows-e2e.ps1。公网必须使用生产 HTTPS/mTLS 部署包。", "Trusted LAN: start with npm run local:up -- --remote-e2e <private host IP>, then run scripts/local-remote-windows-e2e.ps1 on Windows. Public networks require the production HTTPS/mTLS bundle.")}</small>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function isRecentlyConnected(value: string | null): boolean {
  return Boolean(value && Date.now() - Date.parse(value) < 90_000);
}
