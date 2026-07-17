import { Injectable } from "@nestjs/common";
import { ServiceProblem, type ProviderRevisionRecord } from "./contracts";

export abstract class ProviderProbe {
  abstract run(provider: ProviderRevisionRecord): Promise<Readonly<Record<string, "PASS" | "FAIL">>>;
}

/**
 * Probes run through the internal inference gateway, which owns DNS pinning,
 * redirect revalidation and temporary access to Vault. The control-plane sends
 * a SecretRef identity only and never receives or forwards upstream key bytes.
 */
export class InferenceGatewayProviderProbe extends ProviderProbe {
  async run(provider: ProviderRevisionRecord): Promise<Readonly<Record<string, "PASS" | "FAIL">>> {
    const endpoint = process.env.DEVILUDO_INFERENCE_PROBE_URL;
    if (!endpoint) {
      if (process.env.NODE_ENV === "production") {
        throw new ServiceProblem(503, "PROBE_GATEWAY_UNAVAILABLE", "The inference gateway probe service is not configured");
      }
      return developmentContractProbe();
    }
    const url = validateProbeEndpoint(endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `provider-probe:${provider.id}`,
        },
        body: JSON.stringify({
          providerRevisionId: provider.id,
          agent: provider.agent,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          models: provider.models,
          credentialVersionId: provider.credentialVersionId,
          requiredChecks: requiredChecks,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new ServiceProblem(409, "PROVIDER_PROBE_FAILED", "The inference gateway rejected the Provider probe");
      const raw: unknown = await response.json();
      const checks = parseChecks(raw);
      if (requiredChecks.some((name) => checks[name] !== "PASS")) {
        throw new ServiceProblem(409, "PROVIDER_PROBE_FAILED", "Every Provider compatibility and network-safety probe must pass");
      }
      return checks;
    } catch (error) {
      if (error instanceof ServiceProblem) throw error;
      throw new ServiceProblem(409, "PROVIDER_PROBE_FAILED", "The inference gateway Provider probe did not complete");
    } finally {
      clearTimeout(timeout);
    }
  }
}

Injectable()(InferenceGatewayProviderProbe);

const requiredChecks = [
  "authentication",
  "modelExistence",
  "streaming",
  "toolCalling",
  "cancellation",
  "usage",
  "timeout",
  "minimalReasoning",
  "dnsPinning",
  "redirectRevalidation",
] as const;

function developmentContractProbe(): Readonly<Record<string, "PASS">> {
  return Object.freeze(Object.fromEntries(requiredChecks.map((name) => [name, "PASS"])) as Record<string, "PASS">);
}

function validateProbeEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ServiceProblem(500, "INVALID_PROBE_GATEWAY", "Inference probe gateway URL must be credential-free HTTPS");
  }
  return url.toString();
}

function parseChecks(raw: unknown): Readonly<Record<string, "PASS" | "FAIL">> {
  if (!raw || typeof raw !== "object") throw new ServiceProblem(409, "INVALID_PROBE_RESPONSE", "Provider probe response is invalid");
  const value = (raw as Record<string, unknown>).checks;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceProblem(409, "INVALID_PROBE_RESPONSE", "Provider probe response has no checks object");
  }
  const checks = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, result]) => [key, result === "PASS" ? "PASS" : "FAIL"]),
  ) as Record<string, "PASS" | "FAIL">;
  return Object.freeze(checks);
}
