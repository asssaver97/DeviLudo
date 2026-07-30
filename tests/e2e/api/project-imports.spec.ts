import { randomUUID } from "node:crypto";
import { createStoredZip } from "../../../lib/product/source-archive";
import { test, expect } from "../fixtures/stack";

const encoder = new TextEncoder();

test("local project import creates a source snapshot, Agent document, and resumable conversation", async ({ stack }) => {
  await stack.configureAgent();
  const archive = createStoredZip([
    { path: "clock-game/project.godot", bytes: encoder.encode("[application]\nrun/main_scene=\"res://main.tscn\"") },
    { path: "clock-game/README.md", bytes: encoder.encode("# Clock Game\nA time-loop puzzle adventure.") },
    { path: "clock-game/scripts/main.gd", bytes: encoder.encode("extends Node\nfunc reset_timeline(): pass") },
  ]);
  const key = `project-import:${randomUUID()}`;
  const imported = await stack.web("/api/projects/import/archive?name=clock-game", {
    method: "POST",
    headers: { "content-type": "application/zip", "idempotency-key": key },
    data: Buffer.from(archive),
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const body = await imported.json() as {
    workspace: { id: string; name: string };
    project: {
      id: string;
      name: string;
      workflowId: string;
      document: { maintainedBy: string; content: { gameplay: string; categories: string[] } };
    };
    conversation: { id: string; messages: readonly { role: string; content: string }[] };
  };
  expect(body.workspace.name).toBe("时序回廊");
  expect(body.project.name).toBe("时序回廊");
  expect(body.project.document).toMatchObject({
    maintainedBy: "AGENT",
    content: { categories: ["解谜", "冒险"] },
  });
  expect(body.conversation.messages.map(message => message.role)).toEqual(["USER", "ASSISTANT"]);
  expect(body.conversation.messages[1].content).toContain("源码已解析");

  const artifacts = await stack.queryRows<{
    kind: string;
    producing_job_id: string | null;
    object_key: string;
    metadata: { imported: boolean; fileCount: number };
  }>(`SELECT kind::text, producing_job_id::text, object_key, metadata
        FROM deviludo.artifacts
       WHERE project_id = '${body.project.id}'::uuid`);
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0]).toMatchObject({
    kind: "SOURCE",
    producing_job_id: null,
    metadata: { imported: true, fileCount: 3 },
  });
  expect(artifacts[0].object_key).toContain(`workspaces/${body.workspace.id}/projects/${body.project.id}/imports/`);

  const continued = await stack.web("/api/conversations/messages", {
    method: "POST",
    data: { conversationId: body.conversation.id, content: "接下来增加一个可以保留线索的日志面板。" },
  });
  expect(continued.status(), await continued.text()).toBe(200);
  expect((await continued.json() as { conversation: { messages: unknown[] } }).conversation.messages).toHaveLength(4);

  const replay = await stack.web("/api/projects/import/archive?name=clock-game", {
    method: "POST",
    headers: { "content-type": "application/zip", "idempotency-key": key },
    data: Buffer.from(archive),
  });
  expect(replay.status()).toBe(200);
  expect((await replay.json() as { project: { id: string } }).project.id).toBe(body.project.id);

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
  const generationInputs = await stack.queryRows<{ kind: string; imported: boolean }>(`
    SELECT artifact.kind::text AS kind,
           coalesce((artifact.metadata->>'imported')::boolean, false) AS imported
      FROM deviludo.artifact_inputs input
      JOIN deviludo.jobs job
        ON job.workspace_id = input.workspace_id AND job.id = input.job_id
      JOIN deviludo.artifacts artifact
        ON artifact.workspace_id = input.workspace_id AND artifact.id = input.artifact_id
     WHERE job.project_id = '${body.project.id}'::uuid
       AND job.kind = 'AGENT_GENERATION'
     ORDER BY artifact.kind
  `);
  expect(generationInputs).toEqual([
    { kind: "SOURCE", imported: true },
    { kind: "SPECIFICATION", imported: false },
  ]);
});

test("project import fails before any workspace write when Agent is not configured", async ({ stack }) => {
  const archive = createStoredZip([
    { path: "project.godot", bytes: encoder.encode("[application]") },
  ]);
  const response = await stack.web("/api/projects/import/archive?name=empty-agent", {
    method: "POST",
    headers: { "content-type": "application/zip", "idempotency-key": `project-import:${randomUUID()}` },
    data: Buffer.from(archive),
  });
  expect(response.status()).toBe(424);
  expect(await response.json()).toMatchObject({ code: "AGENT_CONFIG_REQUIRED" });
  expect(await stack.queryRows<{ count: number }>("SELECT count(*)::int AS count FROM deviludo.workspaces"))
    .toEqual([{ count: 0 }]);
});
