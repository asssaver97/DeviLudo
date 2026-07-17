"use client";

import { useCallback, useEffect, useState } from "react";
import type { LocalDeliverySnapshot } from "@/lib/local-delivery/model";

export type LocalHealth = {
  status: "ok" | "degraded";
  dependencies?: {
    fixtureExecutor?: string;
    localGodot?: string | null;
    developmentWorker?: string;
    localAgentRuntime?: string;
    localAgents?: LocalAgentReadiness[];
    inferenceGateway?: string;
    providerBindingProbe?: string;
    workerImageIdentity?: string | null;
    expectedWorkerImageIdentity?: string | null;
    workerImageVerified?: boolean;
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
  observedVersion: string | null;
  state: "READY" | "VERSION_MISMATCH" | "UNAVAILABLE";
};

export function useLocalPlatform(projectId = "ember-archipelago") {
  const [delivery, setDelivery] = useState<LocalDeliverySnapshot | null>(null);
  const [health, setHealth] = useState<LocalHealth | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const [deliveryResponse, healthResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}/delivery`, { cache: "no-store", signal }),
        fetch("/api/health", { cache: "no-store", signal }),
      ]);
      const deliveryPayload = await deliveryResponse.json() as { data?: LocalDeliverySnapshot; error?: { message?: string } };
      const healthPayload = await healthResponse.json() as LocalHealth & { error?: string };
      if (!deliveryResponse.ok || !deliveryPayload.data) throw new Error(deliveryPayload.error?.message ?? "交付状态不可用");
      if (!healthResponse.ok) throw new Error(healthPayload.error ?? "本地健康状态不可用");
      setDelivery(deliveryPayload.data);
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

  return { delivery, health, error, refresh };
}
