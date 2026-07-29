import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/stack";

test("project, specification and workflow APIs cover validation, idempotency and terminal behavior", async ({ stack }) => {
  const empty = await stack.web("/api/projects");
  expect(empty.status()).toBe(409);
  expect(await empty.json()).toMatchObject({ code: "WORKSPACE_REQUIRED" });

  for (const invalid of [
    null,
    { concept: "short" },
    { concept: "x".repeat(4_001) },
    { name: "x".repeat(201), concept: "一个长度足够的有效游戏构想。" },
  ]) {
    const response = await stack.web("/api/projects", {
      method: "POST",
      data: invalid,
    });
    expect(response.status()).toBe(400);
  }

  const project = await stack.createProject({
    concept: "雾港列车。玩家需要在风暴中调度幽灵列车并营救乘客。",
  });
  expect(project.workflowState).toBe("DRAFT");
  expect(project.name).toBe("雾港列车");
  expect(project.specification).toMatchObject({ title: "雾港列车" });

  const list = await stack.web("/api/projects?ignored=true");
  expect((await list.json() as { projects: { id: string }[] }).projects.map(item => item.id)).toContain(project.id);

  const missingId = randomUUID();
  expect((await stack.web(`/api/projects/${missingId}`)).status()).toBe(404);
  expect((await stack.web(`/api/projects/${missingId}/specification`, { method: "POST", data: { note: "有效修订" } })).status()).toBe(404);
  expect((await stack.web(`/api/projects/${missingId}/approve`, { method: "POST", data: {} })).status()).toBe(404);
  expect((await stack.web(`/api/projects/${missingId}/cancel`, { method: "POST", data: {} })).status()).toBe(404);

  const shortRevision = await stack.web(`/api/projects/${project.id}/specification`, {
    method: "POST",
    data: { note: "x" },
  });
  expect(shortRevision.status()).toBe(400);

  const revisionNote = "单局限制为十分钟，并支持手柄震动反馈。";
  const revised = await stack.web(`/api/projects/${project.id}/specification`, {
    method: "POST",
    data: { note: revisionNote },
  });
  expect(revised.ok()).toBeTruthy();
  const revisedProject = (await revised.json() as { project: { specification: { revisionNotes: string[] } } }).project;
  expect(revisedProject.specification.revisionNotes).toContain(revisionNote);

  const signal = {
    workspaceId: project.workspaceId,
    kind: "EXTERNAL_APPROVAL",
    idempotencyKey: `external:${project.workflowId}`,
    payload: { source: "e2e" },
  };
  const acceptedSignal = await stack.coreWeb(`/v1/workflows/${project.workflowId}/signals`, {
    method: "POST",
    data: signal,
  });
  expect(acceptedSignal.status()).toBe(202);
  expect(await acceptedSignal.json()).toEqual({ accepted: true });
  const duplicateSignal = await stack.coreWeb(`/v1/workflows/${project.workflowId}/signals`, {
    method: "POST",
    data: signal,
  });
  expect(duplicateSignal.status()).toBe(200);
  expect(await duplicateSignal.json()).toEqual({ accepted: false });

  const invalidSignal = await stack.coreWeb(`/v1/workflows/${project.workflowId}/signals`, {
    method: "POST",
    data: { workspaceId: signal.workspaceId, kind: "UNKNOWN", idempotencyKey: "invalid", payload: {} },
  });
  expect(invalidSignal.status()).toBe(400);

  const firstApproval = await stack.web(`/api/projects/${project.id}/approve`, { method: "POST", data: {} });
  expect(firstApproval.status()).toBe(202);
  expect(await firstApproval.json()).toEqual({ accepted: true });
  const duplicateApproval = await stack.web(`/api/projects/${project.id}/approve`, { method: "POST", data: {} });
  expect(duplicateApproval.status()).toBe(200);
  expect(await duplicateApproval.json()).toEqual({ accepted: false });

  const lockedRevision = await stack.web(`/api/projects/${project.id}/specification`, {
    method: "POST",
    data: { note: "批准后不能再修改" },
  });
  expect(lockedRevision.status()).toBe(400);

  const firstCancel = await stack.web(`/api/projects/${project.id}/cancel`, { method: "POST", data: {} });
  expect(firstCancel.status()).toBe(202);
  const duplicateCancel = await stack.web(`/api/projects/${project.id}/cancel`, { method: "POST", data: {} });
  expect(duplicateCancel.status()).toBe(200);
  const cancelled = await stack.waitForProject(project.id, value => value.workflowState === "CANCELLED");
  expect(cancelled.jobs.every(job => ["SUCCEEDED", "CANCELLED"].includes(job.state))).toBeTruthy();
});
