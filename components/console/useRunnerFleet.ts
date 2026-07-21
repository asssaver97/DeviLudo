"use client";

import { useEffect, useState } from "react";
import { parseRunnerFleetProjection, type RunnerFleetProjection } from "@/lib/runner/fleet-projection";

export function useRunnerFleet(projectId: string | null, production: boolean) {
  const [fleet, setFleet] = useState<RunnerFleetProjection | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    if (!production || !projectId) {
      return () => controller.abort();
    }
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/runners`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { data?: unknown; error?: { message?: string } };
        if (!response.ok) throw new Error(body.error?.message ?? "Runner Fleet 投影不可用");
        const parsed = parseRunnerFleetProjection(body.data);
        if (parsed.projectId !== projectId) throw new Error("Runner Fleet 项目绑定无效");
        setFleet(parsed); setLoadedProjectId(projectId); setError("");
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setFleet(null); setLoadedProjectId(projectId);
          setError(reason instanceof Error ? reason.message : "Runner Fleet 投影不可用");
        }
      });
    return () => controller.abort();
  }, [production, projectId]);

  return {
    fleet: production && loadedProjectId === projectId ? fleet : null,
    error: production && loadedProjectId === projectId ? error : "",
  };
}
