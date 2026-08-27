import assert from "node:assert/strict";
import test from "node:test";
import {
  agentProgressContentChunks,
  agentProgressDisplayRows,
  localizedAgentProgressContent,
} from "../lib/product/agent-progress";
import type { AgentProgressEvent } from "../lib/product/contracts";

function progress(
  sequence: number,
  kind: AgentProgressEvent["kind"],
  content: string,
): AgentProgressEvent {
  return Object.freeze({
    sequence,
    jobId: "00000000-0000-4000-8000-000000000001",
    kind,
    content,
    createdAt: "2026-07-30T12:00:00.000Z",
  });
}

test("adjacent Agent transport fragments render as continuous text", () => {
  const rows = agentProgressDisplayRows([
    progress(1, "PHASE", "Agent started"),
    progress(2, "AGENT_OUTPUT", "I'll inspect the wor"),
    progress(3, "AGENT_OUTPUT", "k.\nThen implement it."),
    progress(4, "COMPLETED", "Done"),
  ]);

  assert.deepEqual(rows.map(row => [row.kind, row.content]), [
    ["PHASE", "Agent started"],
    ["AGENT_OUTPUT", "I'll inspect the work.\nThen implement it."],
    ["COMPLETED", "Done"],
  ]);
});

test("Agent whitespace survives transport fragment merging", () => {
  const rows = agentProgressDisplayRows([
    progress(1, "AGENT_OUTPUT", "First sentence. "),
    progress(2, "AGENT_OUTPUT", "Second sentence.\n\n"),
    progress(3, "AGENT_OUTPUT", "New paragraph."),
  ]);

  assert.equal(rows[0]?.content, "First sentence. Second sentence.\n\nNew paragraph.");
});

test("Agent progress renders model text instead of provider JSON", () => {
  const rows = agentProgressDisplayRows([
    progress(1, "AGENT_OUTPUT", `${JSON.stringify({ type: "thread.started", thread_id: "private-thread" })}\n`),
    progress(2, "AGENT_OUTPUT", `${JSON.stringify({
      type: "item.completed",
      item: { type: "reasoning", text: "正在核对玩法约束。" },
    })}\n`),
    progress(3, "AGENT_OUTPUT", `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 42 } })}\n`),
  ]);

  assert.deepEqual(rows.map(row => [row.kind, row.content]), [
    ["AGENT_OUTPUT", "正在核对玩法约束。\n"],
  ]);
});

test("long raw Agent output is split for storage and reconstructed without deletion", () => {
  const content = `${"a".repeat(3_999)}😀${"b".repeat(4_002)}\n`;
  const chunks = agentProgressContentChunks("AGENT_OUTPUT", content);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(""), content);
  assert.ok(chunks.every(chunk => [...chunk].length <= 4_000));
});

test("English UI localizes executor phases but preserves Agent-authored output", () => {
  const [phase, output] = agentProgressDisplayRows([
    progress(1, "PHASE", "已读取绑定目录中的 554 个最新源码文件"),
    progress(2, "AGENT_OUTPUT", "我会先检查现有项目。"),
  ]);

  assert.equal(localizedAgentProgressContent(phase!, "en"), "Read 554 latest source files from the bound directory");
  assert.equal(localizedAgentProgressContent(output!, "en"), "我会先检查现有项目。");
  assert.equal(localizedAgentProgressContent(phase!, "zh"), "已读取绑定目录中的 554 个最新源码文件");
});
