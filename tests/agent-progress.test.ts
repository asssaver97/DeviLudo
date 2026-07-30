import assert from "node:assert/strict";
import test from "node:test";
import { agentProgressDisplayRows } from "../lib/product/agent-progress";
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
