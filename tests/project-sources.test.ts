import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectSourceStore } from "@/services/core/src/project-sources";

const workspaceId = "30000000-0000-4000-8000-000000000003";
const projectId = "30000000-0000-4000-8000-000000000004";
const workflowId = "30000000-0000-4000-8000-000000000005";

test("persistent source revisions are immutable, deterministic, and project-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-sources-"));
  try {
    const store = new ProjectSourceStore(root);
    const files = [
      { path: "project.godot", bytes: Buffer.from("[application]\n") },
      { path: "scripts/main.gd", bytes: Buffer.from("extends Node\n") },
    ];
    const first = await store.publishFiles({ workspaceId, projectId, revision: 1, files });
    const replay = await store.publishFiles({ workspaceId, projectId, revision: 1, files });
    assert.deepEqual(replay, first);
    assert.equal((await stat(join(root, "workspaces"))).mode & 0o770, 0o770);
    assert.equal((await stat(join(root, first.relativePath, "scripts", "main.gd"))).mode & 0o640, 0o640);
    const current = await readFile(join(root, "workspaces", workspaceId, "projects", projectId, "CURRENT"), "utf8");
    assert.match(current, new RegExp(first.digest));
    const archive = await store.archive(first.relativePath);
    assert.equal(archive.digest, first.digest);
    assert.equal(archive.fileCount, 2);
    await assert.rejects(
      store.publishFiles({ workspaceId, projectId, revision: 1, files: [{ path: "project.godot", bytes: Buffer.from("changed") }] }),
      /already published with different content/,
    );
    await store.deleteProject(workspaceId, projectId);
    await assert.rejects(store.archive(first.relativePath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bounded manifest can be read from its immutable source revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-source-manifest-"));
  try {
    const store = new ProjectSourceStore(root);
    const agent = Buffer.from(JSON.stringify({ assetManifest: { items: [{ assetKey: "ui/icon" }] } }));
    const revision = await store.publishFiles({
      workspaceId,
      projectId,
      revision: 1,
      files: [
        { path: "project.godot", bytes: Buffer.from("[application]\n") },
        { path: "agent.json", bytes: agent },
      ],
    });
    assert.deepEqual(await store.readRevisionFile(revision.relativePath, "agent.json", 1024), agent);
    await assert.rejects(
      store.readRevisionFile(revision.relativePath, "agent.json", agent.length - 1),
      /file size is invalid/,
    );
    await assert.rejects(
      store.readRevisionFile(revision.relativePath, "../project.godot", 1024),
      /路径|path/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent source publication rejects credentials, traversal, and symlinked path components", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-sources-boundary-"));
  try {
    const store = new ProjectSourceStore(root);
    await assert.rejects(
      store.publishFiles({ workspaceId, projectId, revision: 1, files: [{ path: ".env", bytes: Buffer.from("TOKEN=x") }] }),
      /forbidden credential/,
    );
    await assert.rejects(
      store.publishFiles({ workspaceId, projectId, revision: 1, files: [{ path: "../escape", bytes: Buffer.from("x") }] }),
      /路径|path/i,
    );
    const outside = await mkdtemp(join(tmpdir(), "deviludo-outside-"));
    await mkdir(join(root, "workspaces"), { mode: 0o700 });
    await symlink(outside, join(root, "workspaces", workspaceId));
    await assert.rejects(
      store.publishFiles({ workspaceId, projectId, revision: 1, files: [{ path: "project.godot", bytes: Buffer.from("x") }] }),
      /unsafe path component/,
    );
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale crashed writer is fenced and its uncommitted staging is discarded",async()=>{
  const root=await mkdtemp(join(tmpdir(),"deviludo-source-recovery-"));
  try{
    const project=join(root,"workspaces",workspaceId,"projects",projectId);
    await mkdir(join(project,"revisions"),{recursive:true});await mkdir(join(project,".staging","publish","crashed"),{recursive:true});await writeFile(join(project,".staging","publish","crashed","partial"),"partial");
    const lock=join(project,".source-write.lock");await mkdir(lock);const stale=new Date(Date.now()-20*60_000);await utimes(lock,stale,stale);
    const store=new ProjectSourceStore(root);await store.publishFiles({workspaceId,projectId,revision:1,files:[{path:"project.godot",bytes:Buffer.from("[application]\n")}]});
    assert.deepEqual(await readdir(join(project,".staging","publish")),[]);
    assert.deepEqual(await readdir(join(project,".staging","checkpoints")),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("validated Agent checkpoints survive source publication and carry completion metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-source-checkpoint-"));
  try {
    const store = new ProjectSourceStore(root);
    const files = [
      { path: "project.godot", bytes: Buffer.from("[application]\n") },
      { path: "scripts/main.gd", bytes: Buffer.from("extends Node\n") },
    ];
    const sourceDigest = `sha256:${"a".repeat(64)}`;
    const specificationDigest = `sha256:${"b".repeat(64)}`;
    const saved = await store.saveCheckpoint({
      workspaceId,
      projectId,
      workflowId,
      files,
      state: "AGENT_COMPLETE",
      originJobId: "30000000-0000-4000-8000-000000000006",
      sourceDigest,
      specificationDigest,
    });
    assert.equal(saved.fileCount, 2);
    const restored = await store.archiveCheckpoint(workspaceId, projectId, workflowId);
    assert.equal(restored?.digest, saved.digest);
    assert.equal(restored?.state, "AGENT_COMPLETE");
    assert.equal(restored?.originJobId, "30000000-0000-4000-8000-000000000006");
    assert.equal(restored?.sourceDigest, sourceDigest);
    assert.equal(restored?.specificationDigest, specificationDigest);
    await assert.rejects(
      store.saveCheckpoint({ workspaceId, projectId, workflowId, files: [{ path: ".env", bytes: Buffer.from("TOKEN=x") }] }),
      /forbidden credential/,
    );
    await store.publishFiles({ workspaceId, projectId, revision: 1, files });
    assert.equal((await store.archiveCheckpoint(workspaceId, projectId, workflowId))?.digest, saved.digest);
    await store.deleteCheckpoint(workspaceId, projectId, workflowId);
    assert.equal(await store.archiveCheckpoint(workspaceId, projectId, workflowId), null);
    await store.saveCheckpoint({ workspaceId, projectId, workflowId, files });
    await assert.rejects(
      store.publishFiles({
        workspaceId,
        projectId,
        revision: 1,
        files: [{ path: "project.godot", bytes: Buffer.from("changed") }],
      }),
      /already published with different content/,
    );
    const legacyCompatible = await store.archiveCheckpoint(workspaceId, projectId, workflowId);
    assert.equal(legacyCompatible?.digest, saved.digest);
    assert.equal(legacyCompatible?.state, "PARTIAL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unregistered filesystem revision can be reclaimed without losing the last committed pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-source-orphan-"));
  try {
    const store = new ProjectSourceStore(root);
    const first = await store.publishFiles({
      workspaceId,
      projectId,
      revision: 1,
      files: [{ path: "project.godot", bytes: Buffer.from("first") }],
    });
    const orphan = await store.publishFiles({
      workspaceId,
      projectId,
      revision: 2,
      files: [{ path: "project.godot", bytes: Buffer.from("orphan") }],
    });
    assert.equal(await store.discardUnregisteredRevision(workspaceId, projectId, 2), true);
    assert.equal(await store.discardUnregisteredRevision(workspaceId, projectId, 2), false);
    await assert.rejects(store.archive(orphan.relativePath), /ENOENT/);
    assert.equal((await store.archive(first.relativePath)).digest, first.digest);
    const current = await readFile(join(root, "workspaces", workspaceId, "projects", projectId, "CURRENT"), "utf8");
    assert.deepEqual(JSON.parse(current), {
      revision: 1,
      relativePath: first.relativePath,
      digest: first.digest,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
