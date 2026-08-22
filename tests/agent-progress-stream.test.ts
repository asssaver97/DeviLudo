import assert from "node:assert/strict";
import test from "node:test";
import { readAgentProgressStream } from "../lib/product/agent-progress-stream";
import type { AgentProgressEvent } from "../lib/product/contracts";

test("Agent progress uses incrementally delivered SSE frames without losing a fragmented event", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const encoder = new TextEncoder();
  const first = Object.freeze({
    sequence: 7,
    jobId: "10000000-0000-4000-8000-000000000001",
    kind: "AGENT_OUTPUT",
    content: "first",
    createdAt: "2026-08-22T00:00:00.000Z",
  } satisfies AgentProgressEvent);
  const second = Object.freeze({ ...first, sequence: 8, content: "second" } satisfies AgentProgressEvent);
  const frames = [
    `event: progress\ndata: ${JSON.stringify({ type: "progress", event: first })}\n\n`,
    `event: cursor\ndata: ${JSON.stringify({ type: "cursor", after: first.sequence })}\n\n`,
    `event: progress\ndata: ${JSON.stringify({ type: "progress", event: second })}\n\n`,
  ].join("");
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.slice(0, 37)));
      controller.enqueue(encoder.encode(frames.slice(37, 151)));
      controller.enqueue(encoder.encode(frames.slice(151)));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });

  const events: AgentProgressEvent[] = [];
  const cursor = await readAgentProgressStream("project", 0, new AbortController().signal, event => events.push(event));

  assert.equal(cursor, 8);
  assert.deepEqual(events, [first, second]);
});

test("Core exposes Agent progress as an unbuffered event stream", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("../services/core/src/api.ts", import.meta.url),
    "utf8",
  ));
  assert.match(source, /agent-progress\/stream[\s\S]*"content-type": "text\/event-stream; charset=utf-8"/);
  assert.match(source, /reply\.raw\.flushHeaders\(\)/);
  assert.match(source, /for \(let poll = 0; poll < 5/);
  assert.match(source, /event: progress\\ndata:/);
  assert.match(source, /event: cursor\\ndata:/);
});
