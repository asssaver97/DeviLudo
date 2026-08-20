import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialProjectDocument,
  normalizeAgentProjectDocumentContent,
  parseProjectDocumentContent,
  projectDocumentMarkdown,
  synchronizeSpecificationWithProjectDocument,
} from "@/lib/product/project-document";

test("new projects receive a structured collaborative game document", () => {
  const content = createInitialProjectDocument("时间群岛", "一款时间循环解谜冒险游戏", {
    coreLoop: ["探索场景", "收集线索", "重置时间线"],
    acceptanceCriteria: ["可完成一轮循环"],
  }, "zh");
  assert.equal(content.introduction, "一款时间循环解谜冒险游戏");
  assert.match(content.gameplay, /探索场景/);
  assert.deepEqual(content.categories, ["待 Agent 分类"]);
  assert.deepEqual(content.features, ["可完成一轮循环"]);
  const markdown = projectDocumentMarkdown("时间群岛", content, "zh");
  for (const heading of ["游戏介绍", "玩法", "游戏分类", "主要特性"]) assert.match(markdown, new RegExp(heading));
});

test("project documents default to English when no UI language is supplied", () => {
  const content = createInitialProjectDocument("Untitled", "A new game", {});
  assert.deepEqual(content.categories, ["Pending Agent classification"]);
  const markdown = projectDocumentMarkdown("Untitled", content);
  for (const heading of ["Game overview", "Gameplay", "Categories", "Key features"]) {
    assert.match(markdown, new RegExp(heading));
  }
});

test("project documents fail closed when required collaboration fields are missing", () => {
  assert.throws(() => parseProjectDocumentContent({
    introduction: "游戏介绍",
    gameplay: "核心玩法",
    categories: [],
    features: ["特性"],
  }), /游戏分类/);
  assert.throws(() => parseProjectDocumentContent({
    introduction: "游戏介绍",
    gameplay: "",
    categories: ["冒险"],
    features: ["特性"],
  }), /玩法/);
});

test("verbose Agent document items are split to the strict storage contract", () => {
  const verboseFeature = `字体与真实输入验收：${"中文可读并通过 H 键切换提示。".repeat(30)}`;
  const content = normalizeAgentProjectDocumentContent({
    introduction: "游戏介绍",
    gameplay: "核心玩法",
    categories: ["策略"],
    features: [verboseFeature],
  });
  assert.ok(content.features.length > 1);
  assert.ok(content.features.every(feature => feature.length <= 300));
  assert.equal(content.features.join(""), verboseFeature);
  assert.deepEqual(parseProjectDocumentContent(content), content);
});

test("development approval freezes the current project document into E2E requirements", () => {
  const synchronized = synchronizeSpecificationWithProjectDocument({
    title: "旧分析标题",
    coreLoop: ["旧的测试夹具按钮"],
    acceptanceCriteria: ["旧的冒烟检查"],
    revisionNotes: ["保留用户需求历史"],
  }, {
    introduction: "一款可发布的航行游戏",
    gameplay: "从互斥主菜单开始新游戏。驾驶飞船收集三个目标；跨越终点后结算胜利。",
    categories: ["冒险"],
    features: ["菜单不得显示活动游戏内容", "真实输入可以完成核心循环"],
  });
  assert.equal(synchronized.vision, "一款可发布的航行游戏");
  assert.deepEqual(synchronized.coreLoop, ["从互斥主菜单开始新游戏", "驾驶飞船收集三个目标", "跨越终点后结算胜利"]);
  assert.deepEqual(synchronized.acceptanceCriteria, ["菜单不得显示活动游戏内容", "真实输入可以完成核心循环"]);
  assert.deepEqual(synchronized.revisionNotes, ["保留用户需求历史"]);
  assert.equal(synchronized.title, "旧分析标题");
});
