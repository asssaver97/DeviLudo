"use client";

import { useEffect, useState } from "react";
import {
  parseEvidenceCatalogProjection,
  type EvidenceCatalogProjection,
} from "@/lib/evidence/catalog-projection";

export function useEvidenceCatalog(projectId: string | null, production: boolean) {
  const [catalog, setCatalog] = useState<EvidenceCatalogProjection | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    if (!production || !projectId) return () => controller.abort();
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/evidence`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as { data?: unknown; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "证据目录投影不可用");
      const parsed = await parseEvidenceCatalogProjection(body.data);
      if (parsed.projectId !== projectId) throw new Error("证据目录项目绑定无效");
      setCatalog(parsed); setLoadedProjectId(projectId); setError("");
    }).catch((reason) => {
      if (!controller.signal.aborted) {
        setCatalog(null); setLoadedProjectId(projectId);
        setError(reason instanceof Error ? reason.message : "证据目录投影不可用");
      }
    });
    return () => controller.abort();
  }, [production, projectId]);

  return {
    catalog: production && loadedProjectId === projectId ? catalog : null,
    error: production && loadedProjectId === projectId ? error : "",
  };
}
