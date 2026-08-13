import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialProjectDocument,
  normalizeAgentProjectDocumentContent,
  parseProjectDocumentContent,
  projectDocumentMarkdown,
} from "@/lib/product/project-document";

test("new projects receive a structured collaborative game document", () => {
  const content = createInitialProjectDocument("时间群岛", "一款时间循环解谜冒险游戏", {
    coreLoop: ["探索场景", "收集线索", "重置时间线"],
    acceptanceCriteria: ["可完成一轮循环"],
  });
  assert.equal(content.introduction, "一款时间循环解谜冒险游戏");
  assert.match(content.gameplay, /探索场景/);
  assert.deepEqual(content.categories, ["待 Agent 分类"]);
  assert.deepEqual(content.features, ["可完成一轮循环"]);
  const markdown = projectDocumentMarkdown("时间群岛", content);
  for (const heading of ["游戏介绍", "玩法", "游戏分类", "主要特性"]) assert.match(markdown, new RegExp(heading));
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
