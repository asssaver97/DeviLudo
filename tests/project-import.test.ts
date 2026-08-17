import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createStoredZip } from "@/lib/product/source-archive";
import {
  analyzeImportedProject,
  createTarGzip,
  inspectProjectFiles,
  inspectProjectZip,
  normalizeGitBranchName,
  normalizeGitHubRepositoryUrl,
} from "@/services/core/src/project-import";
import type { StoredInstanceAgentSettings } from "@/services/core/src/repository";

const encoder = new TextEncoder();
const sourceZip = createStoredZip([
  { path: "clock-game/project.godot", bytes: encoder.encode("[application]\nrun/main_scene=\"res://main.tscn\"") },
  { path: "clock-game/README.md", bytes: encoder.encode("# Clock Game\nA time-loop puzzle adventure.") },
  { path: "clock-game/scripts/main.gd", bytes: encoder.encode("extends Node\nfunc reset_timeline(): pass") },
]);

const settings: StoredInstanceAgentSettings = Object.freeze({
  agentRuntime: "CLAUDE_CODE",
  baseUrl: "https://gateway.example.com/anthropic/v1",
  model: null,
  models: Object.freeze({
    primary: "claude-primary",
    opus: "claude-opus",
    sonnet: "claude-sonnet",
    haiku: "claude-haiku",
    subagent: "claude-subagent",
  }),
  roleModels: Object.freeze({ design: "claude-sonnet", development: "claude-primary", test: "claude-haiku" }),
  credentialSecretRef: "vault://instance/agent-runtime/api-key/versions/30000000-0000-4000-8000-000000000099",
  apiKeyMask: "sk-********alue",
  apiKeyFingerprint: "sha256:0123456789ab",
  credentialVersion: "30000000-0000-4000-8000-000000000099",
  testPolicyReady: false,
  testPolicyCheckedRevision: null,
  revision: 7,
  updatedBy: "tester",
  updatedAt: new Date(0).toISOString(),
});

test("local project ZIP is normalized into an immutable source snapshot", () => {
  const snapshot = inspectProjectZip({
    bytes: sourceZip,
    sourceKind: "LOCAL_ARCHIVE",
    displayName: "Clock Game",
  });
  assert.equal(snapshot.fileCount, 3);
  assert.equal(snapshot.displayName, "Clock Game");
  assert.match(snapshot.context, /time-loop puzzle adventure/);
  const tar = gunzipSync(createTarGzip(snapshot.files));
  assert.match(tar.toString("utf8"), /project\.godot/);
  assert.match(tar.toString("utf8"), /reset_timeline/);
});

test("GitHub repository URLs preserve the local Git transport but persist no credentials", () => {
  assert.deepEqual(normalizeGitHubRepositoryUrl("https://github.com/example/clock-game.git"), {
    cloneUrl: "https://github.com/example/clock-game.git",
    canonicalUrl: "https://github.com/example/clock-game",
    displayName: "clock-game",
  });
  assert.deepEqual(normalizeGitHubRepositoryUrl("git@github.com:example/private-game.git"), {
    cloneUrl: "git@github.com:example/private-game.git",
    canonicalUrl: "https://github.com/example/private-game",
    displayName: "private-game",
  });
  assert.throws(() => normalizeGitHubRepositoryUrl("https://token@github.com/example/game"), /只支持/);
  assert.throws(() => normalizeGitHubRepositoryUrl("https://gitlab.com/example/game"), /只支持/);
  assert.throws(() => normalizeGitHubRepositoryUrl("https://github.com/example/game/tree/main"), /仓库根目录/);
});

test("project-page Git branch names are normalized and reject unsafe refs before host Git is called", () => {
  assert.equal(normalizeGitBranchName("  codex/import-workflow  "), "codex/import-workflow");
  assert.equal(normalizeGitBranchName(""), null);
  for (const branch of ["-danger", "feature..two", "feature lock", "topic.lock", "a@{b", "a\\b"]) {
    assert.throws(() => normalizeGitBranchName(branch), /分支名称无效/);
  }
});

