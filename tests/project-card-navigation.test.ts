import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the entire project card is a native keyboard-accessible project link", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../components/ProductDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/product.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /<Link\s+aria-label=\{text\(`打开\$\{project\.name\}项目`[\s\S]*?className="project-catalog-card"[\s\S]*?href=\{`\/projects\/\$\{project\.id\}`\}/);
  assert.doesNotMatch(component, /<article className="project-catalog-card"/);
  assert.match(component, /project-catalog-card-footer"><span>\{text\("进入项目", "OPEN PROJECT"\)\}/);
  assert.match(styles, /\.project-catalog-card\s*\{[\s\S]*?cursor:\s*pointer/);
  assert.match(styles, /\.project-catalog-card:focus-visible\s*\{[\s\S]*?outline:/);
});
