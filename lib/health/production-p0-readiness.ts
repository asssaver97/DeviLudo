import { evaluateProductionWebReadiness, type ProductionReadinessOptions } from "./production-readiness";

const MAX_RESPONSE_BYTES = 16 * 1024;
const EXACT_KEYS = Object.freeze([
  "agentFleet", "artifactStore", "claudeAgent", "claudeCliVersion", "claudeModel", "claudeProfile",
  "inferenceGateway", "linuxFleet", "macCapacity", "migrations", "schemaVersion", "status", "vault", "windowsFleet",
].sort());

type Environment = Readonly<Record<string, string | undefined>>;
export type P0RuntimeStatus = "READY" | "NOT_CONFIGURED" | "INVALID_CONFIGURATION" | "UNAVAILABLE" | "IDENTITY_MISMATCH";

export interface ProductionP0OperationalReadiness {
  readonly ready: boolean;
  readonly controlPlane: Awaited<ReturnType<typeof evaluateProductionWebReadiness>>;
  readonly p0Runtime: P0RuntimeStatus;
}

export async function evaluateProductionP0OperationalReadiness(
  env: Environment = process.env,
  options: ProductionReadinessOptions = {},
): Promise<ProductionP0OperationalReadiness> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const controlPlane = await evaluateProductionWebReadiness(env, { ...options, profile: "P0_INTERNAL" });
  const p0Runtime = await probeRuntime(env.DEVILUDO_P0_RUNTIME_READINESS_URL, options.fetch ?? fetch, timeoutMs);
  return Object.freeze({ ready: controlPlane.ready && p0Runtime === "READY", controlPlane, p0Runtime });
}

async function probeRuntime(endpoint: string | undefined, fetcher: typeof fetch, timeoutMs: number): Promise<P0RuntimeStatus> {
  if (!endpoint) return "NOT_CONFIGURED";
  let url: URL;
  try {
    url = new URL(endpoint.trim());
    const internalHttp = url.protocol === "http:" && url.hostname.endsWith(".deviludo.svc.cluster.local");
    if ((!internalHttp && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      return "INVALID_CONFIGURATION";
    }
    url.pathname = "/healthz";
  } catch { return "INVALID_CONFIGURATION"; }
  try {
    const response = await fetcher(url, { method: "GET", headers: { accept: "application/json", "cache-control": "no-cache" },
      redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return "UNAVAILABLE";
    const declared = response.headers.get("content-length");
    if (declared && (!Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_RESPONSE_BYTES)) return "IDENTITY_MISMATCH";
    const text = await readBoundedText(response);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!body || Array.isArray(body) || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(EXACT_KEYS)) return "IDENTITY_MISMATCH";
    const exactReady = body.schemaVersion === "deviludo.p0-runtime-readiness.v1" && body.status === "ready"
      && body.claudeAgent === "claude-code" && body.claudeProfile === "READY"
      && typeof body.claudeCliVersion === "string" && /^\d+\.\d+\.\d+$/.test(body.claudeCliVersion)
      && typeof body.claudeModel === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(body.claudeModel)
      && !/^(latest|default|sonnet)$/i.test(body.claudeModel)
      && body.agentFleet === "READY" && body.linuxFleet === "READY" && body.windowsFleet === "READY"
      && body.macCapacity === "ON_DEMAND_READY" && body.inferenceGateway === "READY"
      && body.artifactStore === "READY" && body.vault === "READY" && body.migrations === "READY";
    return exactReady ? "READY" : "IDENTITY_MISMATCH";
  } catch { return "UNAVAILABLE"; }
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error("P0 runtime response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("P0 runtime response is oversized");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
