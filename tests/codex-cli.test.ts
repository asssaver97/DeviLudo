import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCodexModelsCache, resolveCodexRunRoot } from "../services/core/src/codex-cli";

test("isolated Codex runs use a private non-temporary root", () => {
  assert.equal(resolveCodexRunRoot("/var/lib/deviludo-codex", "/tmp"), "/var/lib/deviludo-codex");
  assert.throws(
    () => resolveCodexRunRoot("/tmp/deviludo-codex", "/tmp"),
    /cannot be inside the system temporary directory/,
  );
  assert.throws(() => resolveCodexRunRoot("relative/codex", "/tmp"), /must be absolute/);
});

test("isolated Codex runs inherit only a cache matching the bundled CLI", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "deviludo-codex-cache-test-"));
  const home = join(fixture, "home");
  const source = join(fixture, "models_cache.json");
  try {
    await writeFile(source, JSON.stringify({
      client_version: "0.149.0",
      fetched_at: "2026-08-21T00:00:00Z",
      etag: "fixture",
      models: [{ slug: "gpt-5.6-sol", priority: 1, visibility: "list" }],
    }));
    await mkdir(home);
    assert.equal(await installCodexModelsCache(home, source, "0.149.0"), true);
    const installed = JSON.parse(await readFile(join(home, "models_cache.json"), "utf8"));
    assert.equal(installed.client_version, "0.149.0");
    assert.equal(installed.models[0].slug, "gpt-5.6-sol");
    const catalog = JSON.parse(await readFile(join(home, "model-catalog.json"), "utf8"));
    assert.equal(catalog.models[0].slug, "gpt-5.6-sol");
    assert.equal(catalog.models[0].supports_parallel_tool_calls, false);
    await assert.rejects(
      installCodexModelsCache(home, source, "0.147.0"),
      /does not match the bundled CLI version/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
