import assert from "node:assert/strict";
import test from "node:test";
import { runtimeOutputText } from "../lib/product/runtime-output";

test("Codex JSONL renders reasoning, safe commands, output, and structured reply content", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "private-thread" }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "先检查项目结构。" } }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "/bin/bash -lc 'API_KEY=secret npm test'" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "全部测试通过\n" } }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ content: "开发计划已经完成。", readyForDevelopment: true }) },
    }),
    JSON.stringify({ type: "deviludo.content_delta", delta: "开发计划已经完成。" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 42 } }),
  ].join("\n");

  const rendered = runtimeOutputText(output);
  assert.equal(rendered, [
    "先检查项目结构。",
    "$ API_KEY=•••• npm test",
    "全部测试通过",
    "开发计划已经完成。",
  ].join("\n"));
  assert.doesNotMatch(rendered, /thread_id|input_tokens|readyForDevelopment|\{"/u);
});

test("Claude stream JSON renders only incremental thinking and text", () => {
  const output = [
    JSON.stringify({ type: "system", subtype: "init", tools: ["Read", "Bash"] }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先分析" } },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "规则。" } },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "开始设计。" } },
    }),
    JSON.stringify({ type: "deviludo.content_delta", delta: "开始设计。" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "开始设计。" }] } }),
  ].join("\n");

  assert.equal(runtimeOutputText(output), "先分析规则。开始设计。");
});

test("a non-streamed structured Runtime result still renders its content field", () => {
  assert.equal(runtimeOutputText(JSON.stringify({
    content: "最终开发结果",
    readyForDevelopment: true,
  })), "最终开发结果\n");
});

test("plain Runtime stderr remains visible while JSON metadata stays hidden", () => {
  const output = [
    "Provider connection failed",
    JSON.stringify({ type: "turn.failed", error: { message: "请求超时" } }),
    JSON.stringify({ type: "turn.started" }),
    "",
  ].join("\n");
  assert.equal(runtimeOutputText(output), "Provider connection failed\n请求超时\n");
});
