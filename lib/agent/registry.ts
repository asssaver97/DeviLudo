import type { AgentKind } from "./types";

export interface AgentRegistryEntry {
  readonly agent: AgentKind;
  readonly displayName: string;
  readonly vendor: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly providerProtocol: "anthropic-messages" | "openai-responses";
  readonly configurationSchema: Readonly<{
    schemaId: string;
    requiredProviderFields: readonly ["baseUrl", "primaryModel", "credentialVersionId"];
    modelRoleFields: readonly ["primaryModel", "planningModel", "smallFastModel", "subagentModel"];
    floatingModelAliasesAllowed: false;
    additionalProperties: false;
  }>;
  readonly officialSource: string;
  readonly supportedWorkerPlatforms: readonly string[];
  readonly capabilities: readonly string[];
  readonly installedOn: readonly ["development-worker"];
  readonly forbiddenOn: readonly ["e2e-runner", "steam-publisher"];
  readonly selfUpdateAllowed: false;
}

export const DEFAULT_AGENT: AgentKind = "claude-code";
export const AGENT_REGISTRY_SCHEMA_VERSION = "deviludo.agent-registry.v1" as const;

const REQUIRED_PROVIDER_FIELDS = Object.freeze(["baseUrl", "primaryModel", "credentialVersionId"] as const);
const MODEL_ROLE_FIELDS = Object.freeze(["primaryModel", "planningModel", "smallFastModel", "subagentModel"] as const);
const DEVELOPMENT_WORKER = Object.freeze(["development-worker"] as const);
const FORBIDDEN_WORKERS = Object.freeze(["e2e-runner", "steam-publisher"] as const);

export const AGENT_REGISTRY: Readonly<Record<AgentKind, AgentRegistryEntry>> =
  Object.freeze({
    "claude-code": Object.freeze({
      agent: "claude-code",
      displayName: "Claude Code",
      vendor: "Anthropic",
      adapterId: "claude-code-v1",
      adapterVersion: "1.3.0",
      providerProtocol: "anthropic-messages",
      configurationSchema: Object.freeze({
        schemaId: "deviludo.agent-provider.claude-code.v1",
        requiredProviderFields: REQUIRED_PROVIDER_FIELDS,
        modelRoleFields: MODEL_ROLE_FIELDS,
        floatingModelAliasesAllowed: false,
        additionalProperties: false,
      }),
      officialSource: "https://code.claude.com/docs/en/installation",
      supportedWorkerPlatforms: Object.freeze(["linux/amd64", "linux/arm64"]),
      capabilities: Object.freeze([
        "planning",
        "code-editing",
        "tool-events",
        "budget-limit",
        "cancellation",
      ]),
      installedOn: DEVELOPMENT_WORKER,
      forbiddenOn: FORBIDDEN_WORKERS,
      selfUpdateAllowed: false,
    }),
    "codex-cli": Object.freeze({
      agent: "codex-cli",
      displayName: "Codex CLI",
      vendor: "OpenAI",
      adapterId: "codex-cli-v1",
      adapterVersion: "1.2.2",
      providerProtocol: "openai-responses",
      configurationSchema: Object.freeze({
        schemaId: "deviludo.agent-provider.codex-cli.v1",
        requiredProviderFields: REQUIRED_PROVIDER_FIELDS,
        modelRoleFields: MODEL_ROLE_FIELDS,
        floatingModelAliasesAllowed: false,
        additionalProperties: false,
      }),
      officialSource: "https://developers.openai.com/codex/cli",
      supportedWorkerPlatforms: Object.freeze(["linux/amd64", "linux/arm64"]),
      capabilities: Object.freeze([
        "planning",
        "code-editing",
        "structured-output",
        "tool-events",
        "cancellation",
      ]),
      installedOn: DEVELOPMENT_WORKER,
      forbiddenOn: FORBIDDEN_WORKERS,
      selfUpdateAllowed: false,
    }),
  });

export function agentRegistryEntry(agent: AgentKind): AgentRegistryEntry {
  return AGENT_REGISTRY[agent];
}
