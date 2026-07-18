"use client";

import { useEffect, useMemo, useState } from "react";

type Session = { tenantId: string; tenantName: string; role: string; displayName: string };
type InviteRole = "TenantAdmin" | "ProjectOwner" | "Auditor";
type Receipt = { invitationId: string; invitationUrl: string; tenantId: string; role: InviteRole; expiresAt: string; displayOnce: true };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export default function InvitationAdmin() {
  const [session, setSession] = useState<Session | null>(null);
  const [tenantId, setTenantId] = useState("");
  const [role, setRole] = useState<InviteRole>("ProjectOwner");
  const [dateLimits] = useState(() => { const start = Date.now(); return {
    minimum: localDateTime(new Date(start + 5 * 60_000)), defaultValue: localDateTime(new Date(start + 48 * 60 * 60_000)),
    maximum: localDateTime(new Date(start + 7 * 24 * 60 * 60_000)),
  }; });
  const [expiresAt, setExpiresAt] = useState(dateLimits.defaultValue);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/session", { headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (response) => response.ok ? (await response.json() as { data: Session }).data : null)
      .then((value) => {
        setSession(value);
        if (value && UUID.test(value.tenantId)) setTenantId(value.tenantId);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const tenantBound = session?.role === "TenantAdmin" && UUID.test(session.tenantId);
  const roles = useMemo<InviteRole[]>(() => tenantBound ? ["ProjectOwner", "Auditor"] : ["TenantAdmin", "ProjectOwner", "Auditor"], [tenantBound]);

  async function issue(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setReceipt(null); setMessage(null);
    try {
      const response = await fetch("/api/admin/invitations", { method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ tenantId, role, expiresAt: new Date(expiresAt).toISOString() }) });
      const payload = await response.json() as { data?: Receipt; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "邀请签发失败");
      setReceipt(payload.data);
      setMessage("邀请已签发。此链接只显示在当前页面，离开后无法恢复。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "邀请签发失败"); }
    finally { setBusy(false); }
  }

  async function copy() {
    if (!receipt) return;
    try { await navigator.clipboard.writeText(receipt.invitationUrl); setMessage("邀请链接已复制；请通过批准的保密渠道发送。"); }
    catch { setMessage("浏览器未允许复制，请手动选中链接。"); }
  }

  return (
    <section className="invite-admin">
      <div className="invite-heading">
        <div><p className="eyebrow">IDENTITY / INVITE-ONLY</p><h1>受邀账号管理</h1>
          <p>签发租户和角色绑定的一次性 GitHub 登录链接。平台不保存 GitHub 密码或邀请明文。</p></div>
        <span className="invite-boundary">mTLS Identity Broker</span>
      </div>
      <div className="invite-grid">
        <form className="invite-form" onSubmit={issue}>
          <label>租户 UUID<input disabled={tenantBound} onChange={(event) => setTenantId(event.target.value.trim().toLowerCase())} placeholder="11111111-1111-4111-8111-111111111111" required value={tenantId} /></label>
          <label>授予角色<select onChange={(event) => setRole(event.target.value as InviteRole)} value={role}>{roles.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>失效时间<input max={dateLimits.maximum} min={dateLimits.minimum} onChange={(event) => setExpiresAt(event.target.value)} required type="datetime-local" value={expiresAt} /></label>
          <button className="button-primary" disabled={busy || !UUID.test(tenantId)} type="submit">{busy ? "正在签发…" : "签发一次性邀请"}</button>
          {session ? <small>当前会话：{session.displayName} · {session.tenantName} · {session.role}</small> : <small>平台管理员权限由可信入口注入；普通浏览器角色头不会被信任。</small>}
        </form>
        <div className="invite-result">
          <p className="eyebrow">ONE-TIME DELIVERY</p>
          {receipt ? <><h2>{receipt.role}</h2><code>{receipt.invitationUrl}</code><p>有效至 {new Date(receipt.expiresAt).toLocaleString("zh-CN", { hour12: false })}</p><button className="button-secondary" onClick={copy} type="button">复制邀请链接</button></>
            : <><h2>等待签发</h2><p>原始 token 只在签发响应中出现一次；数据库仅保存 SHA-256 摘要。</p></>}
          {message ? <div className="invite-message" role="status">{message}</div> : null}
        </div>
      </div>
    </section>
  );
}

function localDateTime(value: Date): string {
  const adjusted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}
