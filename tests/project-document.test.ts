import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialProjectDocument,
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
