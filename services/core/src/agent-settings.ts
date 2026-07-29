import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  AGENT_RUNTIME_KINDS,
  type AgentModelConfiguration,
  type AgentRuntimeKind,
} from "@/lib/product/contracts";

export type AgentSettingsInput = Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  apiKey: string | null;
  models: AgentModelConfiguration | null;
}>;

export type AgentSecretVersion = Readonly<{
  secretRef: string;
  mask: string;
  fingerprint: string;
  version: string;
}>;

export interface AgentSecretStore {
  writeApiKey(apiKey: string): Promise<AgentSecretVersion>;
  readApiKey(secretRef: string): Promise<string | null>;
  readApiKeyMask(secretRef: string): Promise<string | null>;
}

export function parseAgentSettingsInput(
  value: unknown,
  environment = process.env.NODE_ENV ?? "development",
): AgentSettingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent settings must be an object");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !["agentRuntime", "baseUrl", "apiKey", "models", "settingsJson"].includes(key));
  if (unknown.length > 0) throw new Error("Agent settings contain unsupported fields");
  if (!(AGENT_RUNTIME_KINDS as readonly unknown[]).includes(input.agentRuntime)) {
    throw new Error("Agent runtime must be Claude Code or Codex CLI");
  }
  const fromJson = input.settingsJson !== undefined;
  if (fromJson && (input.baseUrl !== undefined || input.apiKey !== undefined || input.models !== undefined)) {
    throw new Error("Use either simple connection fields or Claude settings.json");
  }
  if (fromJson && input.agentRuntime !== "CLAUDE_CODE") {
    throw new Error("settings.json mode is only available for Claude Code");
  }
  const connection = fromJson
    ? parseClaudeSettingsJson(input.settingsJson)
    : { baseUrl: input.baseUrl, apiKey: input.apiKey, models: input.models };
  if (typeof connection.baseUrl !== "string") throw new Error("Provider Base URL is required");
  const baseUrl = normalizeBaseUrl(connection.baseUrl, environment);
  let apiKey: string | null = null;
  if (connection.apiKey !== undefined && connection.apiKey !== null && connection.apiKey !== "") {
    if (typeof connection.apiKey !== "string"
      || connection.apiKey.length < 8
      || connection.apiKey.length > 4096
      || connection.apiKey !== connection.apiKey.trim()
      || /[\u0000-\u001f\u007f]/.test(connection.apiKey)) {
      throw new Error("API Key format is invalid");
    }
    apiKey = connection.apiKey;
  }
  const models = normalizeAgentModels(connection.models);
  if (input.agentRuntime === "CLAUDE_CODE" && models === null) {
    throw new Error("Claude Code requires all five model routes");
  }
  if (input.agentRuntime === "CODEX_CLI" && models !== null) {
    throw new Error("Claude model routes cannot be used with Codex CLI");
  }
  return Object.freeze({
    agentRuntime: input.agentRuntime as AgentRuntimeKind,
    baseUrl,
    apiKey,
    models,
  });
}

export function parseClaudeSettingsJson(value: unknown): Readonly<{
  baseUrl: unknown;
  apiKey: unknown;
  models: unknown;
}> {
  if (typeof value !== "string" || value.length < 2 || value.length > 16 * 1024) {
    throw new Error("Claude settings.json must be a JSON string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Claude settings.json is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude settings.json must contain an object");
  }
  const root = parsed as Record<string, unknown>;
  const unsupportedRoot = Object.keys(root).filter(key => key !== "env" && key !== "$schema");
  if (unsupportedRoot.length > 0) {
    throw new Error("Only connection fields in Claude settings.json are supported");
  }
  if (!root.env || typeof root.env !== "object" || Array.isArray(root.env)) {
    throw new Error("Claude settings.json must contain an env object");
  }
  const env = root.env as Record<string, unknown>;
  const modelKeys = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ] as const;
  const supported = new Set([
    "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", ...modelKeys,
  ]);
  if (Object.keys(env).some(key => !supported.has(key))) {
    throw new Error("Claude settings.json contains unsupported environment fields");
  }
  const apiKey = env.ANTHROPIC_API_KEY;
  const authToken = env.ANTHROPIC_AUTH_TOKEN;
  if (apiKey && authToken && apiKey !== authToken) {
    throw new Error("Claude settings.json contains conflicting credentials");
  }
  const configuredModels = modelKeys.map(key => env[key]);
  const presentModels = configuredModels.filter(value => value !== undefined && value !== "");
  if (presentModels.some(value => typeof value !== "string")) {
    throw new Error("Claude settings.json model values must be strings");
  }
  if (presentModels.length > 0 && presentModels.length !== modelKeys.length) {
    throw new Error("Claude settings.json must provide all five model values");
  }
  return Object.freeze({
    baseUrl: env.ANTHROPIC_BASE_URL,
    apiKey: apiKey || authToken,
    models: presentModels.length === 0 ? null : {
      primary: env.ANTHROPIC_MODEL,
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      subagent: env.CLAUDE_CODE_SUBAGENT_MODEL,
    },
  });
}

