"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ProductSession, WorkspaceMembershipRecord, WorkspaceRole } from "@/lib/product/contracts";
import { PlusIcon, ShieldIcon } from "./console/Icons";
import { useLanguage } from "./i18n/LanguageProvider";

export function AccessSettings() {
  const { text } = useLanguage();
  const [session, setSession] = useState<ProductSession | null>(null);
  const [members, setMembers] = useState<readonly WorkspaceMembershipRecord[]>([]);
  const [role, setRole] = useState<Exclude<WorkspaceRole, "OWNER">>("MEMBER");
  const [inviteUrl, setInviteUrl] = useState("");
  const [error, setError] = useState("");
  const [busyMember, setBusyMember] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/session", { cache: "no-store", signal: controller.signal })
      .then(response => response.json())
      .then((body: { session: ProductSession }) => {
        if (controller.signal.aborted) return;
        setSession(body.session);
        if (body.session.selectedWorkspace) {
          void fetch("/api/workspaces/current/members", { cache: "no-store", signal: controller.signal })
            .then(response => response.ok ? response.json() : Promise.reject(new Error(text("无法读取成员", "Unable to load members"))))
            .then((value: { members: readonly WorkspaceMembershipRecord[] }) => setMembers(value.members));
        }
      }).catch(fetchError => { if (!controller.signal.aborted) setError(fetchError instanceof Error ? fetchError.message : text("读取失败", "Unable to load")); });
    return () => controller.abort();
  }, [text]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/workspaces/current/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const body = await response.json() as { invitation?: { url: string }; message?: string };
    if (!response.ok || !body.invitation) {
      setError(body.message ?? text("无法创建邀请", "Unable to create invitation"));
      return;
    }
    setInviteUrl(new URL(body.invitation.url, window.location.origin).href);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    window.location.assign("/");
  }

  async function changeMember(userId: string, nextRole: Exclude<WorkspaceRole, "OWNER"> | null) {
    setBusyMember(userId);
    setError("");
    try {
      const response = await fetch(`/api/workspaces/current/members/${encodeURIComponent(userId)}`, {
        method: nextRole ? "PATCH" : "DELETE",
        headers: { "content-type": "application/json" },
        ...(nextRole ? { body: JSON.stringify({ role: nextRole }) } : {}),
      });
      const body = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(body.message ?? text("无法更新成员", "Unable to update member"));
      setMembers(current => nextRole
        ? current.map(member => member.userId === userId ? { ...member, role: nextRole } : member)
        : current.filter(member => member.userId !== userId));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : text("无法更新成员", "Unable to update member"));
    } finally {
      setBusyMember(null);
    }
  }

  const currentMembership = members.find(member => member.userId === session?.user?.id);
  const canManage = currentMembership?.role === "OWNER" || currentMembership?.role === "ADMIN";

  return (
    <section className="access-settings panel-card">
      <header className="section-heading"><span className="step-badge">02</span><div><h2>{text("账号与工作区", "ACCOUNT & WORKSPACE")}</h2></div><ShieldIcon /></header>
      <div className="access-user-row"><div><small>{text("当前账号", "CURRENT ACCOUNT")}</small><b>{session?.user?.username ?? "—"}</b></div><button className="button button-secondary" onClick={() => void logout()} type="button">{text("退出登录", "SIGN OUT")}</button></div>
      {session?.selectedWorkspace ? <>
        <div className="access-members">
          {members.map(member => <div key={member.userId}>
            <span>{member.username}</span>
            {canManage && member.role !== "OWNER" && member.userId !== session.user?.id ? <span className="access-member-actions">
              <select aria-label={text(`调整 ${member.username} 的角色`, `Change ${member.username}'s role`)} disabled={busyMember === member.userId} onChange={event => void changeMember(member.userId, event.target.value as "ADMIN" | "MEMBER")} value={member.role}>
                <option value="MEMBER">MEMBER</option><option value="ADMIN">ADMIN</option>
              </select>
              <button className="button button-secondary" disabled={busyMember === member.userId} onClick={() => void changeMember(member.userId, null)} type="button">{text("移除", "REMOVE")}</button>
            </span> : <b>{member.role}</b>}
          </div>)}
        </div>
        {canManage ? <form className="access-invite" onSubmit={invite}>
          <label>{text("邀请角色", "Invitation role")}<select onChange={event => setRole(event.target.value as Exclude<WorkspaceRole, "OWNER">)} value={role}><option value="MEMBER">MEMBER</option><option value="ADMIN">ADMIN</option></select></label>
          <button className="button button-acid" type="submit"><PlusIcon /> {text("创建 24 小时邀请", "CREATE 24H INVITE")}</button>
        </form> : null}
        {inviteUrl ? <label className="access-invite-url">{text("邀请链接", "Invitation link")}<input onFocus={event => event.currentTarget.select()} readOnly value={inviteUrl} /></label> : null}
      </> : <p className="empty-copy">{text("选择工作区后管理成员与邀请。", "Select a workspace to manage members and invitations.")}</p>}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  );
}
