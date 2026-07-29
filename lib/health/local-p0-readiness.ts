import type { LocalAgentRuntimeProbe } from "../admin/local-agent-health";

export type LocalBootstrapStatus = "READY" | "NOT_REQUIRED" | "NOT_CONFIGURED" | "UNAVAILABLE" | "IDENTITY_MISMATCH";

export interface LocalP0BootstrapReadiness {
  readonly ready: boolean;
  readonly dependencies: Readonly<{
    accountPlatform: LocalBootstrapStatus;
    localGodot: LocalBootstrapStatus;
    localAgentRuntime: LocalBootstrapStatus;
    localSpecRuntime: LocalBootstrapStatus;
    inferenceGateway: LocalBootstrapStatus;
  }>;
  readonly agentProbe: LocalAgentRuntimeProbe;
  readonly inferenceProbe: Readonly<Record<string, unknown>>;
}

type Environment = Readonly<Record<string, string | undefined>>;

export async function evaluateLocalP0BootstrapReadiness(
  env: Environment = localP0Environment(),
  options: Readonly<{ fetch?: typeof fetch; timeoutMs?: number }> = {},
): Promise<LocalP0BootstrapReadiness> {
  // Keep the platform global fetch as a direct call. Vinext's Worker bridge
  // rejects the host fetch implementation when it is detached and forwarded
  // through a function parameter, even when an explicit receiver is supplied.
  const fetcher = options.fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new Error("Local readiness timeout is invalid");
  const managed = env.DEVILUDO_PLATFORM_MANAGED_CONFIGURATION === "1";
  const accountEndpoint = env.DEVILUDO_ACCOUNT_API_URL;
  const runtime = loopbackOrigin(env.DEVILUDO_LOCAL_RUNTIME_URL, "http://127.0.0.1:4311");
  const agent = loopbackOrigin(env.DEVILUDO_LOCAL_AGENT_RUNTIME_URL, "http://127.0.0.1:4312");
  const spec = loopbackOrigin(env.DEVILUDO_LOCAL_SPEC_RUNTIME_URL, "http://127.0.0.1:4313");
  const gateway = loopbackOrigin(env.DEVILUDO_LOCAL_INFERENCE_GATEWAY_URL, "http://127.0.0.1:4314/v1");
  // vinext's local Worker bridge does not guarantee concurrent loopback fetches
  // to separate host sidecars. Bootstrap is infrequent, so probe them in a
  // deterministic sequence and preserve the identity of the failing boundary.
  const accountResult = managed
    ? await probe(accountEndpoint, "/healthz", (body) => body.status === "ok" && body.service === "deviludo-account-api", fetcher, timeoutMs, true)
    : { status: "NOT_REQUIRED" as const, body: null };
  const runtimeResult = await probe(runtime, "/health", (body) => body.status === "ok" && body.service === "deviludo-local-runtime"
    && typeof body.godotVersion === "string" && body.godotVersion.length > 0
    && typeof body.exportTemplatesRoot === "string" && body.exportTemplatesRoot.length > 0, fetcher, timeoutMs);
  const agentResult = await probe(agent, "/health", (body) => body.status === "ok" && body.service === "deviludo-local-agent-runtime"
    && body.executionEnabled === true && body.workerImageVerified === true, fetcher, timeoutMs);
  const specResult = await probe(spec, "/health", (body) => body.status === "ok" && body.service === "deviludo-local-spec-runtime", fetcher, timeoutMs);
  const gatewayResult = await probe(gateway, "/healthz", (body) => body.schemaVersion === "deviludo.inference-gateway-health.v1"
    && new Set(["ok", "unavailable"]).has(String(body.status))
    && body.service === "deviludo-inference-gateway" && body.connector === "CONFIGURED"
    && new Set(["CONFIGURED", "NOT_CONFIGURED"]).has(String(body.providerProbe))
    && new Set(["CONFIGURED", "NOT_CONFIGURED"]).has(String(body.reconciliation)), fetcher, timeoutMs, false, true);
  const dependencies = Object.freeze({
    accountPlatform: accountResult.status,
    localGodot: runtimeResult.status,
    localAgentRuntime: agentResult.status,
    localSpecRuntime: specResult.status,
    inferenceGateway: gatewayResult.status,
  });
  const agentProbe = agentResult.body && typeof agentResult.body === "object"
    ? agentResult.body as LocalAgentRuntimeProbe : { status: "NOT_CONNECTED" as const };
  return Object.freeze({
    ready: Object.values(dependencies).every((status) => status === "READY" || status === "NOT_REQUIRED"),
    dependencies,
    agentProbe,
    inferenceProbe: gatewayResult.body ?? Object.freeze({ status: "NOT_CONNECTED" }),
  });
}