test("a bound local directory snapshot keeps its binding and current Git branch", () => {
  const snapshot = inspectProjectFiles({
    files: [
      { path: "project.godot", bytes: Buffer.from("[application]") },
      { path: "README.md", bytes: Buffer.from("# Clock Game") },
    ],
    sourceKind: "LOCAL_DIRECTORY",
    localDirectoryBindingId: "10000000-0000-4000-8000-000000000001",
    gitBranch: "codex/local-edit",
    displayName: "Clock Game",
  });
  assert.equal(snapshot.localDirectoryBindingId, "10000000-0000-4000-8000-000000000001");
  assert.equal(snapshot.gitBranch, "codex/local-edit");
});

test("a bound directory larger than the former 64 MiB browser limit remains valid", () => {
  const largeAsset = Buffer.alloc(64 * 1024 * 1024 + 1);
  const snapshot = inspectProjectFiles({
    files: [
      { path: "project.godot", bytes: Buffer.from("[application]") },
      { path: "assets/world.bin", bytes: largeAsset },
    ],
    sourceKind: "LOCAL_DIRECTORY",
    localDirectoryBindingId: "10000000-0000-4000-8000-000000000001",
    displayName: "Large Game",
  });
  assert.equal(snapshot.totalBytes, largeAsset.length + Buffer.byteLength("[application]"));
  assert.equal(snapshot.fileCount, 2);
});

test("project analysis context keeps late startup logic from large entry scripts", () => {
  const snapshot = inspectProjectFiles({
    files: [
      { path: "project.godot", bytes: Buffer.from('[application]\nrun/main_scene="res://scenes/main.tscn"') },
      { path: "scenes/main.tscn", bytes: Buffer.from('[ext_resource path="res://scripts/main.gd" type="Script" id="1"]') },
      {
        path: "scripts/main.gd",
        bytes: Buffer.from(`${"# ordinary implementation\n".repeat(2_000)}func _ready():\n  state.setup(19870531, 3)\n  rules.start_turn()\n`),
      },
    ],
    sourceKind: "LOCAL_DIRECTORY",
    localDirectoryBindingId: "10000000-0000-4000-8000-000000000001",
    displayName: "Midgame Startup",
  });
  assert.match(snapshot.context, /run\/main_scene="res:\/\/scenes\/main\.tscn"/);
  assert.match(snapshot.context, /state\.setup\(19870531, 3\)/);
  assert.match(snapshot.context, /rules\.start_turn\(\)/);
});

test("project import rejects credentials even when the archive is otherwise valid", () => {
  const archive = createStoredZip([
    { path: "game/project.godot", bytes: encoder.encode("[application]") },
    { path: "game/.env", bytes: encoder.encode("API_KEY=secret") },
  ]);
  assert.throws(() => inspectProjectZip({
    bytes: archive,
    sourceKind: "LOCAL_ARCHIVE",
    displayName: "game",
  }), /不允许读取的凭据文件/);
});

test("import analysis creates the collaborative document and development specification", async () => {
  const source = inspectProjectZip({ bytes: sourceZip, sourceKind: "LOCAL_ARCHIVE", displayName: "Clock Game" });
  const analysis = await analyzeImportedProject({
    source,
    settings,
    apiKey: "sk-test-secret",
    fetchImpl: (async (_input, init) => {
      assert.match(String(init?.body), /reset_timeline/);
      return Response.json({ content: [{ type: "text", text: JSON.stringify({
        name: "时序回廊",
        introduction: "一款围绕时间循环展开的像素解谜游戏。",
        gameplay: "探索场景、记录线索并重置时间线来改变事件结果。",
        categories: ["解谜", "冒险"],
        features: ["时间循环", "状态持久化"],
        coreLoop: ["探索", "推理", "重置"],
        playerExperience: "在重复中逐步掌握因果关系。",
        acceptanceCriteria: ["可以完成一次时间循环"],
        gameContent: "玩家探索时间回廊，通过循环改变事件结果。",
        currentDevelopmentState: "核心循环原型已存在，完整关卡尚未完成。",
        completedWork: ["基础探索", "时间重置"],
        remainingWork: ["完整关卡流程"],
        startupFlow: "项目主场景直接进入回廊关卡。",
        startupIssues: ["缺少主菜单，启动后直接进入进行中的关卡状态。"],
        risks: ["状态持久化仍需验证"],
        recommendedPlan: ["补齐主菜单与新游戏入口", "完成首个关卡", "增加真实操作验收"],
        questions: ["启动后应显示主菜单，还是自动继续最近存档？"],
      }) }] });
    }) as typeof fetch,
  });
  assert.equal(analysis.name, "时序回廊");
  assert.deepEqual(analysis.document.categories, ["解谜", "冒险"]);
  assert.deepEqual(analysis.specification.coreLoop, ["探索", "推理", "重置"]);
  assert.match(analysis.assistantContent, /启动后直接进入进行中的关卡状态/);
  assert.deepEqual(analysis.discovery.questions, ["启动后应显示主菜单，还是自动继续最近存档？"]);
  assert.equal(analysis.settingsRevision, 7);
});

