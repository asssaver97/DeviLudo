import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local deployment exposes only Web while Core roles share one image", async () => {
  const compose = await readFile(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /x-core: &core[\s\S]*image: deviludo-core:local/);
  for (const service of ["core-api", "core-scheduler", "core-sandbox"]) {
    assert.match(compose, new RegExp(`\\n  ${service}:\\n    <<: \\*core`));
  }
  assert.match(compose, /web:[\s\S]*127\.0\.0\.1:3000:3000/);
  assert.match(compose, /core-api:[\s\S]*127\.0\.0\.1:8080:8080/);
  const webSection = compose.match(/\n  web:([\s\S]*?)\nnetworks:/)?.[1] ?? "";
  assert.doesNotMatch(webSection, /DATABASE_URL|VAULT|OBJECT_STORE|S3_/);
  assert.match(webSection, /- edge[\s\S]*- core/);
  assert.doesNotMatch(webSection, /- data/);
});
