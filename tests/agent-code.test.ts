import assert from "node:assert/strict";
import test from "node:test";
import { agentContentBlocks, commandOutputMarkdown } from "../lib/product/agent-code";
import { runtimeOutputText } from "../lib/product/runtime-output";
import { agentProgressContentChunks, agentProgressDisplayRows } from "../lib/product/agent-progress";

test("file headings and fence metadata become separate named code blocks without duplicate headings", () => {
  const parts = agentContentBlocks("已更新。\n\n### `scripts/main.gd`\n```gdscript\nextends Node\n```\n```ts filename=src/app.ts\nexport {};\n```\n请查看结果。");
  assert.deepEqual(parts.map(part => [part.kind, part.filename, part.content.trim()]), [
    ["text", undefined, "已更新。"],
    ["code", "scripts/main.gd", "extends Node"],
    ["code", "src/app.ts", "export {};"],
    ["text", undefined, "请查看结果。"],
  ]);
});

test("streamed code keeps its identity and retains every line until the fence closes", () => {
  const start = "说明\n```gdscript scripts/main.gd\nfunc run():\n";
  const partial = agentContentBlocks(start).at(-1)!;
  const complete = agentContentBlocks(`${start}\tpass\n\`\`\`\n已保存。`)[1]!;
  assert.equal(partial.kind, "code");
  assert.equal(partial.offset, complete.offset);
  assert.equal(partial.filename, complete.filename);
  assert.equal(complete.content, "func run():\n\tpass\n");
});

test("command output retains filenames, indentation, embedded fences and long lines", () => {
  const source = `\tprint("${"长".repeat(10_000)}")\n\`\`\`\n`;
  const output = runtimeOutputText(JSON.stringify({ type: "item.completed", item: {
    type: "command_execution", command: "/bin/sh -lc \"sed -n '1,80p' scripts/main.gd\"", aggregated_output: source,
  } }));
  const [block] = agentContentBlocks(output);
  assert.equal(block?.kind, "code");
  assert.equal(block?.filename, "scripts/main.gd");
  assert.equal(block?.content, source);
});

test("multi-file command output names its sources together without inventing file boundaries", () => {
  const [block] = agentContentBlocks(commandOutputMarkdown("sed -n '1,4p' a.gd; cat 'ui/menu.gd'", "mixed output\n"));
  assert.equal(block?.filename, "a.gd · ui/menu.gd");
  assert.equal(block?.content, "mixed output\n");
});

test("chunked source output never flashes partial provider JSON and reconstructs completely", () => {
  const source = `${"extends Node\n".repeat(900)}# end\n`;
  const event = JSON.stringify({ type: "item.completed", item: {
    type: "command_execution", command: "cat scripts/main.gd", aggregated_output: source,
  } });
  const chunks = agentProgressContentChunks("AGENT_OUTPUT", event);
  const events = chunks.map((content, index) => ({
    content, sequence: index + 1, kind: "AGENT_OUTPUT" as const, jobId: "job", createdAt: new Date(0).toISOString(),
  }));
  assert.deepEqual(agentProgressDisplayRows(events.slice(0, 1)), []);
  const [row] = agentProgressDisplayRows(events);
  const [block] = agentContentBlocks(row!.content);
  assert.equal(block?.filename, "scripts/main.gd");
  assert.equal(block?.content, source);
});

test("JSON and HTML inside plain fenced code stay literal", () => {
  const markdown = '```json filename=config.json\n{"enabled":true}\n<script>alert(1)</script>\n```\n';
  assert.equal(runtimeOutputText(markdown), markdown);
  assert.equal(agentContentBlocks(markdown)[0]?.content, '{"enabled":true}\n<script>alert(1)</script>\n');
  assert.equal(agentContentBlocks("Use the file main.gd\n```gdscript\npass\n```")[0]?.content, "Use the file main.gd\n");
});
