import { builtInAdapterVersion } from "../agent/adapter-registry";
import { AGENT_REGISTRY } from "../agent/registry";

export type AgentKind = "claude-code" | "codex-cli";

export type AgentCatalogItem = {
  id: AgentKind;
  name: string;
  vendor: string;
  description: string;
  officialSource: string;
  adapterId: string;
  adapterVersion: string;
  providerProtocol: "anthropic-messages" | "openai-responses";
  configurationSchemaId: string;
  capabilities: readonly string[];
  supportedWorkers: readonly string[];
};

export type AgentVersionRow = {
  id: string;
  agent: AgentKind;
  version: string;
  discoveredAt: string;
  sourceUrl: string;
  releaseNotesUrl: string;
  integrity: string;
  sbom: string;
  vulnerabilities: string;
  status: "APPROVED" | "DISCOVERED" | "VALIDATING" | "DEPRECATED" | "BLOCKED" | "REJECTED";
};

export function trustedAgentVersionUrl(
  agent: AgentKind,
  version: string,
  kind: "source" | "release-notes",
  value: string,
): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || /latest|stable|default/i.test(version)) {
    throw new Error("Agent 版本来源必须绑定精确版本");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Agent 版本来源 URL 无效"); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("Agent 版本来源 URL 无效");
  }
  const path = url.pathname.replace(/\/$/, "");
  let allowed = false;
  if (kind === "release-notes") {
    const prefix = agent === "claude-code" ? "/anthropics/claude-code/releases" : "/openai/codex/releases";
    allowed = url.hostname === "github.com" && (path === prefix || path.startsWith(`${prefix}/`));
  } else if (agent === "claude-code") {
    allowed = url.hostname === "code.claude.com" && path === "/docs/en/installation"
      || url.hostname === "registry.npmjs.org"
        && path === `/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`;
  } else {
    allowed = url.hostname === "github.com" && path === "/openai/codex"
      || url.hostname === "registry.npmjs.org"
        && path === `/@openai/codex/-/codex-${version}.tgz`;
  }
  if (!allowed) throw new Error("Agent 版本来源 URL 不在官方允许列表");
  return url.toString();
}

export type AuditEvent = {
  id: string;
  at: string;
  actor: string;
  role: string;
  action: string;
  target: string;
  detail: string;
  tone: "success" | "neutral" | "warning";
};

/**
 * UI metadata for the two signed built-in adapters. Runtime versions,
 * installations, supply-chain evidence and defaults always come from the
 * authenticated Agent control-plane projection.
 */
export const builtInAgentUi = Object.freeze([
  Object.freeze({
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    description: "长程编码、工具编排与仓库级任务",
    officialSource: "https://code.claude.com/docs/en/installation",
    adapterId: AGENT_REGISTRY["claude-code"].adapterId,
    adapterVersion: builtInAdapterVersion("claude-code"),
    providerProtocol: AGENT_REGISTRY["claude-code"].providerProtocol,
    configurationSchemaId: AGENT_REGISTRY["claude-code"].configurationSchema.schemaId,
    capabilities: Object.freeze(["规划", "代码修改", "评审", "流式事件"]),
    supportedWorkers: Object.freeze(["linux/amd64", "linux/arm64"]),
  }),
  Object.freeze({
    id: "codex-cli",
    name: "Codex CLI",
    vendor: "OpenAI",
    description: "结构化执行、沙箱编码与机器可读事件",
    officialSource: "https://github.com/openai/codex",
    adapterId: AGENT_REGISTRY["codex-cli"].adapterId,
    adapterVersion: builtInAdapterVersion("codex-cli"),
    providerProtocol: AGENT_REGISTRY["codex-cli"].providerProtocol,
    configurationSchemaId: AGENT_REGISTRY["codex-cli"].configurationSchema.schemaId,
    capabilities: Object.freeze(["规划", "代码修改", "JSONL", "输出 Schema"]),
    supportedWorkers: Object.freeze(["linux/amd64", "linux/arm64"]),
  }),
] satisfies readonly Readonly<AgentCatalogItem>[]);

export const rolePermissions = {
  PlatformAgentAdmin: "版本、安装、回滚、全局默认",
  SecurityAdmin: "第三方端点、全局凭据、高风险发布",
  TenantAdmin: "租户 Provider、Profile 与 BYOK",
  ProjectOwner: "项目 Agent / Profile 选择",
  Auditor: "版本、配置、健康与审计只读",
} as const;

export type AdminRole = keyof typeof rolePermissions;
