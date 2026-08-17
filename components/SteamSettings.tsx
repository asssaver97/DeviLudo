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
  const { errorText, text } = useLanguage();
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
    if (!response.ok) throw new Error(errorText(payload.message, "Steam 配置读取失败", "Unable to load Steam settings"));
    return Object.freeze({ settings: payload.settings ?? null, editable: payload.editable === true });
  }, [errorText]);

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
      if (!response.ok || !payload.settings) throw new Error(errorText(payload.message, "Steam 配置保存失败", "Unable to save Steam settings"));
      setSettings(payload.settings);
      setBuilderUsername(payload.settings.builderUsername);
      setBuildToken(payload.settings.buildToken);
      setNotice(text("Steam 构建凭证已保存", "Steam build credential saved"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : text("Steam 配置保存失败", "Unable to save Steam settings"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="settings-loading">{text("加载 Steam 配置...", "Loading Steam settings...")}</div>;
  return (
    <section className="settings-card settings-section" aria-label={text("Steam 构建凭证", "Workspace Steam credential")}>
      <div className="settings-card-title"><div><h2>{text("Steam 构建凭证", "STEAM BUILD CREDENTIAL")}</h2></div><span>STEAMPIPE</span></div>
      <p className="settings-description">
        {text("工作区级 SteamPipe 凭证。这里只保存受保护的凭证引用；App ID、Depot 和测试分支在各项目中配置。", "Workspace-scoped SteamPipe credential. Only a protected secret reference is stored; configure App ID, depots, and the test branch per project.")}
      </p>
      <form className="settings-form" onSubmit={save}>
        <label htmlFor="steam-builder-username">{text("Steamworks 构建用户名", "Steamworks build username")}
          <input disabled={!editable} id="steam-builder-username" onChange={event => setBuilderUsername(event.target.value)} value={builderUsername} />
        </label>
        <label htmlFor="steam-build-token">{text("Steam Guard 构建令牌 / 密码", "Steam Guard build token / password")}
          <input autoComplete="new-password" disabled={!editable} id="steam-build-token" onChange={event => setBuildToken(event.target.value)} type="password" value={buildToken} />
          <small className="field-help">{settings
            ? text("掩码值表示保留现有凭证；输入新值会创建新版本。", "Leave the masked value unchanged to retain the current credential; enter a new value to create a new version.")
            : text("建议使用仅拥有该工作区应用构建权限的专用凭证。", "Use a dedicated credential limited to build access for this workspace's apps.")}</small>
        </label>
        {editable ? <button className="button button-primary" disabled={saving || !builderUsername || !buildToken} type="submit">{saving ? text("保存中...", "SAVING...") : text("保存 Steam 配置", "SAVE STEAM SETTINGS")}</button> : null}
        {notice ? <p className="agent-config-notice" role="status">{notice}</p> : null}
      </form>
    </section>
  );
}
