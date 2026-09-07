import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectRuntimeTurnResult } from "@/lib/product/project-runtime";
import { completeTestPlanning } from "@/services/core/src/test-planning-completion";

function reply(content: string): ProjectRuntimeTurnResult {
  return {
    schemaVersion: "deviludo.project-runtime.v2", turnId: "test-turn", role: "TEST", mode: "PRIMARY",
    content, structured: {}, toolCalls: [], sessionId: "session", branchId: null,
    sourceRevision: 5, startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(),
  };
}

test("planning resumes a premature reply until the current turn has a durable plan", async () => {
  let planAuthor = "old-turn";
  const prompts: (string | null)[] = [];
  const result = await completeTestPlanning({
    run: async continuation => {
      prompts.push(continuation);
      if (continuation) planAuthor = "test-turn";
      return reply(continuation ? "Plan saved" : "I have not persisted a complete plan");
    },
    isComplete: async result => planAuthor === result.turnId,
  });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], null);
  assert.ok(prompts[1]);
  assert.equal(result.content, "Plan saved");
  assert.equal(result.turnId, "test-turn");
});

test("planning accepts durable completion without another model call", async () => {
  let calls = 0;
  await completeTestPlanning({
    run: async () => { calls += 1; return reply("Plan saved"); },
    isComplete: async () => true,
  });
  assert.equal(calls, 1);
});

test("an incomplete planning reply fails with its diagnostic after bounded continuation", async () => {
  let calls = 0;
  let continued = 0;
  await assert.rejects(completeTestPlanning({
    run: async () => { calls += 1; return reply("Natural victory journeys remain unfinished"); },
    isComplete: async () => false,
    onContinue: () => { continued += 1; },
  }), /complete current-turn test plan.*Natural victory journeys remain unfinished/);
  assert.equal(calls, 3);
  assert.equal(continued, 2);
});

test("planning cancellation prevents further model calls or successful completion", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(completeTestPlanning({
    run: async () => { calls += 1; controller.abort(); return reply("Plan saved"); },
    isComplete: async () => true,
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("backend failures remain errors instead of consuming completion continuations", async () => {
  let calls = 0;
  await assert.rejects(completeTestPlanning({
    run: async () => { calls += 1; throw new Error("Backend disconnected"); },
    isComplete: async () => false,
  }), /Backend disconnected/);
  assert.equal(calls, 1);
});
