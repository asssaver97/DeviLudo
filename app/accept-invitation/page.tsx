"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense, useState, type FormEvent } from "react";
import { LanguageSwitcher, useLanguage } from "@/components/i18n/LanguageProvider";

export default function AcceptInvitationPage() {
  return <Suspense fallback={<main className="auth-screen">LOADING INVITATION…</main>}><InvitationForm /></Suspense>;
}

function InvitationForm() {
  const { text } = useLanguage();
  const token = useSearchParams().get("token") ?? "";
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, username: data.get("username"), password: data.get("password") }),
    });
    const body = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) {
      setError(body.message ?? text("邀请无效", "Invalid invitation"));
      return;
    }
    setDone(true);
  }
  return <main className="auth-screen"><LanguageSwitcher /><section className="auth-card"><span className="eyebrow">WORKSPACE INVITATION</span><h1>{text("加入工作区", "JOIN WORKSPACE")}</h1>{done ? <><p>{text("账号已创建。", "Account created.")}</p><Link className="button button-acid" href="/">{text("前往登录", "GO TO SIGN IN")}</Link></> : <form onSubmit={submit}><label>{text("用户名", "Username")}<input autoComplete="username" name="username" required /></label><label>{text("密码", "Password")}<input autoComplete="new-password" minLength={9} name="password" required type="password" /></label>{error ? <p className="form-error">{error}</p> : null}<button className="button button-acid" disabled={token.length < 32} type="submit">{text("接受邀请", "ACCEPT INVITATION")}</button></form>}</section></main>;
}
