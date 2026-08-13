import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the English and Chinese READMEs switch directly between root files", async () => {
  const [english, chinese] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8"),
  ]);

  assert.match(english, /<strong>English<\/strong>[\s\S]*href="\.\/README\.zh-CN\.md">简体中文<\/a>/);
  assert.match(chinese, /href="\.\/README\.md">English<\/a>[\s\S]*<strong>简体中文<\/strong>/);
  assert.doesNotMatch(`${english}\n${chinese}`, /<details|<summary|docs\/zh-CN/iu);
  assert.match(english, /## Adaptive real-operation E2E/);
  assert.match(chinese, /## 自适应真实操作 E2E/);
  assert.match(english, /### Local deployment requirements[\s\S]*Node\.js `>=22\.13`[\s\S]*140 GiB[\s\S]*roughly 25 GB/);
  assert.match(chinese, /### 本地部署环境要求[\s\S]*Node\.js `>=22\.13`[\s\S]*140 GiB[\s\S]*约 25 GB/);
});
