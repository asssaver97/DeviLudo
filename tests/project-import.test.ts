import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createStoredZip } from "@/lib/product/source-archive";
import {
  analyzeImportedProject,
  inspectProjectZip,
} from "@/services/core/src/project-import";
import type { StoredInstanceAgentSettings } from "@/services/core/src/repository";

const encoder = new TextEncoder();
const sourceZip = createStoredZip([
  { path: "clock-game/project.godot", bytes: encoder.encode("[application]\nrun/main_scene=\"res://main.tscn\"") },
  { path: "clock-game/README.md", bytes: encoder.encode("# Clock Game\nA time-loop puzzle adventure.") },
  { path: "clock-game/scripts/main.gd", bytes: encoder.encode("extends Node\nfunc reset_timeline(): pass") },
]);

const settings: StoredInstanceAgentSettings = Object.freeze({
  agentRuntime: "CLAUDE_CODE",
  baseUrl: "https://gateway.example.com/anthropic/v1",
  models: Object.freeze({
    primary: "claude-primary",
    opus: "claude-opus",
    sonnet: "claude-sonnet",
    haiku: "claude-haiku",
    subagent: "claude-subagent",
  }),
  credentialSecretRef: "vault://instance/agent-runtime/api-key/versions/30000000-0000-4000-8000-000000000099",
  apiKeyMask: "sk-********alue",
  apiKeyFingerprint: "sha256:0123456789ab",
  credentialVersion: "30000000-0000-4000-8000-000000000099",
  revision: 7,
  updatedBy: "tester",
  updatedAt: new Date(0).toISOString(),
});

test("local project ZIP is normalized into a bounded immutable source snapshot", () => {
  const snapshot = inspectProjectZip({
    bytes: sourceZip,
    sourceKind: "LOCAL_ARCHIVE",
    displayName: "Clock Game",
  });
  assert.equal(snapshot.fileCount, 3);
  assert.equal(snapshot.displayName, "Clock Game");
  assert.match(snapshot.context, /time-loop puzzle adventure/);
  const tar = gunzipSync(snapshot.archive);
  assert.match(tar.toString("utf8"), /project\.godot/);
  assert.match(tar.toString("utf8"), /reset_timeline/);
});

test("project import rejects credentials even when the archive is otherwise valid", () => {
  const archive = createStoredZip([
    { path: "game/project.godot", bytes: encoder.encode("[application]") },
    { path: "game/.env", bytes: encoder.encode("API_KEY=secret") },
  ]);
  assert.throws(() => inspectProjectZip({
    bytes: archive,
    sourceKind: "LOCAL_ARCHIVE",
    displayName: "game",
  }), /不允许导入的凭据文件/);
});

test("import analysis creates the collaborative document and development specification", async () => {
  const source = inspectProjectZip({ bytes: sourceZip, sourceKind: "LOCAL_ARCHIVE", displayName: "Clock Game" });
  const analysis = await analyzeImportedProject({
    source,
    settings,
    apiKey: "sk-test-secret",
    fetchImpl: (async (_input, init) => {
      assert.match(String(init?.body), /reset_timeline/);
      return Response.json({ content: [{ type: "text", text: JSON.stringify({
        name: "时序回廊",
        introduction: "一款围绕时间循环展开的像素解谜游戏。",
        gameplay: "探索场景、记录线索并重置时间线来改变事件结果。",
        categories: ["解谜", "冒险"],
        features: ["时间循环", "状态持久化"],
        coreLoop: ["探索", "推理", "重置"],
        playerExperience: "在重复中逐步掌握因果关系。",
        acceptanceCriteria: ["可以完成一次时间循环"],
        summary: "源码已解析。我整理了现有玩法和后续开发计划，可以继续讨论下一步修改。",
      }) }] });
    }) as typeof fetch,
  });
  assert.equal(analysis.name, "时序回廊");
  assert.deepEqual(analysis.document.categories, ["解谜", "冒险"]);
  assert.deepEqual(analysis.specification.coreLoop, ["探索", "推理", "重置"]);
  assert.equal(analysis.settingsRevision, 7);
});
