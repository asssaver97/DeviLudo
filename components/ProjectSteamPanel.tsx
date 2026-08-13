"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ProjectSteamSettings, SteamRelease } from "@/lib/product/contracts";
import { useLanguage } from "./i18n/LanguageProvider";

export function ProjectSteamPanel(props: Readonly<{
  projectId: string;
  workflowId: string;
  workflowState: string;
  iterationNumber: number;
  workspaceRole: string;
  readOnly: boolean;
  onChanged: () => Promise<void>;
}>) {
  const { text } = useLanguage();
  const [settings, setSettings] = useState<ProjectSteamSettings | null>(null);
  const [releases, setReleases] = useState<readonly SteamRelease[]>([]);
  const [editable, setEditable] = useState(false);
  const [appId, setAppId] = useState("");
  const [linuxDepot, setLinuxDepot] = useState("");
  const [windowsDepot, setWindowsDepot] = useState("");
  const [macosDepot, setMacosDepot] = useState("");
  const [testBranch, setTestBranch] = useState("deviludo-test");
  const [version, setVersion] = useState(`0.${Math.max(1, props.iterationNumber)}.0`);
  const [channel, setChannel] = useState<"TEST" | "DEFAULT">("TEST");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fetchPanel = useCallback(async (signal?: AbortSignal) => {
    const [settingsResponse, releasesResponse] = await Promise.all([
      fetch(`/api/projects/${encodeURIComponent(props.projectId)}/steam-settings`, { cache: "no-store", signal }),
      fetch(`/api/projects/${encodeURIComponent(props.projectId)}/steam-releases`, { cache: "no-store", signal }),
    ]);
    const settingsPayload = await settingsResponse.json() as { settings?: ProjectSteamSettings | null; editable?: boolean; message?: string };
    const releasesPayload = await releasesResponse.json() as { releases?: readonly SteamRelease[]; message?: string };
    if (!settingsResponse.ok) throw new Error(settingsPayload.message ?? text("Steam 项目配置读取失败", "Unable to load Steam project settings"));
    if (!releasesResponse.ok) throw new Error(releasesPayload.message ?? text("Steam 发布历史读取失败", "Unable to load Steam release history"));
    return Object.freeze({
      settings: settingsPayload.settings ?? null,
      editable: settingsPayload.editable === true,
      releases: releasesPayload.releases ?? Object.freeze([]),
    });
  }, [props.projectId, text]);

  const applyPanel = useCallback((payload: Awaited<ReturnType<typeof fetchPanel>>) => {
    const value = payload.settings;
    setSettings(value);
    setEditable(payload.editable);
    setAppId(value?.appId ?? "");
    setLinuxDepot(value?.depots.linux ?? "");
    setWindowsDepot(value?.depots.windows ?? "");
    setMacosDepot(value?.depots.macos ?? "");
    setTestBranch(value?.testBranch ?? "deviludo-test");
    setReleases(payload.releases);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    applyPanel(await fetchPanel(signal));
  }, [applyPanel, fetchPanel]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchPanel(controller.signal)
      .then(payload => { if (!controller.signal.aborted) applyPanel(payload); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [applyPanel, fetchPanel]);

  async function request(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? `${response.status}`);
      await Promise.all([load(), props.onChanged()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("操作失败", "Operation failed"));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!editable || props.readOnly) return;
    setBusy(true);
    setError("");
    try {
      const depots = {
        ...(linuxDepot ? { linux: linuxDepot } : {}),
        ...(windowsDepot ? { windows: windowsDepot } : {}),
        ...(macosDepot ? { macos: macosDepot } : {}),
      };
      const response = await fetch(`/api/projects/${encodeURIComponent(props.projectId)}/steam-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, depots, testBranch }),
      });
      const payload = await response.json() as { settings?: ProjectSteamSettings; message?: string };
      if (!response.ok || !payload.settings) throw new Error(payload.message ?? text("Steam 项目配置保存失败", "Unable to save Steam project settings"));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("Steam 项目配置保存失败", "Unable to save Steam project settings"));
    } finally {
      setBusy(false);
    }
  }

  const currentRelease = releases.find(release => release.workflowId === props.workflowId) ?? null;
  const admin = props.workspaceRole === "OWNER" || props.workspaceRole === "ADMIN";
  return (
    <section className="panel-card product-steam-panel" aria-label={text("Steam 托管发布", "Managed Steam releases")}>
      <header className="section-heading">
        <div><span className="eyebrow">STEAM RELEASES</span><h2>{text("Steam 托管发布", "MANAGED STEAM RELEASES")}</h2></div>
        <span className="revision-badge">{settings ? `APP ${settings.appId}` : text("未配置", "NOT CONFIGURED")}</span>
      </header>
      <details className="product-steam-settings" open={!settings}>
        <summary>{text("项目 SteamPipe 配置", "PROJECT STEAMPIPE SETTINGS")}</summary>
        <form className="settings-form" onSubmit={saveSettings}>
          <div className="product-steam-field-grid">
            <label>App ID<input disabled={!editable || props.readOnly} onChange={event => setAppId(event.target.value)} value={appId} /></label>
            <label>Linux Depot<input disabled={!editable || props.readOnly} onChange={event => setLinuxDepot(event.target.value)} value={linuxDepot} /></label>
            <label>Windows Depot<input disabled={!editable || props.readOnly} onChange={event => setWindowsDepot(event.target.value)} value={windowsDepot} /></label>
            <label>macOS Depot<input disabled={!editable || props.readOnly} onChange={event => setMacosDepot(event.target.value)} value={macosDepot} /></label>
            <label>{text("测试分支", "Test branch")}<input disabled={!editable || props.readOnly} onChange={event => setTestBranch(event.target.value)} value={testBranch} /></label>
          </div>
          {editable && !props.readOnly ? <button className="button button-secondary" disabled={busy || !appId || (!linuxDepot && !windowsDepot && !macosDepot)} type="submit">{text("保存项目配置", "SAVE PROJECT SETTINGS")}</button> : null}
          <small>{text("构建账号在工作区设置中维护；这里仅保存项目的 App、Depot 与测试分支。", "The build account is managed in workspace Settings; this section stores only the project's App, depots, and test branch.")}</small>
        </form>
      </details>

      {!props.readOnly && props.workflowState === "RELEASE_DECISION_PENDING" ? (
        <div className="product-release-decision">
          <div>
            <strong>{text("真实操作 E2E 已通过", "REAL-INPUT E2E PASSED")}</strong>
            <p>{text("可以结束本轮并继续迭代，也可以创建唯一发布记录并上传 Steam。", "Finish this iteration and continue development, or create its single release record and upload it to Steam.")}</p>
          </div>
          <button className="button button-secondary" disabled={busy} onClick={() => void request(`/api/projects/${encodeURIComponent(props.projectId)}/iterations/${encodeURIComponent(props.workflowId)}/complete`)} type="button">{text("完成本轮，不发布", "FINISH WITHOUT PUBLISHING")}</button>
          {admin ? <form className="product-release-form" onSubmit={event => {
            event.preventDefault();
            void request(`/api/projects/${encodeURIComponent(props.projectId)}/steam-releases`, { workflowId: props.workflowId, version, channel });
          }}>
            <label>{text("版本", "Version")}<input aria-label={text("Steam 版本", "Steam version")} onChange={event => setVersion(event.target.value)} placeholder="1.0.0" value={version} /></label>
            <label>{text("目标", "Channel")}<select onChange={event => setChannel(event.target.value as "TEST" | "DEFAULT")} value={channel}><option value="TEST">{text("测试分支", "Test branch")}</option><option value="DEFAULT">default</option></select></label>
            <button className="button button-primary" disabled={busy || !settings || !version} type="submit">{text("批准并上传 Steam", "APPROVE & UPLOAD TO STEAM")}</button>
          </form> : <small>{text("只有工作区 Owner 或 Admin 可以上传 Steam。", "Only a workspace Owner or Admin can upload to Steam.")}</small>}
        </div>
      ) : null}

      {currentRelease?.state === "FAILED" && !props.readOnly && admin ? (
        <button className="button button-primary" disabled={busy} onClick={() => void request(`/api/projects/${encodeURIComponent(props.projectId)}/rerun-stage`, { stage: "STEAM_PUBLISH" })} type="button">{text("重试本次 Steam 上传", "RETRY THIS STEAM UPLOAD")}</button>
      ) : null}

      {releases.length ? <div className="product-steam-release-list">
        {releases.map(release => <article key={release.id}>
          <div><strong>v{release.version} · #{release.releaseNumber}</strong><small>{text(`第 ${release.iterationNumber} 轮`, `Iteration ${release.iterationNumber}`)} · {release.targetBranch}</small></div>
          <span className={`revision-badge steam-release-${release.state.toLowerCase()}`}>{steamReleaseLabel(release.state, text)}</span>
          {release.steamBuildId ? <code>Build {release.steamBuildId}</code> : null}
          {release.failureMessage ? <small className="repository-onboarding-error">{release.failureMessage}</small> : null}
          {release.state === "AWAITING_DEFAULT_PROMOTION" && settings ? <div className="product-steam-promotion">
            <a className="button button-secondary" href={`https://partner.steamgames.com/apps/builds/${settings.appId}`} rel="noreferrer" target="_blank">{text("打开 Steamworks Builds", "OPEN STEAMWORKS BUILDS")}</a>
            {admin ? <button className="button button-primary" disabled={busy} onClick={() => void request(`/api/projects/${encodeURIComponent(props.projectId)}/steam-releases/${encodeURIComponent(release.id)}/confirm-live`)} type="button">{text("已手动设为 default", "CONFIRM DEFAULT IS LIVE")}</button> : null}
          </div> : null}
        </article>)}
      </div> : <p>{text("尚无 Steam 发布记录。每轮最多创建一条成功发布。", "No Steam releases yet. Each iteration can create at most one successful release.")}</p>}
      {error ? <div className="inline-notice danger">{error}</div> : null}
    </section>
  );
}

function steamReleaseLabel(
  state: SteamRelease["state"],
  text: (chinese: string, english: string) => string,
): string {
  const labels: Record<SteamRelease["state"], readonly [string, string]> = {
    UPLOADING: ["上传中", "UPLOADING"],
    FAILED: ["上传失败", "FAILED"],
    LIVE_TEST: ["测试分支已上线", "LIVE ON TEST"],
    AWAITING_DEFAULT_PROMOTION: ["等待手动设为 default", "AWAITING DEFAULT"],
    LIVE_DEFAULT: ["default 已上线", "LIVE ON DEFAULT"],
  };
  return text(...labels[state]);
}
