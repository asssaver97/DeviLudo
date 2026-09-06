import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexModelOptions, readCodexModelOptions } from "@/services/core/src/codex-models";

test("Codex picker exposes visible models in runtime priority order without private catalogue fields", () => {
  const models = codexModelOptions({
    models: [
      { slug: "hidden", priority: 0, visibility: "hide" },
      { slug: "secondary", display_name: " Secondary model ", priority: 3 },
      { slug: "primary", display_name: "Primary model", priority: 1, base_instructions: "private instructions", supported_reasoning_levels: [] },
      { slug: "primary", display_name: "Duplicate", priority: 2 },
      { slug: "fallback-name", display_name: " ", priority: 4 },
      { slug: "account-default", priority: 0 },
      { slug: "bad id", priority: 0 },
      { slug: "bad-priority", priority: -1 },
      { slug: "missing-priority" },
      null,
    ],
    credentials: "must not be forwarded",
  });
  assert.deepEqual(models, [
    { id: "primary", displayName: "Primary model" },
    { id: "secondary", displayName: "Secondary model" },
    { id: "fallback-name", displayName: "fallback-name" },
  ]);
  for (const malformed of [null, [], "catalogue", {}, { models: {} }]) {
    assert.deepEqual(codexModelOptions(malformed), []);
  }
});

test("Codex model detection tolerates missing, invalid, and oversized runtime catalogues", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "models_cache.json");
  assert.deepEqual(await readCodexModelOptions(path), []);
  assert.deepEqual(await readCodexModelOptions(directory), []);
  await writeFile(path, "{ incomplete JSON");
  assert.deepEqual(await readCodexModelOptions(path), []);
  await writeFile(path, JSON.stringify({ models: [{ slug: "gpt-model", priority: 1 }] }));
  assert.deepEqual(await readCodexModelOptions(path), [{ id: "gpt-model", displayName: "gpt-model" }]);
  await truncate(path, 8 * 1024 * 1024 + 1);
  assert.deepEqual(await readCodexModelOptions(path), []);
});
