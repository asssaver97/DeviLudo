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
    let timer: number | null = null;
    const load = async (maximumAge: number) => loadCached<PoolResponse>(clientCacheKeys.serverPools, maximumAge, async () => {
        const response = await fetch("/api/runtime/server-pools", { cache: "no-store" });
        if (!response.ok) throw new Error(text(`服务器池接口返回 ${response.status}`, `Server pool API returned ${response.status}`));
        return await response.json() as PoolResponse;
      });
    const refresh = (maximumAge: number) => {
      void load(maximumAge)
      .then(value => {
        if (!active) return;
        setState(value);
        const preparing = value.nodes.some(node => node.preparation?.state === "PREPARING");
        timer = window.setTimeout(() => refresh(0), preparing ? 2_000 : 15_000);
      })
      .catch(reason => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : text("加载失败", "Unable to load"));
        timer = window.setTimeout(() => refresh(0), 15_000);
      });
    };
    refresh(15_000);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
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
              <span className={`badge ${pool.readiness === "READY" ? "is-ready" : "is-not-ready"}`}>{pool.readiness}</span>
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
              {nodes.length === 0 ? <li><div className="node-row"><span>{text("无常驻节点", "No resident nodes")}</span><span>{text("按需", "ON DEMAND")}</span></div></li> : nodes.map(node => (
                <li className={node.preparation ? "has-preparation" : undefined} key={node.id}>
                  <div className="node-row">
                    <span>{node.id}</span>
                    <span>{node.preparation?.state === "PREPARING"
                      ? text(`准备中 ${node.preparation.progress}%`, `PREPARING ${node.preparation.progress}%`)
                      : node.preparation?.state === "FAILED"
                        ? text("准备失败", "PREPARATION FAILED")
                        : node.state === "ACTIVE" && isRecentlyConnected(node.lastHeartbeatAt)
                          ? text("已连接", "CONNECTED")
                          : node.state === "ACTIVE" ? text("等待心跳", "WAITING") : node.state}</span>
                  </div>
                  {node.preparation ? (
                    <div className={`node-preparation is-${node.preparation.state.toLowerCase()}`} role="status">
                      <div aria-label={text("E2E 准备进度", "E2E preparation progress")} aria-valuemax={100} aria-valuemin={0} aria-valuenow={node.preparation.progress} className="node-preparation-track" role="progressbar">
                        <i style={{ width: `${node.preparation.progress}%` }} />
                      </div>
                      <small>{preparationMessage(node.preparation.stage, node.preparation.message, text)}</small>
                    </div>
                  ) : null}
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

function preparationMessage(
  stage: string,
  fallback: string,
  text: (chinese: string, english: string) => string,
): string {
  const messages: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
    CHECKING_HOST: ["检查 macOS 虚拟化与工具", "Checking macOS virtualization and tools"],
    DOWNLOADING_BASE: ["下载 macOS E2E 基础镜像", "Downloading the macOS E2E base image"],
    COMPILING_DRIVERS: ["编译系统输入驱动", "Compiling system input drivers"],
    CLONING_VM: ["创建 E2E 虚拟机", "Creating the E2E virtual machine"],
    BOOTING_VM: ["启动 E2E 虚拟机", "Booting the E2E virtual machine"],
    PROVISIONING_VM: ["安装测试运行环境", "Installing the test runtime"],
    REBOOTING_VM: ["重启并验证自动登录", "Rebooting and verifying automatic login"],
    VERIFYING_VM: ["执行真实窗口冒烟测试", "Running the real-window smoke test"],
    READY: ["macOS E2E 已就绪", "macOS E2E is ready"],
    FAILED: ["macOS E2E 准备失败", "macOS E2E preparation failed"],
  });
  const localized = messages[stage];
  return localized ? text(localized[0], localized[1]) : fallback;
}