test("import analysis retries a transient Provider connection failure", async () => {
  const source = inspectProjectZip({ bytes: sourceZip, sourceKind: "LOCAL_ARCHIVE", displayName: "Clock Game" });
  let attempts = 0;
  const analysis = await analyzeImportedProject({
    source,
    settings,
    apiKey: "sk-test-secret",
    fetchImpl: (async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return Response.json({ content: [{ type: "text", text: JSON.stringify({
        name: "时序回廊",
        introduction: "一款围绕时间循环展开的像素解谜游戏。",
        gameplay: "探索场景、记录线索并重置时间线。",
        categories: ["解谜"],
        features: ["时间循环"],
        coreLoop: ["探索", "重置"],
        playerExperience: "在重复中掌握因果关系。",
        acceptanceCriteria: ["能够完成一次时间循环"],
        gameContent: "时间循环解谜。",
        currentDevelopmentState: "可玩的核心原型。",
        completedWork: ["循环重置"],
        remainingWork: ["更多谜题"],
        startupFlow: "标题页进入关卡。",
        startupIssues: [],
        risks: [],
        recommendedPlan: ["增加谜题并回归核心循环"],
        questions: [],
      }) }] });
    }) as typeof fetch,
  });
  assert.equal(attempts, 2);
  assert.equal(analysis.name, "时序回廊");
});

test("import analysis recovers JSON wrapped in prose with literal newlines and trailing commas", async () => {
  const source = inspectProjectZip({ bytes: sourceZip, sourceKind: "LOCAL_ARCHIVE", displayName: "Clock Game" });
  const raw = [
    "分析完成，结果如下：",
    "```json",
    "{",
    '  "name": "商业帝国",',
    '  "introduction": "从小店开始经营',
    '并逐步建立商业帝国。",',
    '  "gameplay": "采购、定价并扩张门店。",',
    '  "categories": ["模拟", "经营",],',
    '  "features": ["动态市场", "员工管理",],',
    '  "coreLoop": ["采购", "销售", "扩张",],',
    '  "playerExperience": "持续优化经营策略。",',
    '  "acceptanceCriteria": ["能够完成一次经营周期",],',
    '  "gameContent": "经营并扩张商业版图。",',
    '  "currentDevelopmentState": "经营核心原型已经存在。",',
    '  "completedWork": ["采购与销售",],',
    '  "remainingWork": ["完整新手流程",],',
    '  "startupFlow": "标题页进入新游戏。",',
    '  "startupIssues": [],',
    '  "risks": ["经济平衡尚未验证",],',
    '  "recommendedPlan": ["补齐新手流程", "验证经济平衡",],',
    '  "questions": [],',
    "}",
    "```",
    "可以继续开始开发。",
  ].join("\n");
  const analysis = await analyzeImportedProject({
    source,
    settings,
    apiKey: "sk-test-secret",
    fetchImpl: (async () => Response.json({ content: [{ type: "text", text: raw }] })) as typeof fetch,
  });
  assert.equal(analysis.name, "商业帝国");
  assert.match(analysis.document.introduction, /建立商业帝国/);
  assert.deepEqual(analysis.document.categories, ["模拟", "经营"]);
  assert.deepEqual(analysis.specification.coreLoop, ["采购", "销售", "扩张"]);
});
