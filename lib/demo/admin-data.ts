export type AgentKind = "claude-code" | "codex-cli";

export type AgentCatalogItem = {
  id: AgentKind;
  name: string;
  vendor: string;
  description: string;
  source: string;
  version: string;
  adapterVersion: string;
  capabilities: string[];
  platforms: string[];
  default?: boolean;
  color: "coral" | "mint";
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

export const agents: AgentCatalogItem[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    description: "长程编码、工具编排与仓库级任务",
    source: "github.com/anthropics/claude-code",
    version: "2.1.14",
    adapterVersion: "adapter-claude@1.3.0",
    capabilities: ["规划", "代码修改", "评审", "流式事件"],
    platforms: ["linux/amd64", "linux/arm64"],
    default: true,
    color: "coral",
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    vendor: "OpenAI",
    description: "结构化执行、沙箱编码与机器可读事件",
    source: "github.com/openai/codex",
    version: "0.91.0",
    adapterVersion: "adapter-codex@1.2.2",
    capabilities: ["规划", "代码修改", "JSONL", "输出 Schema"],
    platforms: ["linux/amd64", "linux/arm64"],
    color: "mint",
  },
];

export const versionRows: AgentVersionRow[] = [
  {
    id: "av_claude_2114",
    agent: "claude-code",
    version: "2.1.14",
    releasedAt: "今天 08:42",
    integrity: "sigstore · sha256:9bd…a82",
    sbom: "SPDX · 326 组件",
    vulnerabilities: "0 严重 · 0 高危",
    status: "APPROVED",
  },
  {
    id: "av_claude_2115",
    agent: "claude-code",
    version: "2.1.15",
    releasedAt: "今天 11:06",
    integrity: "签名待验证",
    sbom: "生成中",
    vulnerabilities: "扫描排队中",
    status: "DISCOVERED",
  },
  {
    id: "av_codex_091",
    agent: "codex-cli",
    version: "0.91.0",
    releasedAt: "昨天 18:20",
    integrity: "npm · sha512-f31…d90",
    sbom: "CycloneDX · 411 组件",
    vulnerabilities: "0 严重 · 0 高危",
    status: "APPROVED",
  },
  {
    id: "av_codex_092",
    agent: "codex-cli",
    version: "0.92.0",
    releasedAt: "今天 09:14",
    integrity: "npm · sha512-261…3bf",
    sbom: "CycloneDX · 414 组件",
    vulnerabilities: "1 高危 · 依赖项审查",
    status: "BLOCKED",
  },
];

export const auditEvents: AuditEvent[] = [
  {
    id: "audit_1",
    at: "12:31:04",
    actor: "Lin Qiao",
    role: "PlatformAgentAdmin",
    action: "推进灰度",
    target: "claude-code / dev-linux-a",
    detail: "canary 5% → 25%，变更单 CHG-1842",
    tone: "success",
  },
  {
    id: "audit_2",
    at: "11:58:27",
    actor: "Wang Tianyang",
    role: "SecurityAdmin",
    action: "批准 Provider",
    target: "Anthropic · cn-gateway",
    detail: "探针 8/8 通过；数据地域：新加坡",
    tone: "success",
  },
  {
    id: "audit_3",
    at: "11:16:02",
    actor: "system/version-watcher",
    role: "ServiceAccount",
    action: "阻止版本",
    target: "codex-cli@0.116.0",
    detail: "依赖扫描发现 1 个高危漏洞",
    tone: "warning",
  },
  {
    id: "audit_4",
    at: "10:42:46",
    actor: "Chen Mo",
    role: "TenantAdmin",
    action: "轮换凭据",
    target: "Studio North / Claude BYOK",
    detail: "凭据 v7 → v8；旧版本已停止签发",
    tone: "neutral",
  },
];

export const rolePermissions = {
  PlatformAgentAdmin: "版本、安装、回滚、全局默认",
  SecurityAdmin: "第三方端点、全局凭据、高风险发布",
  TenantAdmin: "租户 Provider、Profile 与 BYOK",
  ProjectOwner: "项目 Agent / Profile 选择",
  Auditor: "版本、配置、健康与审计只读",
} as const;

export type AdminRole = keyof typeof rolePermissions;