export function normalizeAgentModels(value: unknown): AgentModelConfiguration | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent models must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = ["primary", "opus", "sonnet", "haiku", "subagent"] as const;
  if (Object.keys(input).length !== keys.length || keys.some(key => !(key in input))) {
    throw new Error("Agent models must contain all five routes");
  }
  const normalized = Object.fromEntries(keys.map(key => [key, normalizeAgentModel(input[key])])) as Record<string, string>;
  return Object.freeze(normalized as AgentModelConfiguration);
}

function normalizeAgentModel(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw new Error("Agent model format is invalid");
  }
  return value;
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

  async writeApiKey(apiKey: string): Promise<AgentSecretVersion> {
    const version = randomUUID();
    const directory = join(this.root, "instance", "agent-runtime", "api-key", "versions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${version}.key`);
    const temporary = join(directory, `${version}.${process.pid}.tmp`);
    await writeFile(temporary, apiKey, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    return secretVersion(version, apiKey);
  }

  async readApiKey(secretRef: string): Promise<string | null> {
    const prefix = "vault://instance/agent-runtime/api-key/versions/";
    if (!secretRef.startsWith(prefix)) return null;
    const version = secretRef.slice(prefix.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(version)) {
      return null;
    }
    try {
      return await readFile(join(this.root, "instance", "agent-runtime", "api-key", "versions", `${version}.key`), "utf8");
    } catch {
      return null;
    }
  }

  async readApiKeyMask(secretRef: string): Promise<string | null> {
    const apiKey = await this.readApiKey(secretRef);
    return apiKey ? maskApiKey(apiKey) : null;
  }
}

class BrokerAgentSecretStore implements AgentSecretStore {
  private readonly writeEndpoint: URL;
  private readonly readEndpoint: URL;
  private readonly tokenFile: string;

  constructor(env: NodeJS.ProcessEnv) {
    const rawUrl = env.DEVILUDO_AGENT_SECRET_BROKER_URL ?? "";
    if (!rawUrl) throw new Error("Production Agent secret broker URL is required");
    try {
      this.writeEndpoint = new URL("/v1/instance-agent-secrets", rawUrl);
      this.readEndpoint = new URL("/v1/instance-agent-secrets/resolve", rawUrl);
    } catch {
      throw new Error("Production Agent secret broker URL is invalid");
    }
    if (this.writeEndpoint.protocol !== "https:" || this.writeEndpoint.username || this.writeEndpoint.password) {
      throw new Error("Production Agent secret broker must use HTTPS");
    }
    this.tokenFile = env.DEVILUDO_AGENT_SECRET_BROKER_TOKEN_FILE ?? "";
    if (!isAbsolute(this.tokenFile)) throw new Error("Agent secret broker token must be file-mounted");
  }

  async writeApiKey(apiKey: string): Promise<AgentSecretVersion> {
    const version = randomUUID();
    const expected = secretVersion(version, apiKey);
    const token = await this.readToken();
    const response = await fetch(this.writeEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `instance-agent-key:${version}`,
      },
      body: JSON.stringify({ version, apiKey }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Agent secret broker returned ${response.status}`);
    const body = await response.json() as { secretRef?: unknown };
    if (body.secretRef !== expected.secretRef) throw new Error("Agent secret broker returned an invalid instance reference");
    return expected;
  }

  async readApiKey(secretRef: string): Promise<string | null> {
    if (!secretRef.startsWith("vault://instance/agent-runtime/api-key/versions/")) return null;
    const response = await fetch(this.readEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.readToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ secretRef }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { apiKey?: unknown };
    return typeof body.apiKey === "string" && body.apiKey.length >= 8 ? body.apiKey : null;
  }

  async readApiKeyMask(secretRef: string): Promise<string | null> {
    const apiKey = await this.readApiKey(secretRef);
    return apiKey ? maskApiKey(apiKey) : null;
  }

  private async readToken(): Promise<string> {
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    if (token.length < 24 || token.length > 4096) throw new Error("Agent secret broker token is invalid");
    return token;
  }
}

function secretVersion(version: string, apiKey: string): AgentSecretVersion {
  return Object.freeze({
    secretRef: `vault://instance/agent-runtime/api-key/versions/${version}`,
    mask: maskApiKey(apiKey),
    fingerprint: `sha256:${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`,
    version,
  });
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length < 8) throw new Error("API Key format is invalid");
  return `${apiKey.slice(0, 3)}********${apiKey.slice(-4)}`;
}

export function isMaskedApiKey(value: string): boolean {
  return /^.{3}\*{8}.{4}$/.test(value);
}
