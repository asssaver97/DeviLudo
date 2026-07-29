import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/stack";

test("workspace selection persists, clears, and project creation is idempotent", async ({ stack }) => {
  const initial = await stack.web("/api/session");
  expect(await initial.json()).toEqual({ session: { selectedWorkspace: null } });
  expect((await (await stack.web("/api/workspaces")).json() as { workspaces: unknown[] }).workspaces).toEqual([]);

  const manual = await stack.web("/api/workspaces", { method: "POST", data: { name: "北港工作区" } });
  expect(manual.status()).toBe(201);
  const manualWorkspace = (await manual.json() as { workspace: { id: string; name: string } }).workspace;
  expect(manualWorkspace.name).toBe("北港工作区");
  expect(await (await stack.web("/api/session")).json()).toMatchObject({
    session: { selectedWorkspace: { id: manualWorkspace.id, name: "北港工作区" } },
  });

  expect((await stack.web("/api/session/workspace", { method: "DELETE" })).ok()).toBeTruthy();
  expect((await stack.web("/api/projects")).status()).toBe(409);

  const selected = await stack.web("/api/session/workspace", {
    method: "PUT",
    data: { workspaceId: manualWorkspace.id },
  });
  expect(selected.ok()).toBeTruthy();
  expect((await stack.web("/api/session/workspace", {
    method: "PUT",
    data: { workspaceId: randomUUID() },
  })).status()).toBe(404);

  await stack.web("/api/session/workspace", { method: "DELETE" });
  const key = `workspace-project:${randomUUID()}`;
  const input = { name: "潮汐档案", concept: "玩家调查一座每天重置记忆的海边档案馆。" };
  const first = await stack.web("/api/projects", { method: "POST", data: input, headers: { "idempotency-key": key } });
  expect(first.status()).toBe(201);
  const firstBody = await first.json() as { workspace: { id: string; name: string }; project: { id: string; name: string } };
  expect(firstBody.workspace.name).toBe(firstBody.project.name);

  const replay = await stack.web("/api/projects", { method: "POST", data: input, headers: { "idempotency-key": key } });
  expect(replay.status()).toBe(200);
  const replayBody = await replay.json() as typeof firstBody;
  expect(replayBody.workspace.id).toBe(firstBody.workspace.id);
  expect(replayBody.project.id).toBe(firstBody.project.id);

  const isolated = await stack.web("/api/workspaces", { method: "POST", data: { name: "隔离验证工作区" } });
  expect(isolated.status()).toBe(201);
  expect((await stack.web(`/api/projects/${firstBody.project.id}`)).status()).toBe(404);
  expect((await stack.web(`/api/projects/${firstBody.project.id}/specification`, {
    method: "POST",
    data: { note: "不能跨工作区修改" },
  })).status()).toBe(404);
});