function localP0Environment(): Environment {
  // Keep each non-secret launcher binding explicit so Next/Vinext can replace
  // only the allow-listed properties from next.config.ts. Never spread the
  // launcher environment into the Worker or expose its secret bindings here.
  return Object.freeze({
    DEVILUDO_PLATFORM_MANAGED_CONFIGURATION: process.env.DEVILUDO_PLATFORM_MANAGED_CONFIGURATION,
    DEVILUDO_ACCOUNT_API_URL: process.env.DEVILUDO_ACCOUNT_API_URL,
    DEVILUDO_LOCAL_RUNTIME_URL: process.env.DEVILUDO_LOCAL_RUNTIME_URL,
    DEVILUDO_LOCAL_AGENT_RUNTIME_URL: process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_URL,
    DEVILUDO_LOCAL_SPEC_RUNTIME_URL: process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_URL,
    DEVILUDO_LOCAL_INFERENCE_GATEWAY_URL: process.env.DEVILUDO_LOCAL_INFERENCE_GATEWAY_URL,
  });
}

async function probe(
  endpoint: string | undefined,
  pathname: string,
  valid: (body: Readonly<Record<string, unknown>>) => boolean,
  fetcher: typeof fetch | undefined,
  timeoutMs: number,
  allowConfiguredLocal = false,
  acceptServiceUnavailable = false,
): Promise<Readonly<{ status: LocalBootstrapStatus; body: Readonly<Record<string, unknown>> | null }>> {
  if (!endpoint) return Object.freeze({ status: "NOT_CONFIGURED", body: null });
  let url: URL;
  try {
    url = new URL(endpoint);
    if (!allowConfiguredLocal) assertLoopback(url);
    else if (url.protocol === "http:") assertLoopback(url);
    else if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
  } catch { return Object.freeze({ status: "NOT_CONFIGURED", body: null }); }
  try {
    // Vinext's local Worker-to-host bridge currently rejects the richer
    // RequestInit shape (notably redirect policy) for loopback sidecars. These
    // are identity-checked health reads; reject a followed redirect below.
    const init: RequestInit = { signal: AbortSignal.timeout(timeoutMs) };
    const response = fetcher
      ? await fetcher(url.href, init)
      : await fetch(url.href, init);
    if ((!response.ok && !(acceptServiceUnavailable && response.status === 503)) || response.redirected) {
      return Object.freeze({ status: "UNAVAILABLE", body: null });
    }
    const body = await response.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return Object.freeze({ status: "IDENTITY_MISMATCH", body: null });
    const record = body as Readonly<Record<string, unknown>>;
    return Object.freeze({ status: valid(record) ? "READY" : "IDENTITY_MISMATCH", body: record });
  } catch { return Object.freeze({ status: "UNAVAILABLE", body: null }); }
}

function loopbackOrigin(value: string | undefined, fallback: string): string {
  const url = new URL(value ?? fallback);
  assertLoopback(url);
  return url.origin;
}

function assertLoopback(url: URL): void {
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.username || url.password || url.search || url.hash) throw new Error("Local readiness origin must be loopback HTTP");
}
