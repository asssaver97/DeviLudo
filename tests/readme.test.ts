import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the English and Chinese READMEs switch through rendered directory pages", async () => {
  const [english, chinese] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/zh-CN/README.md", import.meta.url), "utf8"),
  ]);

  assert.match(english, /<strong>English<\/strong>[\s\S]*href="\.\/docs\/zh-CN\/#readme">简体中文<\/a>/);
  assert.match(chinese, /href="\.\.\/\.\.\/#readme">English<\/a>[\s\S]*<strong>简体中文<\/strong>/);
  assert.doesNotMatch(`${english}\n${chinese}`, /<details|<summary|href="[^"]*README[^"#]*\.md/iu);
  assert.match(english, /## Adaptive real-operation E2E/);
  assert.match(chinese, /## 自适应真实操作 E2E/);
});
