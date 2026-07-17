import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("local integration PostgreSQL applies every migration in order", () => {
  const compose = readFileSync(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  const offsets = Array.from({ length: 8 }, (_, index) => {
    const prefix = String(index + 1).padStart(3, "0");
    const marker = `./postgres/${prefix}_`;
    const offset = compose.indexOf(marker);
    assert.notEqual(offset, -1, `missing PostgreSQL migration ${prefix}`);
    return offset;
  });
  assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
});

test("control-plane wait persistence uses the shared tenant RLS setting", () => {
  const adapter = readFileSync(new URL("../services/control-plane/src/workflow-action-postgres.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../infra/postgres/008_workflow_control_actions.sql", import.meta.url), "utf8");
  assert.match(adapter, /set_config\('app\.tenant_id'/);
  assert.doesNotMatch(adapter, /app\.current_tenant/);
  assert.match(migration, /deviludo\.current_tenant_id\(\)/);
  assert.doesNotMatch(migration, /app\.current_tenant/);
});
