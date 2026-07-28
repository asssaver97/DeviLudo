"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "./AppShell";
import { GithubIcon } from "./Icons";

type Repository = Readonly<{
  installationId: string;
  repositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}>;
type Installation = Readonly<{
  installationId: string;
  accountLogin: string;
  repositories: readonly Repository[];
}>;

export function NewProjectEntry() {
  const [runtime, setRuntime] = useState<"LOADING" | "LOCAL" | "PRODUCTION">(
    process.env.DEVILUDO_LOCAL_TEST_MODE === "1" ? "LOCAL" : "LOADING",
  );

  useEffect(() => {
    if (runtime !== "LOADING") return;
    const controller = new AbortController();
    void fetch("/api/health", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("health unavailable");
        const body = await response.json() as { mode?: string };
        setRuntime(body.mode === "LOCALHOST_D1" ? "LOCAL" : "PRODUCTION");
      })
      .catch(() => { if (!controller.signal.aborted) setRuntime("PRODUCTION"); });
    return () => controller.abort();
  }, [runtime]);

  if (runtime === "LOADING") {
    return <AppShell><section className="repository-onboarding"><p>正在确认项目创建环境…</p></section></AppShell>;
  }
  return <RepositoryOnboarding local={runtime === "LOCAL"} />;
}

function RepositoryOnboarding({ local }: { local: boolean }) {
  const [installations, setInstallations] = useState<readonly Installation[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [realGitHub, setRealGitHub] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/projects/repositories", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { data?: { installations?: readonly Installation[] }; meta?: { mode?: string }; error?: { message?: string } };
        if (!response.ok || !Array.isArray(body.data?.installations)) throw new Error(body.error?.message ?? "仓库目录不可用");
        setRealGitHub(body.meta?.mode === "LOCAL_GITHUB");
        setInstallations(body.data.installations);
        const first = body.data.installations.flatMap((installation) => installation.repositories)[0];
        if (first) setSelected(`${first.installationId}:${first.repositoryId}`);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "仓库目录不可用"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const repositories = useMemo(() => installations.flatMap((installation) => installation.repositories), [installations]);
  const repository = repositories.find((item) => `${item.installationId}:${item.repositoryId}` === selected);
  const fixture = local && !realGitHub;

  async function createProject() {
    if (!repository || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `create-project-${crypto.randomUUID()}` },
        body: JSON.stringify({
          slug: slug.trim(),
          name: name.trim(),
          installationId: repository.installationId,
          repositoryId: repository.repositoryId,
        }),
      });
      const body = await response.json() as { data?: { projectId?: string }; error?: { message?: string } };
      if (!response.ok || !body.data?.projectId) throw new Error(body.error?.message ?? "项目创建失败");
      window.location.assign(`/projects/${encodeURIComponent(body.data.projectId)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目创建失败");
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <section className="project-page-header">
        <div>
          <div className="breadcrumb"><Link href="/projects">游戏项目</Link><span>/</span><b>创建项目</b></div>
          <h1>{fixture ? "创建本地测试项目" : "绑定代码仓库"}</h1>
          <p>{fixture ? "项目会持久保存在本机测试目录，并使用隔离的合成 GitHub 仓库身份。" : "项目只可绑定当前账号已验证、且仍对 GitHub App 可见的仓库。"}</p>
        </div>
      </section>
      <section className="repository-onboarding">
        <div className="repository-onboarding-title"><span><GithubIcon /></span><div><b>{fixture ? "本地隔离仓库" : "GitHub App 仓库"}</b><p>{fixture ? "本地模式不读取 GitHub 凭据；服务器为每个项目派生独立仓库绑定。" : "平台不会接收 GitHub 密码，也不会相信浏览器提交的仓库名称。"}</p></div></div>
        {loading ? <p className="repository-onboarding-state">{fixture ? "正在读取本地仓库目录…" : "正在从 GitHub 读取授权仓库…"}</p> : null}
        {!loading && repositories.length === 0 ? (
          <div className="repository-onboarding-state">没有可用仓库。{fixture ? "请重启本地测试站。" : <Link href="/settings/connections">安装或更新 GitHub App 授权</Link>}</div>
        ) : null}
        {repositories.length > 0 ? (
          <div className="repository-onboarding-form">
            <label>项目名称<input maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="例如：余烬群岛" value={name} /></label>
            <label>项目标识<input maxLength={63} onChange={(event) => setSlug(event.target.value.toLowerCase())} pattern="[a-z0-9-]+" placeholder="ember-archipelago" value={slug} /></label>
            <label>代码仓库<select onChange={(event) => setSelected(event.target.value)} value={selected}>{installations.flatMap((installation) => installation.repositories.map((item) => <option key={`${item.installationId}:${item.repositoryId}`} value={`${item.installationId}:${item.repositoryId}`}>{item.owner}/{item.name}{item.private ? " · 私有" : ""} · {item.defaultBranch}</option>))}</select></label>
            <button className="button button-acid" disabled={busy || !name.trim() || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug.trim()) || !repository} onClick={createProject} type="button">{busy ? "正在验证并创建…" : "创建项目并开始构想"}</button>
          </div>
        ) : null}
        {error ? <p className="repository-onboarding-error" role="alert">{error} {fixture ? null : <Link href="/settings/connections">检查账号连接</Link>}</p> : null}
      </section>
    </AppShell>
  );
}
