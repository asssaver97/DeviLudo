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

  await stack.configureAgent();
  await stack.executeSql(`
    INSERT INTO deviludo.runtime_images(runtime_key, image_reference, release_version, verified_at)
    VALUES ('AGENT_CLAUDE', 'sha256:${"4".repeat(64)}', 'e2e-workflow', clock_timestamp())
    ON CONFLICT (runtime_key) DO UPDATE SET
      image_reference = EXCLUDED.image_reference,
      release_version = EXCLUDED.release_version,
      verified_at = EXCLUDED.verified_at,
      updated_at = clock_timestamp();
  `);
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

test("a failed Agent generation retries with the currently registered runtime image", async ({ stack }) => {
  await stack.configureAgent();
  await stack.executeSql(`
    INSERT INTO deviludo.runtime_images(runtime_key, image_reference, release_version, verified_at)
    VALUES ('AGENT_CLAUDE', 'sha256:${"3".repeat(64)}', 'e2e-retry', clock_timestamp())
    ON CONFLICT (runtime_key) DO UPDATE SET
      image_reference = EXCLUDED.image_reference,
      release_version = EXCLUDED.release_version,
      verified_at = EXCLUDED.verified_at,
      updated_at = clock_timestamp();
  `);
  const project = await stack.createProject({
    name: "运行时恢复",
    concept: "验证本地镜像更新后可以安全地重新创建 Agent 生成作业。",
  });
  const failedJobId = randomUUID();
  const artifactId = randomUUID();
  const obsoleteRuntime = `sha256:${"1".repeat(64)}`;
  await stack.executeSql(`
    UPDATE deviludo.workflow_instances
       SET state = 'FAILED', version = version + 1, updated_at = clock_timestamp()
     WHERE workspace_id = '${project.workspaceId}'::uuid AND id = '${project.workflowId}'::uuid;
    INSERT INTO deviludo.artifacts(
      workspace_id, id, project_id, workflow_id, kind, bucket, object_key, sha256, size_bytes
    ) VALUES (
      '${project.workspaceId}'::uuid, '${artifactId}'::uuid, '${project.id}'::uuid, '${project.workflowId}'::uuid,
      'SPECIFICATION', 'deviludo-artifacts',
      'workspaces/${project.workspaceId}/projects/${project.id}/specification/retry.json',
      'sha256:${"2".repeat(64)}', 1
    );
    INSERT INTO deviludo.jobs(
      workspace_id, id, workflow_id, project_id, kind, pool_kind, required_capabilities,
      exclusive, runtime_image, output_contract, state, attempt, idempotency_key, last_error
    ) VALUES (
      '${project.workspaceId}'::uuid, '${failedJobId}'::uuid, '${project.workflowId}'::uuid, '${project.id}'::uuid,
      'AGENT_GENERATION', 'CORE', ARRAY['MICROVM','NETWORK_POLICY'], false, '${obsoleteRuntime}',
      '{"kinds":["SOURCE","SPECIFICATION"],"maxBytes":1073741824}'::jsonb,
      'FAILED', 5, 'obsolete-agent-runtime',
      'Sandbox executor failed: {"code":"EXECUTOR_REJECTED","message":"Runtime image is not in the signed release allowlist"}'
    );
  `);

  const artifactsResponse = await stack.web(`/api/projects/${project.id}/artifacts`);
  expect(artifactsResponse.status(), await artifactsResponse.text()).toBe(200);
  expect(await artifactsResponse.json()).toMatchObject({
    artifacts: [expect.objectContaining({
      id: artifactId,
      projectId: project.id,
      workspaceId: project.workspaceId,
      kind: "SPECIFICATION",
    })],
  });
  const downloadResponse = await stack.web(`/api/projects/${project.id}/artifacts/${artifactId}/download`, {
    method: "POST",
    data: {},
  });
  expect(downloadResponse.status(), await downloadResponse.text()).toBe(200);
  expect(await downloadResponse.json()).toMatchObject({
    filename: "retry.json",
    url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
    expiresAt: expect.any(String),
  });

  const retryKey = `agent-retry:${randomUUID()}`;
  const retry = await stack.web(`/api/projects/${project.id}/retry-agent`, {
    method: "POST",
    data: {},
    headers: { "idempotency-key": retryKey },
  });
  expect(retry.status(), await retry.text()).toBe(202);
  expect(await retry.json()).toEqual({ accepted: true });

  const duplicate = await stack.web(`/api/projects/${project.id}/retry-agent`, {
    method: "POST",
    data: {},
    headers: { "idempotency-key": retryKey },
  });
  expect(duplicate.status(), await duplicate.text()).toBe(200);
  expect(await duplicate.json()).toEqual({ accepted: false });
  const jobs = await stack.queryRows<{ id: string; runtime_image: string; state: string }>(`
    SELECT id::text, runtime_image, state::text
      FROM deviludo.jobs
     WHERE workflow_id = '${project.workflowId}'::uuid AND kind = 'AGENT_GENERATION'
     ORDER BY created_at
  `);
  expect(jobs).toHaveLength(2);
  expect(jobs[0]).toMatchObject({ id: failedJobId, runtime_image: obsoleteRuntime, state: "FAILED" });
  expect(jobs[1].runtime_image).not.toBe(obsoleteRuntime);
  expect(["QUEUED", "RUNNING", "RETRY"]).toContain(jobs[1].state);
});
