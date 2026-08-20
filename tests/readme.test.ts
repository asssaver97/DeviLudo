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
  assert.match(english, /### E2E results/);
  assert.match(chinese, /### E2E 结果/);
  assert.match(english, /### Requirements[\s\S]*Node\.js `>=22\.13`[\s\S]*140 GiB[\s\S]*roughly 25 GB/);
  assert.match(chinese, /### 环境要求[\s\S]*Node\.js `>=22\.13`[\s\S]*140 GiB[\s\S]*约 25 GB/);
  assert.match(english, /## Anonymous usage reporting[\s\S]*automatically reports[\s\S]*https:\/\/telemetry\.deviludo\.com\/v1\/active-installations[\s\S]*No setup is required/);
  assert.match(chinese, /## 匿名使用统计[\s\S]*自动向 `https:\/\/telemetry\.deviludo\.com\/v1\/active-installations` 上报[\s\S]*无需用户配置/);
  assert.match(english, /## License[\s\S]*may not provide DeviLudo to third parties as a hosted or managed service/);
  assert.match(chinese, /## 许可[\s\S]*不得将 DeviLudo 作为托管或管理服务提供给第三方/);
});
