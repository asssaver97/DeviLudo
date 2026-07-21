export type AgentKind = "claude-code" | "codex-cli";

export type AgentCatalogItem = {
  id: AgentKind;
  name: string;
  vendor: string;
  description: string;
  officialSource: string;
  adapterVersion: string;
  capabilities: readonly string[];
  supportedWorkers: readonly string[];
};

export type AgentVersionRow = {
  id: string;
  agent: AgentKind;
  version: string;
  releasedAt: string;
  integrity: string;
  sbom: string;
  vulnerabilities: string;
  status: "APPROVED" | "DISCOVERED" | "VALIDATING" | "DEPRECATED" | "BLOCKED" | "REJECTED";
};

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
    adapterVersion: "1.3.0",
    capabilities: Object.freeze(["规划", "代码修改", "评审", "流式事件"]),
    supportedWorkers: Object.freeze(["linux/amd64", "linux/arm64"]),
  }),
  Object.freeze({
    id: "codex-cli",
    name: "Codex CLI",
    vendor: "OpenAI",
    description: "结构化执行、沙箱编码与机器可读事件",
    officialSource: "https://github.com/openai/codex",
    adapterVersion: "1.2.2",
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
