import { validateProviderBaseUrl } from "../security/network";
import type { AgentKind, ModelRoles } from "./types";

export type ProviderLifecycle =
  | "DRAFT"
  | "VALIDATING"
  | "READY"
  | "ACTIVE"
  | "DEGRADED"
  | "DISABLED";

export interface ProviderGovernance {
  readonly dataRegion: string;
  readonly retentionPolicy: string;
  readonly trainingPolicy: string;
  readonly confirmedByAdminId: string;
  readonly confirmedAt: string;
}

interface ProviderRevisionBase {
  readonly providerRevisionId: string;
  readonly revision: number;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly lifecycle: ProviderLifecycle;
  readonly models: ModelRoles;
  readonly governance?: ProviderGovernance;
  readonly approvedPorts?: readonly number[];
}

/** Codex providers are deliberately not interchangeable with Claude providers. */
export interface CodexResponsesProviderRevision extends ProviderRevisionBase {
  readonly agent: "codex-cli";
  readonly protocol: "openai-responses";
  readonly wireApi: "responses";
  readonly authentication: "bearer";
}

/** Claude providers must implement the Anthropic Messages/Gateway contract. */
export interface ClaudeMessagesProviderRevision extends ProviderRevisionBase {
  readonly agent: "claude-code";
  readonly protocol: "anthropic-messages";
  readonly authentication: "x-api-key" | "authorization-bearer";
  readonly anthropicVersion: string;
}

export type ProviderRevision =
  | CodexResponsesProviderRevision
  | ClaudeMessagesProviderRevision;

const FLOATING_MODEL_ALIASES = new Set([
  "latest",
  "default",
  "stable",
  "preview",
  "sonnet",
  "opus",
  "haiku",
  "claude-sonnet",
  "claude-opus",
  "claude-haiku",
  "gpt",
  "codex",
]);

/**
 * Active profiles need a version-bearing canonical model id. Draft discovery may
 * accept aliases, but this check must run after the probe resolves an alias.
 */
export function assertPinnedModelId(modelId: string): string {
  const value = modelId.trim();
  const lower = value.toLowerCase();

  if (!value || value !== modelId || /\s/.test(value)) {
    throw new Error("Model id must be a non-empty canonical identifier without whitespace");
  }

  if (
    FLOATING_MODEL_ALIASES.has(lower) ||
    /(?:^|[-_:/.])(latest|default|stable|preview)$/.test(lower)
  ) {
    throw new Error(`Floating model alias is not allowed in an active profile: ${modelId}`);
  }

  if (!/\d/.test(value)) {
    throw new Error(`Pinned model id must contain a version or release number: ${modelId}`);
  }

  return value;
}

export function normalizeModelRoles(input: {
  readonly primaryModel: string;
  readonly planningModel?: string;
  readonly smallFastModel?: string;
  readonly subagentModel?: string;
}): ModelRoles {
  const primaryModel = assertPinnedModelId(input.primaryModel);
  return Object.freeze({
    primaryModel,
    planningModel: assertPinnedModelId(input.planningModel ?? primaryModel),
    smallFastModel: assertPinnedModelId(input.smallFastModel ?? primaryModel),
    subagentModel: assertPinnedModelId(input.subagentModel ?? primaryModel),
  });
}

export function validateProviderRevision(provider: ProviderRevision): ProviderRevision {
  validateProviderBaseUrl(provider.baseUrl, {
    approvedPorts: provider.approvedPorts ?? [443],
  });

  if (provider.agent === "codex-cli") {
    if (provider.protocol !== "openai-responses" || provider.wireApi !== "responses") {
      throw new Error("Codex CLI providers must use the OpenAI Responses protocol");
    }
  } else if (provider.protocol !== "anthropic-messages") {
    throw new Error("Claude Code providers must use the Anthropic Messages protocol");
  }

  if (["READY", "ACTIVE", "DEGRADED"].includes(provider.lifecycle)) {
    normalizeModelRoles(provider.models);
    if (!provider.governance) {
      throw new Error("Ready or active third-party providers require governance confirmation");
    }
  }

  return provider;
}

export function providerSupportsAgent(
  provider: ProviderRevision,
  agent: AgentKind,
): boolean {
  return provider.agent === agent;
}

export function renderCodexProviderConfig(
  gatewayUrl: string,
  providerName = "deviludo_gateway",
): string {
  const gateway = validateInternalGatewayUrl(gatewayUrl);
  return [
    `model_provider = "${escapeToml(providerName)}"`,
    "",
    `[model_providers.${providerName}]`,
    'name = "DeviLudo Inference Gateway"',
    `base_url = "${escapeToml(gateway)}"`,
    'env_key = "DEVILUDO_RUN_TOKEN"',
    'wire_api = "responses"',
  ].join("\n");
}

export function validateInternalGatewayUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error("Inference gateway URL must be a credential-free HTTPS URL");
  }
  return url.toString().replace(/\/$/, "");
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
