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
    await mkdir(join(project,"revisions"),{recursive:true});await mkdir(join(project,".staging","crashed"),{recursive:true});await writeFile(join(project,".staging","crashed","partial"),"partial");
    const lock=join(project,".source-write.lock");await mkdir(lock);const stale=new Date(Date.now()-20*60_000);await utimes(lock,stale,stale);
    const store=new ProjectSourceStore(root);await store.publishFiles({workspaceId,projectId,revision:1,files:[{path:"project.godot",bytes:Buffer.from("[application]\n")}]});
    assert.deepEqual(await readdir(join(project,".staging")),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("validated Agent checkpoints survive an attempt and disappear after source publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-source-checkpoint-"));
  try {
    const store = new ProjectSourceStore(root);
    const files = [
      { path: "project.godot", bytes: Buffer.from("[application]\n") },
      { path: "scripts/main.gd", bytes: Buffer.from("extends Node\n") },
    ];
    const saved = await store.saveCheckpoint({ workspaceId, projectId, workflowId, files });
    assert.equal(saved.fileCount, 2);
    assert.equal((await store.archiveCheckpoint(workspaceId, projectId, workflowId))?.digest, saved.digest);
    await assert.rejects(
      store.saveCheckpoint({ workspaceId, projectId, workflowId, files: [{ path: ".env", bytes: Buffer.from("TOKEN=x") }] }),
      /forbidden credential/,
    );
    await store.publishFiles({ workspaceId, projectId, revision: 1, files });
    assert.equal(await store.archiveCheckpoint(workspaceId, projectId, workflowId), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
