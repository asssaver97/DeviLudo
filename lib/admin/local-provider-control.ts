import { HttpProblem } from "@/lib/control-plane/http";
import { createLocalAgentRuntimeHeaders } from "@/services/local-agent-runtime/src/request-auth";
import { PROVIDER_PROBE_CHECKS, type GatewayProviderProbeRequest } from "@/services/inference-gateway/src/provider-probe";

type LocalCredentialReceipt = Readonly<{
  credentialVersionId: string;
  secretRef: string;
  fingerprint: `sha256:${string}`;
  state: "STORED";
}>;

export function localProviderControlRequired(): boolean {
  return process.env.DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED === "1";
}

export async function putLocalProviderCredential(
  credentialVersionId: string,
  secret: string,
  expectedFingerprint: `sha256:${string}`,
): Promise<LocalCredentialReceipt> {
  const data = await post("/v1/provider-credentials", { credentialVersionId, secret }, "LOCAL_PROVIDER_VAULT_UNAVAILABLE");
  const item = record(data);
  if (item.credentialVersionId !== credentialVersionId
    || item.state !== "STORED"
    || item.fingerprint !== expectedFingerprint
    || typeof item.secretRef !== "string"
    || !/^secret:\/\/local-agent-runtime\/[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(item.secretRef)
    || !exactKeys(item, ["credentialVersionId", "fingerprint", "secretRef", "state"])) {
    throw new HttpProblem(502, "LOCAL_PROVIDER_VAULT_INVALID", "本机 Provider 密钥保管回执无效");
  }
  return Object.freeze(item as unknown as LocalCredentialReceipt);
}

export async function revokeLocalProviderCredential(credentialVersionId: string): Promise<void> {
  const data = await post("/v1/provider-credentials/revoke", { credentialVersionId }, "LOCAL_PROVIDER_VAULT_UNAVAILABLE");
  const item = record(data);
  if (item.credentialVersionId !== credentialVersionId || item.state !== "REVOKED"
    || !exactKeys(item, ["credentialVersionId", "state"])) {
    throw new HttpProblem(502, "LOCAL_PROVIDER_VAULT_INVALID", "本机 Provider 密钥撤销回执无效");
  }
}

export async function probeLocalProvider(value: GatewayProviderProbeRequest): Promise<Readonly<Record<string, "PASS">>> {
  const data = await post("/v1/provider-probes", value, "PROVIDER_PROBE_UNAVAILABLE");
  const item = record(data);
  const checks = record(item.checks);
  if (item.providerRevisionId !== value.providerRevisionId
    || item.credentialVersionId !== value.credentialVersionId
    || item.state !== "READY"
    || !exactKeys(item, ["checks", "credentialVersionId", "providerRevisionId", "state"])
    || !exactKeys(checks, PROVIDER_PROBE_CHECKS)
    || !PROVIDER_PROBE_CHECKS.every((check) => checks[check] === "PASS")) {
    throw new HttpProblem(502, "PROVIDER_PROBE_RECEIPT_INVALID", "本机 Provider 探针回执无效");
  }
  return Object.freeze({ ...checks } as Record<string, "PASS">);
}

async function post(path: "/v1/provider-credentials" | "/v1/provider-credentials/revoke" | "/v1/provider-probes", value: unknown, unavailableCode: string): Promise<unknown> {
  const body = JSON.stringify(value);
  let response: Response;
  try {
    response = await fetch(new URL(path, localAgentRuntimeUrl()), {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        ...createLocalAgentRuntimeHeaders({ method: "POST", path, body }),
      },
      body,
      signal: AbortSignal.timeout(path === "/v1/provider-probes" ? 120_000 : 15_000),
    });
  } catch {
    throw new HttpProblem(503, unavailableCode, "本机 Provider 安全连接器不可用；现有生效配置未改变");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new HttpProblem(502, "LOCAL_PROVIDER_CONNECTOR_INVALID", "本机 Provider 安全连接器返回了不安全的重定向");
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new HttpProblem(502, "LOCAL_PROVIDER_CONNECTOR_INVALID", "本机 Provider 安全连接器响应无效"); }
  const envelope = record(payload);
  if (!response.ok) {
    const error = recordOrNull(envelope.error);
    const code = typeof error?.code === "string" ? error.code : unavailableCode;
    const probeFailure = path === "/v1/provider-probes" && response.status === 422;
    throw new HttpProblem(probeFailure ? 422 : 503, probeFailure ? "PROVIDER_PROBE_FAILED" : code,
      probeFailure ? "Provider 兼容性探针未通过；草稿和当前生效配置均已保留" : "本机 Provider 安全连接器拒绝了请求");
  }
  return envelope.data;
}

function localAgentRuntimeUrl(): URL {
  const url = new URL(process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_URL ?? "http://127.0.0.1:4312");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new HttpProblem(500, "LOCAL_PROVIDER_CONNECTOR_CONFIGURATION_INVALID", "本机 Provider 安全连接器必须是纯 loopback HTTP origin");
  }
  return url;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpProblem(502, "LOCAL_PROVIDER_CONNECTOR_INVALID", "本机 Provider 安全连接器响应无效");
  }
  return value as Record<string, unknown>;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
