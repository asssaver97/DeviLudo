"use client";

import { useCallback, useEffect, useState } from "react";
import type { LocalDeliverySnapshot } from "@/lib/local-delivery/model";
import type { DeliverySnapshot } from "@/lib/orchestration/game-delivery";

export type LocalHealth = {
  status: "ok" | "degraded";
  dependencies?: {
    fixtureExecutor?: string;
    localGodot?: string | null;
    developmentWorker?: string;
    localAgentRuntime?: string;
    localAgents?: LocalAgentReadiness[];
    agentCatalogVerified?: boolean;
    inferenceGateway?: string;
    providerBindingProbe?: string;
    activeProviderBinding?: "VERIFIED" | "PARTIAL" | "BLOCKED";
    agentProfileExecution?: "READY" | "PARTIAL" | "BLOCKED";
    activeProviderBindings?: Array<{
      agent: "claude-code" | "codex-cli";
      version: string;
      providerRevisionId: string;
      profileRevisionId: string;
      selectionRole: "PRIMARY" | "FALLBACK" | "PRIMARY_AND_FALLBACK";
      runtimeState: "READY" | "VERSION_MISMATCH" | "UNAVAILABLE";
      state: "VERIFIED" | "BLOCKED";
    }>;
    workerImageIdentity?: string | null;
    expectedWorkerImageIdentity?: string | null;
    workerImageVerified?: boolean;
    workerIdentityMode?: "PINNED_ENV" | "LOCAL_DETERMINISTIC" | "NOT_CONFIGURED";
    windowsRunner?: string;
    linuxRunner?: string;
    macosRunner?: string;
    steam?: string;
  };
};

export type LocalAgentReadiness = {
  agent: "claude-code" | "codex-cli";
  executable: "claude" | "codex";
  expectedVersion: string;
  expectedVersions?: string[];
  observedVersion: string | null;
  state: "READY" | "VERSION_MISMATCH" | "UNAVAILABLE";
};

export function useLocalPlatform(projectId: string | null) {
  const [delivery, setDelivery] = useState<LocalDeliverySnapshot | null>(null);
  const [productionDelivery, setProductionDelivery] = useState<DeliverySnapshot | null>(null);
  const [projectionMeta, setProjectionMeta] = useState<{ projectedAt: string; snapshotDigest: string } | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [health, setHealth] = useState<LocalHealth | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      if (!projectId) {
        const healthResponse = await fetch("/api/health", { cache: "no-store", signal });
        const healthPayload = await healthResponse.json() as LocalHealth & { error?: string };
        if (!healthResponse.ok) throw new Error(healthPayload.error ?? "平台健康状态不可用");
        setDelivery(null); setProductionDelivery(null); setProjectionMeta(null); setLoadedProjectId(null); setHealth(healthPayload); setError("");
        return;
      }
      const [deliveryResponse, healthResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}/delivery`, { cache: "no-store", signal }),
        fetch("/api/health", { cache: "no-store", signal }),
      ]);
      const deliveryPayload = await deliveryResponse.json() as {
        data?: LocalDeliverySnapshot | DeliverySnapshot;
        meta?: { mode?: "LOCAL_D1" | "PRODUCTION"; projectedAt?: string; snapshotDigest?: string };
        error?: { message?: string };
      };
      const healthPayload = await healthResponse.json() as LocalHealth & { error?: string };
      if (!deliveryResponse.ok || !deliveryPayload.data) throw new Error(deliveryPayload.error?.message ?? "交付状态不可用");
      if (!healthResponse.ok) throw new Error(healthPayload.error ?? "本地健康状态不可用");
      if (deliveryPayload.meta?.mode === "PRODUCTION") {
        if (!deliveryPayload.meta.projectedAt || !deliveryPayload.meta.snapshotDigest) throw new Error("生产交付投影元数据无效");
        setDelivery(null);
        setProductionDelivery(deliveryPayload.data as DeliverySnapshot);
        setProjectionMeta({ projectedAt: deliveryPayload.meta.projectedAt, snapshotDigest: deliveryPayload.meta.snapshotDigest });
      } else {
        setDelivery(deliveryPayload.data as LocalDeliverySnapshot);
        setProductionDelivery(null);
        setProjectionMeta(null);
      }
      setLoadedProjectId(projectId);
      setHealth(healthPayload);
      setError("");
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : "本地平台状态不可用");
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void refresh(controller.signal), 0);
    const timer = window.setInterval(() => void refresh(controller.signal), 4_000);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const isCurrentProject = loadedProjectId === projectId;
  return {
    delivery: isCurrentProject ? delivery : null,
    productionDelivery: isCurrentProject ? productionDelivery : null,
    projectionMeta: isCurrentProject ? projectionMeta : null,
    health,
    error,
    refresh,
  };
}
