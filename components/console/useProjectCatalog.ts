"use client";

import { useEffect, useMemo, useState } from "react";

export type ProjectCatalogItem = Readonly<{
  projectId: string;
  tenantId: string;
  slug: string;
  name: string;
  repositoryBindingId: string;
  installationId: string;
  repositoryId: number;
  repositoryNodeId: string;
  owner: string;
  repositoryName: string;
  defaultBranch: string;
  createdAt: string;
}>;

export function useProjectCatalog() {
  const [projects, setProjects] = useState<readonly ProjectCatalogItem[]>([]);
  const [mode, setMode] = useState<"LOCAL_FIXTURE" | "PRODUCTION" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/projects", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { data?: unknown; meta?: { mode?: unknown }; error?: { message?: string } };
        if (!response.ok) throw new Error(body.error?.message ?? "项目目录不可用");
        const responseMode = body.meta?.mode;
        if (responseMode !== "LOCAL_FIXTURE" && responseMode !== "PRODUCTION") throw new Error("项目目录来源无效");
        const parsed = parseProjectCatalog(body.data, responseMode);
        setProjects(parsed);
        setMode(responseMode);
        setError("");
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "项目目录不可用");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  return { projects, mode, loading, error };
}

export function useProjectSelection() {
  const catalog = useProjectCatalog();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("project"));
  const availableIds = useMemo(() => new Set(catalog.projects.map((project) => project.projectId)), [catalog.projects]);
  const effectiveProjectId = selectedProjectId && availableIds.has(selectedProjectId)
    ? selectedProjectId
    : catalog.projects[0]?.projectId ?? null;
  const project = catalog.projects.find((item) => item.projectId === effectiveProjectId) ?? null;
  const selectProject = (projectId: string) => {
    if (!availableIds.has(projectId)) return;
    setSelectedProjectId(projectId);
    const url = new URL(window.location.href);
    url.searchParams.set("project", projectId);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  return { ...catalog, project, selectedProjectId: effectiveProjectId, selectProject };
}

export function parseProjectCatalog(
  value: unknown,
  mode: "LOCAL_FIXTURE" | "PRODUCTION",
): readonly ProjectCatalogItem[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("项目目录格式无效");
  const projects = value.map((project) => parseProject(project, mode));
  if (new Set(projects.map((project) => project.projectId)).size !== projects.length) throw new Error("项目目录包含重复项目");
  return Object.freeze(projects);
}

function parseProject(value: unknown, mode: "LOCAL_FIXTURE" | "PRODUCTION"): ProjectCatalogItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("项目目录格式无效");
  const item = value as Record<string, unknown>;
  const stringFields = ["projectId", "tenantId", "slug", "name", "repositoryBindingId", "installationId", "repositoryNodeId", "owner", "repositoryName", "defaultBranch", "createdAt"] as const;
  const expectedFields = [...stringFields, "repositoryId"].sort();
  if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(expectedFields)) throw new Error("项目目录格式无效");
  if (stringFields.some((field) => typeof item[field] !== "string" || !(item[field] as string))) throw new Error("项目目录格式无效");
  const validSourceBinding = mode === "LOCAL_FIXTURE"
    ? item.tenantId === "tenant-local"
      && item.installationId === "local-fixture-9001"
      && item.repositoryId === 7001
    : /^\d{1,20}$/.test(item.installationId as string);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(item.projectId as string)
    || !Number.isSafeInteger(item.repositoryId) || (item.repositoryId as number) < 1
    || !validSourceBinding
    || !Number.isFinite(new Date(item.createdAt as string).getTime())) throw new Error("项目目录格式无效");
  return Object.freeze(item) as unknown as ProjectCatalogItem;
}
