import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "受邀登录", description: "使用受邀 GitHub 账号登录 DeviLudo。" };

export default async function LoginPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = typeof params?.error === "string" ? params.error : null;
  return (
    <main className="login-page">
      <section className="login-card">
        <span className="login-brand">DeviLudo</span>
        <p className="eyebrow">INVITE-ONLY BETA</p>
        <h1>用 GitHub 完成受邀登录</h1>
        <p>请打开管理员发给你的完整邀请链接。平台只读取 GitHub 公开身份，并会在验证后立即撤销临时用户令牌。</p>
        {error ? <div className="login-error" role="alert">邀请已失效、已使用，或登录回调未通过校验。请向管理员申请新的邀请。</div> : null}
        <div className="login-security">
          <b>不会保存 GitHub 密码</b>
          <span>平台会话使用 HttpOnly Cookie，且可即时吊销。</span>
        </div>
        <Link className="button-secondary" href="/">返回首页</Link>
      </section>
    </main>
  );
}
