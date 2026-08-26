import { readFileSync } from "node:fs";
import type { AgentRuntimeLocalDefault, AgentRuntimeKind } from "@/lib/product/contracts";
import { maskApiKey, parseAgentSettingsInput } from "./agent-settings";

const DEFAULTS_FILE = "/run/deviludo-agent/runtime-defaults.json";
const MAX_DEFAULTS_BYTES = 32 * 1024;

export type LocalAgentRuntimeDefault = Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  primaryModel: string;
  apiKey: string | null;
  source: string;
}>;

export function readLocalAgentRuntimeDefaults(
  path = process.env.DEVILUDO_AGENT_RUNTIME_DEFAULTS_FILE ?? DEFAULTS_FILE,
  environment: "development" | "test" | "production" = runtimeEnvironment(process.env.NODE_ENV),
): readonly LocalAgentRuntimeDefault[] {
  let serialized: string;
  try {
    serialized = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  if (Buffer.byteLength(serialized) > MAX_DEFAULTS_BYTES) {
    throw new Error("Local Agent Runtime defaults file is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Local Agent Runtime defaults file is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Local Agent Runtime defaults file must contain an object");
  }
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.runtimes)) {
    throw new Error("Local Agent Runtime defaults file has an unsupported format");
  }
  const defaults = root.runtimes.map((candidate, index) => parseLocalDefault(candidate, index, environment));
  if (new Set(defaults.map(candidate => candidate.agentRuntime)).size !== defaults.length) {
    throw new Error("Local Agent Runtime defaults file contains duplicate runtimes");
  }
  return Object.freeze(defaults);
}

export function publicLocalAgentRuntimeDefault(value: LocalAgentRuntimeDefault): AgentRuntimeLocalDefault {
  return Object.freeze({
    agentRuntime: value.agentRuntime,
    baseUrl: value.baseUrl,
    primaryModel: value.primaryModel,
    apiKeyConfigured: value.apiKey !== null,
    apiKeyMasked: value.apiKey === null ? null : maskApiKey(value.apiKey),
    source: value.source,
  });
}

export function matchingLocalAgentRuntimeDefault(
  defaults: readonly LocalAgentRuntimeDefault[],
  agentRuntime: AgentRuntimeKind,
  baseUrl: string,
): LocalAgentRuntimeDefault | null {
  return defaults.find(candidate => candidate.agentRuntime === agentRuntime && candidate.baseUrl === baseUrl) ?? null;
}

function parseLocalDefault(
  value: unknown,
  index: number,
  environment: "development" | "test" | "production",
): LocalAgentRuntimeDefault {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Local Agent Runtime default ${index} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["agentRuntime", "baseUrl", "primaryModel", "apiKey", "source"]);
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new Error(`Local Agent Runtime default ${index} contains unsupported fields`);
  }
  if (typeof input.source !== "string" || !input.source.trim() || input.source.length > 512) {
    throw new Error(`Local Agent Runtime default ${index} has an invalid source`);
  }
  const normalized = parseAgentSettingsInput({
    agentRuntime: input.agentRuntime,
    baseUrl: input.baseUrl,
    primaryModel: input.primaryModel,
    apiKey: input.apiKey,
  }, environment);
  return Object.freeze({
    agentRuntime: normalized.agentRuntime,
    baseUrl: normalized.baseUrl,
    primaryModel: normalized.primaryModel,
    apiKey: normalized.apiKey,
    source: input.source.trim(),
  });
}

function runtimeEnvironment(value: string | undefined): "development" | "test" | "production" {
  return value === "production" || value === "test" ? value : "development";
}
