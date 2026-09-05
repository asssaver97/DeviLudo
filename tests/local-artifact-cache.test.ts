import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { synchronizeLocalArtifactCache } from "../scripts/local-artifact-cache.mjs";

const PROJECT_A = "10000000-0000-4000-8000-000000000001";
const PROJECT_B = "10000000-0000-4000-8000-000000000002";
const CURRENT = "20000000-0000-4000-8000-000000000001";
const OLD = "20000000-0000-4000-8000-000000000002";
const LEGACY = "20000000-0000-4000-8000-000000000003";
const OTHER = "20000000-0000-4000-8000-000000000004";
const STAGING = ".staging-20000000-0000-4000-8000-000000000005-30000000-0000-4000-8000-000000000001";

test("local artifact cache retains only the current artifacts for a project", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-artifact-cache-"));
  try {
    await Promise.all([
      cachedArtifact(root, CURRENT, {}),
      cachedArtifact(root, OLD, { projectId: PROJECT_A }),
      cachedArtifact(root, LEGACY, {}),
      cachedArtifact(root, OTHER, { projectId: PROJECT_B }),
      mkdir(join(root, STAGING)),
    ]);

    const first = await synchronizeLocalArtifactCache(root, PROJECT_A, [CURRENT]);
    assert.deepEqual(first, { removed: 3, retained: 1 });
    assert.equal(JSON.parse(await readFile(join(root, CURRENT, "artifact.json"), "utf8")).projectId, PROJECT_A);
    await assert.rejects(readFile(join(root, OLD, "artifact.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, LEGACY, "artifact.json")), { code: "ENOENT" });
    await assert.rejects(stat(join(root, STAGING)), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(join(root, OTHER, "artifact.json"), "utf8")).projectId, PROJECT_B);

    const second = await synchronizeLocalArtifactCache(root, PROJECT_A, []);
    assert.deepEqual(second, { removed: 1, retained: 0 });
    await assert.rejects(readFile(join(root, CURRENT, "artifact.json")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(join(root, OTHER, "artifact.json"), "utf8")).projectId, PROJECT_B);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function cachedArtifact(root: string, artifactId: string, metadata: Record<string, unknown>) {
  const directory = join(root, artifactId);
  await mkdir(directory);
  await writeFile(join(directory, "artifact.json"), JSON.stringify({
    sha256: `sha256:${"a".repeat(64)}`,
    kind: "BUILD",
    targetPlatform: "macos",
    filename: "game.tar.gz",
    ...metadata,
  }));
}
