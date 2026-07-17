export const activeProject = {
  id: "ember-archipelago",
  name: "余烬群岛",
  genre: "航海 · 生存建造 · 单机",
  branch: "dev/spec-07",
  specRevision: "SPEC-007",
  progress: 68,
  agent: "Claude Code",
  agentVersion: "2.1.14",
  model: "claude-sonnet-4-6-20250514",
  currentStage: "三平台 E2E",
  commit: "8b7e4a2",
  updatedAt: "3 分钟前",
  platforms: [
    { id: "linux", label: "Linux", status: "passed", detail: "42 / 42" },
    { id: "windows", label: "Windows", status: "running", detail: "31 / 42" },
    { id: "macos", label: "macOS", status: "queued", detail: "等待节点" },
  ],
} as const;

export const pipelineStages = [
  { label: "规格批准", state: "complete", meta: "SPEC-007" },
  { label: "Agent 开发", state: "complete", meta: "PR #18" },
  { label: "安全扫描", state: "complete", meta: "0 高危" },
  { label: "跨平台 E2E", state: "active", meta: "2 / 3" },
  { label: "用户验收", state: "pending", meta: "等待" },
  { label: "Steam Beta", state: "pending", meta: "门禁" },
] as const;

export const recentActivity = [
  { id: "RUN-1042", title: "修复海战结算后存档丢失", kind: "自动修复", status: "运行中", tone: "blue", time: "03:42", agent: "Claude Code" },
  { id: "E2E-822", title: "Linux RC 核心循环", kind: "E2E", status: "通过", tone: "green", time: "08:17", agent: "runner-lnx-04" },
  { id: "SPEC-007", title: "收紧新手期资源节奏", kind: "规格", status: "已批准", tone: "ink", time: "昨天", agent: "王天扬" },
  { id: "RUN-1036", title: "港口 UI 键盘导航", kind: "开发", status: "通过", tone: "green", time: "昨天", agent: "Codex CLI" },
] as const;

export const runnerFleet = [
  { os: "Windows", count: 3, online: 2, detail: "DirectX 12 · Godot 4.5.1", load: 72 },
  { os: "Linux", count: 4, online: 4, detail: "Vulkan · Godot 4.5.1", load: 44 },
  { os: "macOS", count: 2, online: 2, detail: "Apple Silicon · Godot 4.5.1", load: 18 },
] as const;

export const evidenceBundles = [
  { id: "EV-007-LNX", platform: "Linux", commit: "8b7e4a2", tests: "42 / 42", signed: true, createdAt: "今天 10:42" },
  { id: "EV-006-WIN", platform: "Windows", commit: "f1a4c8d", tests: "42 / 42", signed: true, createdAt: "昨天 18:11" },
  { id: "EV-006-MAC", platform: "macOS", commit: "f1a4c8d", tests: "40 / 42", signed: false, createdAt: "昨天 18:02" },
] as const;
