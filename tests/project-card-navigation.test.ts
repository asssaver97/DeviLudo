import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ready project cards are links while project analysis cards are disabled and animated", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../components/ProductDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/product.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /<Link\s+aria-label=\{text\(`打开\$\{project\.name\}项目`[\s\S]*?className="project-catalog-card"[\s\S]*?href=\{`\/projects\/\$\{project\.id\}`\}/);
  assert.match(component, /className=\{`project-catalog-card is-disabled \$\{analyzing \? "is-analyzing"/);
  assert.match(component, /className="project-analysis-spinner"/);
  assert.match(component, /router\.push\("\/projects"\)/);
  assert.match(styles, /\.project-catalog-card\s*\{[\s\S]*?cursor:\s*pointer/);
  assert.match(styles, /\.project-catalog-card:focus-visible\s*\{[\s\S]*?outline:/);
  assert.match(styles, /@keyframes project-analysis-spin/);
});
