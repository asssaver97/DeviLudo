import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/stack";

test("bound local directory creates immediately, then finishes its source snapshot and Agent analysis asynchronously", async ({ stack }) => {
  await stack.configureAgent();
  const bindingId = randomUUID();
  const key = `project-import:${randomUUID()}`;
  const localBindingUrl = "/api/projects/bind/local-directory";
  const binding = { name: "clock-game", bindingId, gitBranch: "codex/local-import" };
  const imported = await stack.web(localBindingUrl, {
    method: "POST",
    headers: { "idempotency-key": key },
    data: binding,
  });
  expect(imported.status(), await imported.text()).toBe(202);
  const body = await imported.json() as {
    workspace: { id: string; name: string };
    project: {
      id: string;
      name: string;
      analysisStatus: string;
      workflowId: string;
      source:{revision:number;digest:string;relativePath:string;fileCount:number};
      localDirectory:{bindingId:string;sourceKind:string;initialGitBranch:string|null};
      document: { maintainedBy: string; content: { gameplay: string; categories: string[] } };
    };
    conversation: null;
  };
  expect(body.workspace.name).toBe("Local workspace");
  expect(body.project).toMatchObject({ name: "clock-game", analysisStatus: "PENDING", source: null });
  expect(body.conversation).toBeNull();

  const analyzed = await stack.waitForProject(body.project.id, project => project.analysisStatus === "READY");
  expect(analyzed.name).toBe("clock-game");
  expect(analyzed.document).toMatchObject({
    maintainedBy: "AGENT",
    content: { categories: ["解谜", "冒险"] },
  });
  expect(analyzed.localDirectory).toEqual({
    bindingId,
    sourceKind: "LOCAL_DIRECTORY",
    repositoryUrl: null,
    initialGitBranch: "codex/local-import",
  });
  if (!analyzed.source) throw new Error("Analyzed project source is missing");
  const conversationsResponse = await stack.web(`/api/projects/${body.project.id}/conversations`);
  const conversations = await conversationsResponse.json() as { conversations: readonly { id: string }[] };
  const conversationResponse = await stack.web(`/api/conversations/${conversations.conversations[0].id}`);
  const conversation = (await conversationResponse.json() as {
    conversation: { id: string; messages: readonly { role: string; content: string }[] };
  }).conversation;
  expect(conversation.messages.map(message => message.role)).toEqual(["USER", "ASSISTANT"]);
  expect(conversation.messages[1].content).toContain("源码已解析");

  const sources = await stack.queryRows<{
    revision:number;content_digest:string;relative_path:string;file_count:number;
  }>(`SELECT revision::int,content_digest,relative_path,file_count::int
        FROM deviludo.project_source_revisions
       WHERE project_id = '${body.project.id}'::uuid`);
  expect(sources).toHaveLength(1);
  expect(sources[0]).toMatchObject({revision:1,content_digest:analyzed.source.digest,file_count:3});
  expect(sources[0].relative_path).toContain(`workspaces/${body.workspace.id}/projects/${body.project.id}/revisions/`);

  const continued = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { conversationId: conversation.id, content: "接下来增加一个可以保留线索的日志面板。" },
  });
  expect(continued.status(), await continued.text()).toBe(200);
  expect((await continued.json() as { conversation: { messages: unknown[] } }).conversation.messages).toHaveLength(4);

  const replay = await stack.web(localBindingUrl, {
    method: "POST",
    headers: { "idempotency-key": key },
    data: binding,
  });
  expect(replay.status()).toBe(200);
  expect((await replay.json() as { project: { id: string } }).project.id).toBe(body.project.id);

  const localBinding = await stack.queryRows<{ binding_id: string; branch: string }>(`
    SELECT state_data #>> '{source,localDirectoryBindingId}' AS binding_id,
           state_data #>> '{source,gitBranch}' AS branch
      FROM deviludo.workflow_instances
     WHERE id = '${body.project.workflowId}'::uuid
  `);
  expect(localBinding).toEqual([{ binding_id: bindingId, branch: "codex/local-import" }]);

  await stack.executeSql(`
    INSERT INTO deviludo.runtime_images(runtime_key, image_reference, release_version, verified_at)
    VALUES ('AGENT_CLAUDE', 'sha256:${"a".repeat(64)}', 'test', clock_timestamp())
    ON CONFLICT (runtime_key) DO UPDATE
      SET image_reference = EXCLUDED.image_reference, verified_at = EXCLUDED.verified_at;
  `);
  const approved = await stack.web(`/api/projects/${body.project.id}/approve`, {
    method: "POST",
    data: {},
  });
  expect(approved.status(), await approved.text()).toBe(202);
  const generationInputs = await stack.queryRows<{ kind: string;source_revision:number }>(`
    SELECT artifact.kind::text AS kind,(job.payload->>'sourceRevision')::int source_revision
      FROM deviludo.jobs job
      JOIN deviludo.artifact_inputs input ON job.workspace_id=input.workspace_id AND job.id=input.job_id
      JOIN deviludo.artifacts artifact ON artifact.workspace_id=input.workspace_id AND artifact.id=input.artifact_id
     WHERE job.project_id = '${body.project.id}'::uuid
       AND job.kind = 'AGENT_GENERATION'
     ORDER BY artifact.kind
  `);
  expect(generationInputs).toEqual([{kind:"SPECIFICATION",source_revision:1}]);
});

