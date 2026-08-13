"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLanguage } from "./i18n/LanguageProvider";

type PublicSteamSettings = Readonly<{
  builderUsername: string;
  buildToken: string;
  revision: number;
  updatedAt: string;
}>;

export function SteamSettings() {
  const { text } = useLanguage();
  const [settings, setSettings] = useState<PublicSteamSettings | null>(null);
  const [editable, setEditable] = useState(false);
  const [builderUsername, setBuilderUsername] = useState("");
  const [buildToken, setBuildToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const fetchSettings = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/settings/steam", { cache: "no-store", signal });
    const payload = await response.json() as { settings?: PublicSteamSettings | null; editable?: boolean; message?: string };
    if (!response.ok) throw new Error(payload.message ?? text("Steam 配置读取失败", "Unable to load Steam settings"));
    return Object.freeze({ settings: payload.settings ?? null, editable: payload.editable === true });
  }, [text]);

  const applySettings = useCallback((payload: Awaited<ReturnType<typeof fetchSettings>>) => {
    setSettings(payload.settings);
    setEditable(payload.editable);
    setBuilderUsername(payload.settings?.builderUsername ?? "");
    setBuildToken(payload.settings?.buildToken ?? "");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSettings(controller.signal)
      .then(payload => { if (!controller.signal.aborted) applySettings(payload); })
      .catch(error => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : text("Steam 配置读取失败", "Unable to load Steam settings")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [applySettings, fetchSettings, text]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editable || saving) return;
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch("/api/settings/steam", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ builderUsername, buildToken }),
      });
      const payload = await response.json() as { settings?: PublicSteamSettings; message?: string };
      if (!response.ok || !payload.settings) throw new Error(payload.message ?? text("Steam 配置保存失败", "Unable to save Steam settings"));
      setSettings(payload.settings);
      setBuilderUsername(payload.settings.builderUsername);
      setBuildToken(payload.settings.buildToken);
      setNotice(text("Steam 构建账号已保存", "Steam build account saved"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : text("Steam 配置保存失败", "Unable to save Steam settings"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="settings-loading">{text("加载 Steam 配置...", "Loading Steam settings...")}</div>;
  return (
    <section className="image-generation-settings" aria-label={text("Steam 构建账号", "Workspace Steam credential")}>
      <h3>{text("Steam 构建账号", "WORKSPACE STEAM CREDENTIAL")}</h3>
      <p className="settings-description">
        {text("工作区级 SteamPipe 凭证。这里只保存受保护的凭证引用；App ID、Depot 和测试分支在各项目中配置。", "Workspace-scoped SteamPipe credential. Only a protected secret reference is stored; configure App ID, depots, and the test branch per project.")}
      </p>
      <form className="settings-form" onSubmit={save}>
        <div className="form-group">
          <label htmlFor="steam-builder-username">{text("Steamworks 构建账号", "Steamworks build account")}</label>
          <input className="form-control" disabled={!editable} id="steam-builder-username" onChange={event => setBuilderUsername(event.target.value)} value={builderUsername} />
        </div>
        <div className="form-group">
          <label htmlFor="steam-build-token">{text("Steam Guard 构建令牌 / 密码", "Steam Guard build token / password")}</label>
          <input autoComplete="new-password" className="form-control" disabled={!editable} id="steam-build-token" onChange={event => setBuildToken(event.target.value)} type="password" value={buildToken} />
          <div className="form-help">{settings
            ? text("掩码值表示保留现有凭证；输入新值会创建新版本。", "Leave the masked value unchanged to retain the current credential; enter a new value to create a new version.")
            : text("建议使用仅拥有该工作区应用构建权限的专用账号。", "Use a dedicated account limited to build access for this workspace's apps.")}</div>
        </div>
        {editable ? <div className="form-actions"><button className="btn-primary" disabled={saving || !builderUsername || !buildToken} type="submit">{saving ? text("保存中...", "Saving...") : text("保存 Steam 配置", "Save Steam settings")}</button></div> : null}
        {!editable ? <div className="form-help">{text("只有工作区 Owner 或 Admin 可以修改。", "Only workspace Owners and Admins can make changes.")}</div> : null}
        {notice ? <div className="form-notice">{notice}</div> : null}
      </form>
    </section>
  );
}
