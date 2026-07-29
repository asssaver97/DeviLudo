import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AGENT_RUNTIME_KINDS, type AgentRuntimeKind } from "@/lib/product/contracts";

export type AgentSettingsInput = Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  apiKey: string | null;
}>;

export type AgentSecretVersion = Readonly<{
  secretRef: string;
  fingerprint: string;
  version: string;
}>;

export interface AgentSecretStore {
  writeApiKey(tenantId: string, apiKey: string): Promise<AgentSecretVersion>;
}

export function parseAgentSettingsInput(
  value: unknown,
  environment = process.env.NODE_ENV ?? "development",
): AgentSettingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent settings must be an object");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !["agentRuntime", "baseUrl", "apiKey"].includes(key));
  if (unknown.length > 0) throw new Error("Agent settings contain unsupported fields");
  if (!(AGENT_RUNTIME_KINDS as readonly unknown[]).includes(input.agentRuntime)) {
    throw new Error("Agent runtime must be Claude Code or Codex CLI");
  }
  if (typeof input.baseUrl !== "string") throw new Error("Provider Base URL is required");
  const baseUrl = normalizeBaseUrl(input.baseUrl, environment);
  let apiKey: string | null = null;
  if (input.apiKey !== undefined && input.apiKey !== null && input.apiKey !== "") {
    if (typeof input.apiKey !== "string"
      || input.apiKey.length < 8
      || input.apiKey.length > 4096
      || input.apiKey !== input.apiKey.trim()
      || /[\u0000-\u001f\u007f]/.test(input.apiKey)) {
      throw new Error("API Key format is invalid");
    }
    apiKey = input.apiKey;
  }
  return Object.freeze({
    agentRuntime: input.agentRuntime as AgentRuntimeKind,
    baseUrl,
    apiKey,
  });
}

export function normalizeBaseUrl(value: string, environment: string): string {
  if (value.length > 2048 || value !== value.trim()) throw new Error("Provider Base URL is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provider Base URL is invalid");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Provider Base URL cannot contain credentials, query, or fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(environment !== "production" && url.protocol === "http:" && loopback)) {
    throw new Error("Provider Base URL must use HTTPS");
  }
  return url.href.replace(/\/$/, "");
}

export function createAgentSecretStore(env: NodeJS.ProcessEnv = process.env): AgentSecretStore {
  return env.NODE_ENV === "production"
    ? new BrokerAgentSecretStore(env)
    : new LocalAgentSecretStore(env.DEVILUDO_AGENT_SECRET_ROOT ?? "/tmp/deviludo-agent-secrets");
}

export class LocalAgentSecretStore implements AgentSecretStore {
  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new Error("Local Agent secret root must be absolute");
  }

  async writeApiKey(tenantId: string, apiKey: string): Promise<AgentSecretVersion> {
    assertTenantId(tenantId);
    const version = randomUUID();
    const directory = join(this.root, "tenants", tenantId, "agent-runtime", "api-key", "versions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${version}.key`);
    const temporary = join(directory, `${version}.${process.pid}.tmp`);
    await writeFile(temporary, apiKey, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    return secretVersion(tenantId, version, apiKey);
  }
}

class BrokerAgentSecretStore implements AgentSecretStore {
  private readonly endpoint: URL;
  private readonly tokenFile: string;

  constructor(env: NodeJS.ProcessEnv) {
    const rawUrl = env.DEVILUDO_AGENT_SECRET_BROKER_URL ?? "";
    if (!rawUrl) throw new Error("Production Agent secret broker URL is required");
    try {
      this.endpoint = new URL("/v1/tenant-agent-secrets", rawUrl);
    } catch {
      throw new Error("Production Agent secret broker URL is invalid");
    }
    if (this.endpoint.protocol !== "https:" || this.endpoint.username || this.endpoint.password) {
      throw new Error("Production Agent secret broker must use HTTPS");
    }
    this.tokenFile = env.DEVILUDO_AGENT_SECRET_BROKER_TOKEN_FILE ?? "";
    if (!isAbsolute(this.tokenFile)) throw new Error("Agent secret broker token must be file-mounted");
  }

  async writeApiKey(tenantId: string, apiKey: string): Promise<AgentSecretVersion> {
    assertTenantId(tenantId);
    const version = randomUUID();
    const expected = secretVersion(tenantId, version, apiKey);
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    if (token.length < 24 || token.length > 4096) throw new Error("Agent secret broker token is invalid");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `tenant-agent-key:${tenantId}:${version}`,
      },
      body: JSON.stringify({ tenantId, version, apiKey }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Agent secret broker returned ${response.status}`);
    const body = await response.json() as { secretRef?: unknown };
    if (body.secretRef !== expected.secretRef) throw new Error("Agent secret broker returned an invalid tenant reference");
    return expected;
  }
}

function secretVersion(tenantId: string, version: string, apiKey: string): AgentSecretVersion {
  return Object.freeze({
    secretRef: `vault://tenants/${tenantId}/agent-runtime/api-key/versions/${version}`,
    fingerprint: `sha256:${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`,
    version,
  });
}

function assertTenantId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Tenant id is invalid");
  }
}