test("project linking still creates immediately and records an asynchronous failure when Agent is not configured", async ({ stack }) => {
  const response = await stack.web("/api/projects/bind/local-directory", {
    method: "POST",
    headers: { "idempotency-key": `project-bind:${randomUUID()}` },
    data: { name: "empty-agent", bindingId: randomUUID() },
  });
  expect(response.status()).toBe(202);
  const body = await response.json() as { project: { id: string; name: string; analysisStatus: string } };
  expect(body.project).toMatchObject({ name: "empty-agent", analysisStatus: "PENDING" });
  const failed = await stack.waitForProject(body.project.id, project => project.analysisStatus === "FAILED");
  expect(failed.analysisError).toContain("配置全局 Agent");
  expect(await stack.queryRows<{ count: number }>("SELECT count(*)::int AS count FROM deviludo.workspaces"))
    .toEqual([{ count: 1 }]);
  await stack.configureAgent();
  const retried = await stack.web(`/api/projects/${body.project.id}/analysis/retry`, { method: "POST", data: {} });
  expect(retried.status(), await retried.text()).toBe(202);
  const recovered = await stack.waitForProject(body.project.id, project => project.analysisStatus === "READY");
  expect(recovered.name).toBe("empty-agent");
});

test("a host-cloned GitHub working tree keeps canonical repository metadata without an archive upload", async ({ stack }) => {
  await stack.configureAgent();
  const response = await stack.web("/api/projects/bind/github", {
    method: "POST",
    headers: { "idempotency-key": `github-import:${randomUUID()}` },
    data: {
      name: "private-game",
      repositoryUrl: "git@github.com:example/private-game.git",
      bindingId: randomUUID(),
      gitBranch: "codex/github-import",
    },
  });
  expect(response.status(), await response.text()).toBe(202);
  const body = await response.json() as { project: { id: string; workflowId: string } };
  await stack.waitForProject(body.project.id, project => project.analysisStatus === "READY");
  const events = await stack.queryRows<{ source_kind: string; repository_url: string; branch: string }>(`
    SELECT event_data->>'sourceKind' AS source_kind,event_data->>'repositoryUrl' AS repository_url,
           event_data->>'gitBranch' AS branch
      FROM deviludo.workflow_events
     WHERE workflow_id = '${body.project.workflowId}'::uuid AND event_kind = 'PROJECT_IMPORTED'
  `);
  expect(events).toEqual([{
    source_kind: "GIT",
    repository_url: "https://github.com/example/private-game",
    branch: "codex/github-import",
  }]);
});
